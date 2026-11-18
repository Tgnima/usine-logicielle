// Le pilote : la boucle de contrôle des applications en production. Chaque minute, il lit la sonde
// du déployeur (sante.json, champ « applications ») et, pour une application de production en panne
// depuis assez longtemps, il décide par du code, jamais par un modèle :
//
//   attendre   une mise en ligne en cours, ou une panne trop récente : Docker relance seul un
//              conteneur qui s'arrête, et une mise en ligne ratée laisse tourner la version précédente ;
//   humain     une cause hors du code de l'application (serveur, mémoire, plusieurs applications à la
//              fois), une cause inconnue, un projet qui n'est pas « en production », un plafond
//              atteint, ou une rechute après une correction automatique : un message, une seule fois
//              par panne, et rien d'autre ;
//   corriger   une panne du code de l'application : une demande de corrections (livraison.mjs) avec ce
//              que voit la sonde. Le lot passe par la fabrique, le vérificateur et la recette, puis
//              s'arrête à l'aperçu. La mise en ligne pour de vrai reste à une personne (politique
//              mettre_en_production) : le pilote ne l'appelle jamais.
//
// Trois modes, réglés dans la console (Règles de l'usine) : coupé, observer (par défaut : il dit ce
// qu'il aurait fait, sans rien lancer) et corriger. Plafonds : une correction automatique par
// application et par 24 h, trois par 24 h pour toute l'usine (section pilote de usine.config.yml).
// Les budgets s'appliquent comme à toute tâche (budgets.mjs). Chaque décision est notée au journal
// (type « pilote ») : l'historique de la console, et un événement PostHog sans le texte.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { noter } from "./db.mjs"
import { ecrireReglage, lireReglage } from "./couts.mjs"
import { SONDE_PERIMEE_S, dernierEtatUsine, lireSanteServeur } from "./sante.mjs"

export const MODES_PILOTE = ["coupe", "observer", "corriger"]
export const LIBELLES_PILOTE = { coupe: "coupé", observer: "observer", corriger: "corriger jusqu'à l'aperçu" }
export const PAR_PILOTE = "l'usine (pilote)"
const MINUTE_MS = 60_000
export const JOUR_MS = 24 * 60 * MINUTE_MS
// Une application revenue depuis 30 min : sa panne est close.
export const RETABLI_MS = 30 * MINUTE_MS
// Une panne dans les 7 jours qui suivent une correction automatique de la même application : une personne.
export const RECHUTE_MS = 7 * JOUR_MS
// Les composants de l'usine dont la panne touche toutes les applications (noms de sante.mjs).
const COMPOSANTS_SERVEUR = ["disque", "mémoire", "caddy (HTTPS)", "déployeur"]
// Les états de projet où une correction est déjà en route : le pilote attend sans rien dire.
const EN_TRAVAIL = ["corrections", "fabrication", "reorientation", "creation", "analyse", "questions", "plan_a_valider"]

// Les réglages : le mode choisi dans la console, sinon celui du contrat, sinon « observer ».
export function reglagesPilote(config = {}, db = null) {
  const p = config.pilote ?? {}
  const entier = (v, defaut, min, max) => {
    if (v === undefined || v === null || v === "") return defaut
    const n = Math.round(Number(v))
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : defaut
  }
  const choisi = db ? lireReglage(db, "pilote_mode") : null
  const mode = MODES_PILOTE.includes(choisi) ? choisi : MODES_PILOTE.includes(p.mode) ? p.mode : "observer"
  return {
    mode,
    minutes: entier(p.minutes_avant_action, 10, 3, 240),
    parProduit: entier(p.corrections_par_produit_24h, 1, 0, 5),
    parJour: entier(p.corrections_par_jour, 3, 0, 20),
  }
}

