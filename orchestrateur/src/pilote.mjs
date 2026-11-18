// Le pilote : la boucle de contrôle des applications en production. Chaque minute, il lit la sonde
// du déployeur (sante.json, champ « applications ») et, pour une application de production en panne
// depuis assez longtemps, il décide par du code, jamais par un modèle :
//
//   attendre   une mise en ligne en cours, ou une panne trop récente : Docker relance seul un
//              conteneur qui s'arrête, et une mise en ligne ratée laisse tourner la version précédente ;
//   humain     une cause hors du code de l'application (serveur, mémoire, plusieurs applications à la
//              fois), une cause inconnue, un projet qui n'est pas « en production » : un message, une
//              seule fois par panne, et rien d'autre ;
//   proposer   une panne du code de l'application : un signal pour la boucle d'amélioration
//              (propositions.mjs), qui en fait une proposition de correction. Une personne la lance ou
//              l'écarte : le pilote ne lance jamais rien. Une panne qui revient après une correction
//              mise en ligne est une rechute, que la proposition dit.
//
// Le pilote ne reçoit qu'une fonction, `proposer` (propositions.mjs, donnée par index.mjs) : il n'a
// aucun moyen de demander une correction, ni de mettre une application en ligne.
//
// Trois modes, réglés dans la console (Règles de l'usine), communs au pilote et à la lecture de
// Sentry : coupé, observer (par défaut : il dit ce qu'il aurait proposé, sans rien créer) et
// proposer. Chaque décision est notée au journal (type « pilote ») : l'historique de la console, et
// un événement PostHog sans le texte.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { noter } from "./db.mjs"
import { ecrireReglage, lireReglage } from "./couts.mjs"
import { SONDE_PERIMEE_S, dernierEtatUsine, lireSanteServeur } from "./sante.mjs"

export const MODES_PILOTE = ["coupe", "observer", "proposer"]
export const LIBELLES_PILOTE = { coupe: "coupé", observer: "observer", proposer: "proposer une correction" }
const MINUTE_MS = 60_000
export const JOUR_MS = 24 * 60 * MINUTE_MS
// Une application revenue depuis 30 min : sa panne est close.
export const RETABLI_MS = 30 * MINUTE_MS
const MESSAGE_MAX = 300
// Les composants de l'usine dont la panne touche toutes les applications (noms de sante.mjs).
const COMPOSANTS_SERVEUR = ["disque", "mémoire", "caddy (HTTPS)", "déployeur"]
// Les états de projet où un travail est déjà en route : le pilote attend, et le dit une fois.
const EN_TRAVAIL = ["corrections", "fabrication", "reorientation", "creation", "analyse", "questions", "plan_a_valider"]

// Les réglages : le mode choisi dans la console, sinon celui du contrat, sinon « observer ». L'ancien
// mode « corriger » (qui lançait seul une correction) devient « proposer » : rien ne part sans une personne.
export function reglagesPilote(config = {}, db = null) {
  const p = config.pilote ?? {}
  const entier = (v, defaut, min, max) => {
    if (v === undefined || v === null || v === "") return defaut
    const n = Math.round(Number(v))
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaut
  }
  const connu = (m) => (m === "corriger" ? "proposer" : MODES_PILOTE.includes(m) ? m : null)
  const choisi = db ? connu(lireReglage(db, "pilote_mode")) : null
  return { mode: choisi ?? connu(p.mode) ?? "observer", minutes: entier(p.minutes_avant_action, 10, 3, 240) }
}

// La cause d'une panne de production, lue sur ce que voit la sonde (jugerProduit, deployeur/sonde.mjs).
//   classe : attendre | serveur | code | inconnu ; pourquoi : une phrase simple, pour une personne.
export function classerPanne(p, { usine = [], pannesProduction = 1 } = {}) {
  const raison = String(p?.raison ?? "")
  if (p?.deploiement === "en_cours" || /déploiement en cours/.test(raison)) return { classe: "attendre", pourquoi: "une mise en ligne est en cours" }
  const serveur = usine.find((c) => COMPOSANTS_SERVEUR.includes(c.nom) && c.etat === "panne")
  if (serveur) return { classe: "serveur", pourquoi: `le serveur de l'usine a un problème (${serveur.nom})` }
  if (pannesProduction >= 2) return { classe: "serveur", pourquoi: `${pannesProduction} applications en ligne sont en panne en même temps : la cause est sans doute commune (serveur, réseau)` }
  if (p?.docker?.oom || /mémoire dépassée/.test(raison)) return { classe: "serveur", pourquoi: "l'application manque de mémoire" }
  if (/redémarre en boucle/.test(raison)) return { classe: "code", pourquoi: "l'application s'arrête à chaque démarrage" }
  if (/\/api\/health répond \d{3}/.test(raison)) return { classe: "code", pourquoi: "l'application répond par une erreur" }
  if (/ne répond pas à \/api\/health/.test(raison)) return { classe: "code", pourquoi: "l'application ne répond plus" }
  if (/^arrêté/.test(raison)) {
    const code = Number(p?.docker?.code_sortie)
    // 0 : arrêtée proprement ; 137 et 143 : arrêtée de l'extérieur (docker stop, kill). Aucun ne désigne le code.
    if (Number.isFinite(code) && ![0, 137, 143].includes(code)) return { classe: "code", pourquoi: "l'application s'est arrêtée sur une erreur" }
    return { classe: "inconnu", pourquoi: "l'application a été arrêtée, sans erreur de sa part" }
  }
  return { classe: "inconnu", pourquoi: "la cause n'est pas reconnue" }
}

// Ce que le pilote fait d'une panne qualifiée. type : proposer | observer | humain | deja.
export function choisirAction({ classe, pourquoi, projet, reglages }) {
  if (classe === "serveur") return { type: "humain", pourquoi: `la cause est hors de l'application : ${pourquoi}` }
  if (classe !== "code") return { type: "humain", pourquoi }
  if (!projet) return { type: "humain", pourquoi: "cette application n'a pas de projet dans l'usine" }
  if (EN_TRAVAIL.includes(projet.statut)) return { type: "deja", pourquoi: "une correction ou une fabrication est déjà en cours" }
  if (projet.statut === "mise_en_production") return { type: "deja", pourquoi: "une mise en ligne est en cours" }
  if (projet.statut === "livre") return { type: "humain", pourquoi: "une nouvelle version attend sa mise en ligne : elle corrige peut-être déjà la panne" }
  if (projet.statut !== "en_production") return { type: "humain", pourquoi: "le projet est arrêté ou bloqué : l'usine n'y touche pas" }
  return { type: reglages.mode === "proposer" ? "proposer" : "observer", pourquoi }
}