// La cause d'une panne de production, lue sur ce que voit la sonde (jugerProduit, deployeur/sonde.mjs).
//   classe : attendre | serveur | code | inconnu ; pourquoi : une phrase pour une personne.
export function classerPanne(p, { usine = [], pannesProduction = 1 } = {}) {
  const raison = String(p?.raison ?? "")
  if (p?.deploiement === "en_cours" || /mise en ligne en cours|déploiement en cours/.test(raison)) return { classe: "attendre", pourquoi: "une mise en ligne est en cours" }
  const serveur = usine.find((c) => COMPOSANTS_SERVEUR.includes(c.nom) && c.etat === "panne")
  if (serveur) return { classe: "serveur", pourquoi: `le ${serveur.nom} de l'usine est en panne${serveur.detail ? ` (${serveur.detail})` : ""}` }
  if (pannesProduction >= 2) return { classe: "serveur", pourquoi: `${pannesProduction} applications en ligne sont en panne en même temps : la cause est sans doute commune (serveur, réseau)` }
  if (p?.docker?.oom || /mémoire dépassée/.test(raison)) return { classe: "serveur", pourquoi: "l'application a dépassé la mémoire qui lui est réservée" }
  if (/redémarre en boucle/.test(raison)) return { classe: "code", pourquoi: "l'application s'arrête à chaque démarrage" }
  const http = raison.match(/\/api\/health répond (\d{3})/)
  if (http) return { classe: "code", pourquoi: `l'application répond par une erreur (${http[1]})` }
  if (/ne répond pas à \/api\/health/.test(raison)) return { classe: "code", pourquoi: "l'application ne répond plus" }
  if (/^arrêté/.test(raison)) {
    const code = Number(p?.docker?.code_sortie)
    // 0 : arrêtée proprement ; 137 et 143 : arrêtée de l'extérieur (docker stop, kill). Aucun ne désigne le code.
    if (Number.isFinite(code) && ![0, 137, 143].includes(code)) return { classe: "code", pourquoi: `l'application s'est arrêtée sur une erreur (code ${code})` }
    return { classe: "inconnu", pourquoi: "l'application a été arrêtée sans erreur de sa part" }
  }
  return { classe: "inconnu", pourquoi: raison ? `cause non reconnue (${raison})` : "cause inconnue" }
}

// Ce que le pilote fait d'une panne qualifiée. type : corriger | observer | humain | rechute | deja.
export function choisirAction({ classe, pourquoi, projet, produit, version, corrections = [], reglages, maintenant = Date.now() }) {
  if (classe === "serveur") return { type: "humain", pourquoi: `la cause est hors de l'application : ${pourquoi}` }
  if (classe !== "code") return { type: "humain", pourquoi }
  if (!projet) return { type: "humain", pourquoi: "cette application n'a pas de projet dans l'usine" }
  if (EN_TRAVAIL.includes(projet.statut)) return { type: "deja", pourquoi: `le projet est déjà en travail (« ${projet.statut} »)` }
  if (projet.statut === "livre") return { type: "humain", pourquoi: "une nouvelle version attend sa mise en ligne : elle corrige peut-être déjà la panne" }
  if (projet.statut !== "en_production") return { type: "humain", pourquoi: `le projet est « ${projet.statut} » : le pilote n'y touche pas` }
  const recentes = corrections.filter((c) => c.produit === produit && maintenant - c.le < RECHUTE_MS)
  // Une correction automatique déjà mise en ligne (la version a changé depuis) n'a pas tenu : on ne réessaie pas.
  const rechute = recentes.find((c) => c.version !== (version ?? null))
  if (rechute) return { type: "rechute", pourquoi: `elle retombe en panne après la correction automatique du ${dateCourte(rechute.le)} : le pilote ne réessaie pas` }
  const duProduit = recentes.filter((c) => maintenant - c.le < JOUR_MS).length
  if (duProduit >= reglages.parProduit) return { type: "humain", pourquoi: `plafond atteint : ${duProduit} correction(s) automatique(s) de cette application en 24 h` }
  const toutes = corrections.filter((c) => maintenant - c.le < JOUR_MS).length
  if (toutes >= reglages.parJour) return { type: "humain", pourquoi: `plafond atteint : ${toutes} correction(s) automatique(s) en 24 h pour toute l'usine` }
  return { type: reglages.mode === "corriger" ? "corriger" : "observer", pourquoi }
}

// Un passage : les décisions à exécuter, et la mémoire à garder (jamais modifiée en place).
//   produits  sonde.produits (« production/<slug> » et « apercu/<slug> ») ;
//   usine     les composants de l'usine (dernier bilan de sante.mjs) ;
//   projets   { slug: { id, nom, statut } } ;
//   memoire   { incidents: { clé: … }, corrections: [{ produit, le, version }] }.
// Une décision par panne : elle est prise une fois la panne vieille de reglages.minutes, puis la
// panne reste ouverte sans autre message jusqu'à ce que l'application soit revenue depuis 30 min.
export function deciderPilote({ produits = {}, usine = [], projets = {}, memoire = {}, reglages, maintenant = Date.now() }) {
  const m = {
    incidents: Object.fromEntries(Object.entries(memoire.incidents ?? {}).map(([cle, i]) => [cle, { ...i }])),
    corrections: (memoire.corrections ?? []).filter((c) => maintenant - c.le < RECHUTE_MS),
  }
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
    // Une autre version en ligne pendant la panne : une autre situation, revue de zéro. C'est ainsi
    // qu'une correction mise en ligne qui ne tient pas devient une rechute.
    if (inc && (p.version ?? null) !== (inc.version ?? null)) {
      i.depuis = maintenant
      for (const k of ["decision", "decide_le", "classe", "deja"]) delete i[k]
    }
    delete i.ok_depuis
    Object.assign(i, { nom, raison: p.raison ?? null, version: p.version ?? null, vu_le: maintenant })
    if (i.decision || maintenant - i.depuis < reglages.minutes * MINUTE_MS) continue
    const { classe, pourquoi } = classerPanne(p, { usine, pannesProduction })
    if (classe === "attendre") continue
    const action = choisirAction({ classe, pourquoi, projet, produit, version: p.version ?? null, corrections: m.corrections, reglages, maintenant })
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

// La consigne donnée à l'analyste : ce que voit la sonde, rien de personnel (ni journal, ni donnée).
// Les journaux de production, eux, sont lus par demanderCorrections comme pour toute demande.
export function texteCorrection(d, maintenant = Date.now()) {
  const p = d.panne ?? {}
  const c = p.docker ?? {}
  const minutes = Math.max(1, Math.round((maintenant - d.depuis) / MINUTE_MS))
  const sante = p.http?.code ? `répond ${p.http.code}${p.http.ms ? ` en ${p.http.ms} ms` : ""}` : "pas de réponse"
  return [
    `Correction demandée par le pilote de l'usine, sans intervention humaine : ${d.nom} est en panne en production depuis ${minutes} min.`,
    "",
    "Ce que voit la sonde du serveur :",
    `- état : panne · ${p.raison ?? "raison inconnue"}`,
    `- version en ligne : ${p.version ?? "inconnue"}`,
    `- conteneur : ${c.etat ?? "inconnu"}, ${c.redemarrages_30_min ?? 0} redémarrage(s) en 30 min, code de sortie ${c.code_sortie ?? "inconnu"}${c.oom ? ", mémoire dépassée" : ""}`,
    `- /api/health : ${sante}`,
    "",
    `Ce que le pilote en conclut : ${d.pourquoi}.`,
    "",
    "Consigne :",
    "1. Trouve la cause dans les journaux de production avant de toucher au code.",
    "2. Écris d'abord un test qui reproduit le défaut (il échoue avant la correction, il passe après), puis corrige.",
    "3. Corrige seulement ce défaut : aucune nouvelle fonctionnalité, au plus 2 tâches.",
    "4. Si la cause n'est pas dans le code de l'application (serveur, réseau, service extérieur, réglage), dis-le dans le résumé du plan.",
    "La mise en ligne pour de vrai reste à une personne.",
  ].join("\n")
}

const majuscule = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1)
const dateCourte = (le) => new Date(le).toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
const depuisMin = (d, maintenant) => Math.max(1, Math.round((maintenant - d.depuis) / MINUTE_MS))
const BOUTON_SANTE = [{ texte: "Voir la santé", action: "sante_voir", valeur: "1" }]

export function lireMemoirePilote(db) {
  try {
    const m = JSON.parse(lireReglage(db, "pilote_memoire", "{}"))
    return { incidents: m.incidents && typeof m.incidents === "object" ? m.incidents : {}, corrections: Array.isArray(m.corrections) ? m.corrections : [] }
  } catch {
    return { incidents: {}, corrections: [] }
  }
}

// Exécute une décision : un message, une demande de corrections, et toujours une ligne de journal.
async function executer(ctx, d, memoire, maintenant) {
  const { db } = ctx
  const projetId = d.projet?.id ?? null
  const noterPilote = (message) => noter(db, { projet: projetId, type: "pilote", message })
  const alerter = (texte) => ctx.notifier.alerte(texte, BOUTON_SANTE).catch((e) => console.error("Pilote (message) :", e.message))
  const constat = d.type === "retabli" ? "" : `${d.nom} est en panne en production depuis ${depuisMin(d, maintenant)} min (${d.panne?.raison ?? "raison inconnue"})`
  if (d.type === "corriger") {
    // Compté tout de suite : la demande prend des minutes (l'analyste), le plafond vaut dès maintenant.
    memoire.corrections.push({ produit: d.produit, le: maintenant, version: d.panne?.version ?? null })
    noterPilote(`Correction automatique demandée : ${constat}. ${majuscule(d.pourquoi)}.`)
    ctx.livraison.demanderCorrections(ctx, projetId, texteCorrection(d, maintenant), PAR_PILOTE)
      .then((r) => {
        if (r?.ok !== false) return
        noterPilote(`Correction automatique refusée : ${r.message}`)
        return alerter(`:raising_hand: *Pilote* : ${constat}. La correction automatique n'a pas pu partir : ${r.message}. À toi de voir.`)
      })
      .catch((e) => noterPilote(`Correction automatique en erreur : ${e.message}`))
    return
  }
  if (d.type === "observer") {
    noterPilote(`Observation : il aurait demandé une correction. ${constat}. ${majuscule(d.pourquoi)}.`)
    return alerter(`:eyes: *Pilote (observation)* : ${constat}. En mode « corriger », il aurait demandé une correction : ${d.pourquoi}. Rien n'a été lancé.`)
  }
  if (d.type === "humain" || d.type === "rechute") {
    noterPilote(`${d.type === "rechute" ? "Rechute" : "Pas de correction automatique"} : ${constat}. ${majuscule(d.pourquoi)}.`)
    return alerter(`:raising_hand: *Pilote* : ${constat}. Il ne corrige pas : ${d.pourquoi}. À toi de voir.`)
  }
  if (d.type === "deja") return noterPilote(`En attente : ${constat}. ${majuscule(d.pourquoi)}.`)
  if (d.type === "retabli") {
    const apres = d.incident?.decision === "corriger"
    noterPilote(`${d.nom} fonctionne de nouveau en production depuis 30 min${apres ? ", après la correction automatique" : ""}.`)
    // Le retour d'une application est déjà annoncé par la santé ; le pilote ne parle que de sa correction.
    if (apres) return alerter(`:white_check_mark: *Pilote* : ${d.nom} fonctionne de nouveau en production depuis 30 min, après la correction automatique.`)
  }
}