// Un passage : les décisions à exécuter, et la mémoire à garder (jamais modifiée en place).
//   produits  sonde.produits (« production/<slug> » et « apercu/<slug> ») ;
//   usine     les composants de l'usine (dernier bilan de sante.mjs) ;
//   projets   { slug: { id, nom, statut } } ;
//   memoire   { incidents: { clé: … } }.
// Une décision par panne : elle est prise une fois la panne vieille de reglages.minutes, puis la
// panne reste ouverte sans autre message jusqu'à ce que l'application soit revenue depuis 30 min.
export function deciderPilote({ produits = {}, usine = [], projets = {}, memoire = {}, reglages, maintenant = Date.now() }) {
  const m = { incidents: Object.fromEntries(Object.entries(memoire.incidents ?? {}).map(([cle, i]) => [cle, { ...i }])) }
  const decisions = []
  if (reglages.mode === "coupe") return { decisions, memoire: m }
  const production = Object.entries(produits).filter(([cle]) => cle.startsWith("production/"))
  const pannesProduction = production.filter(([, p]) => p?.etat === "panne").length
  for (const [cle, p] of production) {
    const produit = cle.slice("production/".length)
    const projet = projets[produit] ?? null
    const nom = projet?.nom || produit
    const inc = m.incidents[cle]
    if (p?.etat !== "panne") {
      if (!inc) continue
      inc.vu_le = maintenant
      // Seul « ok » compte pour clore ; une alerte ou un état inconnu (mise en ligne) laisse la panne ouverte.
      if (p?.etat === "ok") {
        inc.ok_depuis ??= maintenant
        if (maintenant - inc.ok_depuis >= RETABLI_MS) {
          delete m.incidents[cle]
          if (inc.decision) decisions.push({ type: "retabli", cle, produit, nom, projet, incident: inc })
        }
      }
      continue
    }
    const i = inc ?? (m.incidents[cle] = { depuis: maintenant, produit })
    // Une autre version en ligne pendant la panne : une autre situation, revue de zéro (une
    // correction mise en ligne qui ne tient pas devient ainsi une rechute, que la proposition dit).
    if (inc && (p.version ?? null) !== (inc.version ?? null)) {
      i.depuis = maintenant
      for (const k of ["decision", "decide_le", "classe", "deja"]) delete i[k]
    }
    delete i.ok_depuis
    Object.assign(i, { nom, raison: p.raison ?? null, version: p.version ?? null, vu_le: maintenant })
    if (i.decision || maintenant - i.depuis < reglages.minutes * MINUTE_MS) continue
    const { classe, pourquoi } = classerPanne(p, { usine, pannesProduction })
    if (classe === "attendre") continue
    const action = choisirAction({ classe, pourquoi, projet, reglages })
    const decision = { ...action, classe, cle, produit, nom, projet, panne: p, depuis: i.depuis }
    // Un projet déjà en travail : noté une fois, puis revu à chaque passage (il redeviendra « en production »).
    if (action.type === "deja") {
      if (!i.deja) decisions.push(decision)
      i.deja = true
      continue
    }
    Object.assign(i, { decision: action.type, decide_le: maintenant, classe })
    decisions.push(decision)
  }
  // Une application que la sonde ne mesure plus (retirée) : sa panne est oubliée au bout de 30 min.
  for (const [cle, i] of Object.entries(m.incidents)) if (!produits[cle] && maintenant - (i.vu_le ?? i.depuis) >= RETABLI_MS) delete m.incidents[cle]
  return { decisions, memoire: m }
}

const court = (s) => String(s ?? "").slice(0, MESSAGE_MAX)
const depuisMin = (d, maintenant) => Math.max(1, Math.round((maintenant - d.depuis) / MINUTE_MS))

// Le signal d'une panne pour la boucle d'amélioration : ce que voit la sonde, rien de personnel (ni
// journal, ni donnée). Les journaux de production, eux, sont lus par l'analyste quand une personne
// lance la correction. Une seule clé par application : une panne qui revient après une
// correction est reconnue comme une rechute.
export function signalPanne(d, maintenant = Date.now()) {
  const p = d.panne ?? {}
  const c = p.docker ?? {}
  return {
    source: "sonde",
    produit: d.produit,
    cle: `panne:${d.produit}`,
    le: new Date(maintenant).toISOString(),
    titre: `en panne depuis ${depuisMin(d, maintenant)} min, ${d.pourquoi}`,
    detail: {
      raison: p.raison ?? "raison inconnue",
      ...(p.version ? { version: String(p.version) } : {}),
      ...(c.etat ? { conteneur: String(c.etat) } : {}),
      ...(Number.isFinite(c.redemarrages_30_min) ? { redemarrages_30_min: c.redemarrages_30_min } : {}),
      ...(Number.isFinite(Number(c.code_sortie)) && c.code_sortie !== null ? { code_sortie: Number(c.code_sortie) } : {}),
      ...(c.oom ? { oom: true } : {}),
      ...(Number.isFinite(p.http?.code) ? { http_code: p.http.code } : {}),
    },
  }
}

const majuscule = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1)
const BOUTON_SANTE = [{ texte: "Voir la santé", action: "sante_voir", valeur: "1" }]
// Un nombre de millisecondes que Date accepte (au-delà, toISOString lève une erreur).
const nombre = (x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) < 8.64e15