// Un passage du pilote. Rien sans sonde récente (l'état réel est inconnu), ni quand l'usine est à
// l'arrêt (fichier STOP) : une correction ne serait pas fabriquée.
let passageEnCours = false
export async function passagePilote(ctx, { maintenant = Date.now() } = {}) {
  if (passageEnCours) return null
  passageEnCours = true
  try {
    const { config, db } = ctx
    const reglages = reglagesPilote(config, db)
    if (reglages.mode === "coupe" || existsSync(join(config.dataDir, "STOP"))) return null
    const sonde = lireSanteServeur(config)?.applications
    if (!sonde?.produits || !(maintenant - new Date(sonde.le).getTime() <= SONDE_PERIMEE_S * 1000)) return null
    const projets = Object.fromEntries(db.prepare("SELECT id, slug, nom, statut FROM projets WHERE slug IS NOT NULL ORDER BY id").all().map((p) => [p.slug, p]))
    const r = deciderPilote({ produits: sonde.produits, usine: dernierEtatUsine()?.composants ?? [], projets, memoire: lireMemoirePilote(db), reglages, maintenant })
    for (const d of r.decisions) await executer(ctx, d, r.memoire, maintenant).catch((e) => console.error("Pilote :", e.message))
    ecrireReglage(db, "pilote_memoire", JSON.stringify(r.memoire))
    return r
  } finally {
    passageEnCours = false
  }
}

export function demarrerPilote(ctx) {
  const passage = () => passagePilote(ctx).catch((e) => console.error("Pilote :", e.message))
  // Après le premier bilan de santé (20 s) : les composants de l'usine sont connus.
  setTimeout(passage, 2 * MINUTE_MS)
  setInterval(passage, MINUTE_MS)
}

// Pour la console : le mode, les plafonds, les pannes ouvertes et les dernières décisions.
export function etatPilote(ctx, maintenant = Date.now()) {
  const r = reglagesPilote(ctx.config, ctx.db)
  const m = lireMemoirePilote(ctx.db)
  const journal = ctx.db.prepare("SELECT le, message FROM journal WHERE type = 'pilote' ORDER BY id DESC LIMIT 8").all()
  return {
    mode: r.mode,
    minutes: r.minutes,
    par_produit: r.parProduit,
    par_jour: r.parJour,
    corrections_24h: m.corrections.filter((c) => maintenant - c.le < JOUR_MS).length,
    pannes: Object.values(m.incidents).map((i) => ({ nom: i.nom ?? i.produit, depuis: new Date(i.depuis).toISOString(), decision: i.decision ?? null })),
    journal: journal.map((j) => ({ le: j.le, message: j.message.slice(0, 400) })),
  }
}

// Le mode, choisi dans la console. Une panne vue en observation est revue au passage suivant : passer
// en « corriger » pendant une panne la fait corriger.
export function reglerPilote(ctx, mode, par) {
  ecrireReglage(ctx.db, "pilote_mode", mode)
  const m = lireMemoirePilote(ctx.db)
  for (const i of Object.values(m.incidents)) if (i.decision === "observer") delete i.decision
  ecrireReglage(ctx.db, "pilote_memoire", JSON.stringify(m))
  noter(ctx.db, { projet: null, type: "reglage", message: `Pilote des pannes : ${LIBELLES_PILOTE[mode]} (par ${par})` })
  const messages = {
    coupe: "Pilote coupé : l'usine te prévient des pannes, sans rien faire d'autre.",
    observer: "Pilote en observation : pour chaque panne, il te dira ce qu'il aurait fait.",
    corriger: "Pilote actif : il corrige les pannes du code jusqu'à l'aperçu. La mise en ligne reste à toi.",
  }
  return { ok: true, message: messages[mode] }
}