// La mémoire, validée ligne à ligne. Illisible : les pannes sont oubliées (elles seront revues).
export function lireMemoirePilote(db) {
  const brut = lireReglage(db, "pilote_memoire")
  let m = null
  try {
    m = brut ? JSON.parse(brut) : { incidents: {} }
  } catch {}
  if (!m || typeof m !== "object" || typeof m.incidents !== "object" || m.incidents === null) return { incidents: {}, illisible: true }
  return { incidents: Object.fromEntries(Object.entries(m.incidents).filter(([cle, i]) => /^production\/[^/]+$/.test(cle) && i && nombre(i.depuis))) }
}

// Exécute une décision déjà enregistrée : un message ou une proposition, et toujours une ligne de
// journal. Les textes pour une personne disent « l'usine » et « en ligne » ; le détail de la sonde ne
// part que dans Slack et dans la proposition.
async function executer(ctx, d, maintenant, proposer) {
  const { db } = ctx
  const projetId = d.projet?.id ?? null
  const noterPilote = (message) => noter(db, { projet: projetId, type: "pilote", message })
  const alerter = (texte) => ctx.notifier.alerte(texte, BOUTON_SANTE).catch((e) => console.error("Pilote (message) :", e.message))
  const constat = d.type === "retabli" ? "" : `${d.nom} est en panne en ligne depuis ${depuisMin(d, maintenant)} min`
  const detail = d.panne?.raison ? `\nDétail : ${court(d.panne.raison)}` : ""
  if (d.type === "proposer") {
    if (typeof proposer !== "function") return noterPilote("Aucune proposition possible : la boucle d'amélioration n'est pas branchée.")
    // La proposition annonce elle-même ce qu'elle contient (Slack, file d'attention).
    const r = await proposer(ctx, signalPanne(d, maintenant), { maintenant }).catch((e) => ({ action: "erreur", pourquoi: e.message }))
    if (r.action === "creer" || r.action === "ajouter") return noterPilote(`Correction proposée : ${constat}. ${majuscule(d.pourquoi)}. Elle attend une décision (proposition n° ${r.id}).`)
    if (r.action === "ignorer") return noterPilote(`Pas de nouvelle proposition : ${constat}. ${majuscule(court(r.pourquoi))}.`)
    noterPilote(`Proposition impossible : ${court(r.pourquoi)}`)
    return alerter(`:raising_hand: *Pannes* : ${constat}. L'usine n'a pas pu en faire une proposition : ${court(r.pourquoi)}. À toi de voir.${detail}`)
  }
  if (d.type === "observer") {
    noterPilote(`Observation : l'usine aurait proposé une correction. ${constat}. ${majuscule(d.pourquoi)}.`)
    return alerter(`:eyes: *Pannes (observation)* : ${constat}. En mode « proposer », l'usine t'aurait proposé une correction : ${d.pourquoi}. Rien n'a été créé.${detail}`)
  }
  if (d.type === "humain") {
    noterPilote(`Pas de proposition : ${constat}. ${majuscule(d.pourquoi)}.`)
    return alerter(`:raising_hand: *Pannes* : ${constat}. L'usine ne propose pas de correction : ${d.pourquoi}. À toi de voir.${detail}`)
  }
  if (d.type === "deja") return noterPilote(`En attente : ${constat}. ${majuscule(d.pourquoi)}.`)
  // Le retour d'une application est déjà annoncé par la santé ; ici, seulement le journal.
  if (d.type === "retabli") return noterPilote(`${d.nom} fonctionne de nouveau en ligne depuis 30 min${d.incident?.decision === "proposer" ? " : la proposition de correction reste à décider" : ""}.`)
}

// La sonde des produits, si elle est récente ; sinon null (l'état réel est inconnu).
function sondeRecente(config, maintenant) {
  const sonde = lireSanteServeur(config)?.applications
  return sonde?.produits && maintenant - new Date(sonde.le).getTime() <= SONDE_PERIMEE_S * 1000 ? sonde : null
}

// Un passage du pilote. Rien sans sonde récente, ni quand l'usine est à l'arrêt (fichier STOP). De la
// lecture de la mémoire à son écriture, rien n'est attendu : un réglage changé dans la console ne
// peut pas être écrasé.
//   proposer : la seule action possible (propositions.mjs), donnée par demarrerPilote.
let passageEnCours = false
export async function passagePilote(ctx, { maintenant = Date.now(), proposer = null } = {}) {
  if (passageEnCours) return null
  passageEnCours = true
  try {
    const { config, db } = ctx
    const reglages = reglagesPilote(config, db)
    if (reglages.mode === "coupe" || existsSync(join(config.dataDir, "STOP"))) return null
    const sonde = sondeRecente(config, maintenant)
    if (!sonde) return null
    const projets = Object.fromEntries(db.prepare("SELECT id, slug, nom, statut FROM projets WHERE slug IS NOT NULL ORDER BY id").all().map((p) => [p.slug, p]))
    const memoire = lireMemoirePilote(db)
    if (memoire.illisible) noter(db, { projet: null, type: "pilote", message: "Mémoire des pannes illisible : repartie de zéro." })
    const r = deciderPilote({ produits: sonde.produits, usine: dernierEtatUsine()?.composants ?? [], projets, memoire, reglages, maintenant })
    ecrireReglage(db, "pilote_memoire", JSON.stringify(r.memoire))
    for (const d of r.decisions) await executer(ctx, d, maintenant, proposer).catch((e) => console.error("Pilote :", e.message))
    return r
  } finally {
    passageEnCours = false
  }
}

export function demarrerPilote(ctx, { proposer }) {
  const passage = () => passagePilote(ctx, { proposer }).catch((e) => console.error("Pilote :", e.message))
  // Après le premier bilan de santé (20 s) : les composants de l'usine sont connus.
  setTimeout(passage, 2 * MINUTE_MS)
  setInterval(passage, MINUTE_MS)
}

// Pour la console : le mode, les pannes ouvertes et les dernières décisions (pannes et propositions).
// Coupé, ou sans sonde récente, le pilote ne suit aucune panne : il n'en montre pas.
export function etatPilote(ctx, maintenant = Date.now()) {
  const r = reglagesPilote(ctx.config, ctx.db)
  const m = lireMemoirePilote(ctx.db)
  const suivies = r.mode !== "coupe" && sondeRecente(ctx.config, maintenant) ? Object.values(m.incidents) : []
  const journal = ctx.db.prepare("SELECT le, message FROM journal WHERE type IN ('pilote', 'proposition') ORDER BY id DESC LIMIT 8").all()
  return {
    mode: r.mode,
    minutes: r.minutes,
    pannes: suivies.map((i) => ({ nom: String(i.nom ?? i.produit ?? "?"), depuis: new Date(i.depuis).toISOString(), decision: i.decision ?? null })),
    journal: journal.map((j) => ({ le: j.le, message: j.message.slice(0, 400) })),
  }
}

// Le mode, choisi dans la console. Une panne vue en observation est revue au passage suivant : passer
// en « proposer » pendant une panne en fait une proposition. Coupé, le pilote oublie les pannes en
// cours (il les reverra s'il repart) ; les propositions, elles, restent.
export function reglerPilote(ctx, mode, par) {
  ecrireReglage(ctx.db, "pilote_mode", mode)
  const m = lireMemoirePilote(ctx.db)
  if (mode === "coupe") m.incidents = {}
  for (const i of Object.values(m.incidents)) if (i.decision === "observer") delete i.decision
  ecrireReglage(ctx.db, "pilote_memoire", JSON.stringify({ incidents: m.incidents }))
  noter(ctx.db, { projet: null, type: "reglage", message: `Pannes et erreurs des applications en ligne : ${LIBELLES_PILOTE[mode]} (par ${par})` })
  const messages = {
    coupe: "L'usine te prévient des pannes, sans rien proposer.",
    observer: "Pour chaque panne ou nouvelle erreur, l'usine te dira ce qu'elle aurait proposé.",
    proposer: "Pour chaque panne du code ou nouvelle erreur, l'usine te proposera une correction. Rien ne part sans toi.",
  }
  return { ok: true, message: messages[mode] }
}
