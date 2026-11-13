// La page « Visibilité » de la console : ce qui attend une personne, l'état réel de chaque
// produit, ce que fait l'usine en ce moment, et le bilan des 7 derniers jours.
//
// Sources, toutes en lecture seule :
//   - la base : escalades, tâches, journal (fusion, refus, escalade), consommations ;
//   - /app/etat/sante.json, écrit par le déployeur : serveur et sonde des produits (champ
//     « applications », deployeur/sonde.mjs) ;
//   - /app/etat/statut.json, écrit par le déployeur : le dernier déploiement de chaque produit ;
//   - le contrat et les réglages : quel modèle fait quel travail (modeles, relais, limites d'usage).
// Rien ici n'écrit dans la base, ne touche à Docker ou n'appelle un service extérieur.
import { readFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { join } from "node:path"
import { adresses } from "./config.mjs"
import { lireReglage, montant, reglagesCouts, versDevise } from "./couts.mjs"
import { limitesEnCours, MODES, modeleJuge, MOTEURS_RELAIS, nomMode, relais } from "./moteurs.mjs"
import { lireSanteServeur, SONDE_PERIMEE_S } from "./sante.mjs"

// Les jours du bilan se comptent à l'heure de Paris : un refus à 00 h 30 le 9 novembre (heure
// de Paris) compte le 9, même s'il est noté le 8 à 23 h 30 en temps universel.
export const FUSEAU = "Europe/Paris"
export const JOURS = 7
// Au-delà, un déploiement « en cours » est bloqué (même seuil que DEPLOIEMENT_BLOQUE_MS dans deployeur/sonde.mjs).
const DEPLOIEMENT_BLOQUE_MS = 45 * 60_000
// Les seuils du serveur, ceux de sante.mjs (disque, mémoire) ; la charge alerte au double des processeurs.
const DISQUE = { alerte: 80, panne: 90 }
const MEMOIRE_MO = { alerte: 400, panne: 200 }
const CHARGE_ALERTE = 2
// Une cause de refus tient sur une ligne ; une raison ou un message, sur quelques lignes.
const CAUSE_MAX = 60
const TEXTE_MAX = 300
// Une version se montre par les 7 premiers caractères de son sha.
const SHA_COURT = 7
// Les longueurs des noms venus de la base ou du contrat.
const MODELE_MAX = 60
const ROLE_MAX = 40
const MOTEUR_MAX = 20
const TITRE_MAX = 120
const CLE_MAX = 20
// Le modèle du renfort quand le contrat n'en donne pas (le même défaut que fabrique.mjs, construction).
const MODELE_RENFORT_DEFAUT = "claude-opus-5-5"
const ETATS = ["ok", "alerte", "panne", "inconnu"]

// Une mesure lue dans un fichier écrit par un autre conteneur : un nombre, ou null.
const nb = (x) => (x !== null && x !== "" && Number.isFinite(Number(x)) ? Number(x) : null)
const texte = (x, max = TEXTE_MAX) => (x === null || x === undefined ? "" : String(x).slice(0, max))
const court = (sha) => (typeof sha === "string" && sha ? sha.slice(0, SHA_COURT) : null)

const JOUR = new Intl.DateTimeFormat("en-CA", { timeZone: FUSEAU, year: "numeric", month: "2-digit", day: "2-digit" })

// Une date de SQLite (« 2026-11-09 02:25:08 », en temps universel) ou ISO, en Date.
export function dateDe(le) {
  const t = String(le ?? "")
  if (!t) return new Date(NaN)
  return new Date(t.replace(" ", "T") + (/[zZ]$|[+-]\d\d:?\d\d$/.test(t) ? "" : "Z"))
}
// Une date en ISO (avec Z), ou null si elle est illisible.
export const iso = (le) => {
  const d = dateDe(le)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// Le jour (AAAA-MM-JJ) d'un instant, à l'heure de Paris.
export const jourParis = (d) => JOUR.format(d)

// Les JOURS derniers jours de Paris, du plus ancien à aujourd'hui. Calcul sur le calendrier, pas
// en retirant 24 h : le jour du passage à l'heure d'été ne disparaît pas.
export function joursFenetre(maintenant, n = JOURS) {
  const [a, m, j] = jourParis(new Date(maintenant)).split("-").map(Number)
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(a, m - 1, j - (n - 1 - i))).toISOString().slice(0, 10))
}

// Les motifs techniques de verification.mjs, dits pour tout le monde. « design », « critère non
// validé » et « problème » restent tels quels : ce sont les mots de la maquette.
const CAUSES_EN_CLAIR = [
  [/\bbuild\b|ne se construit/i, "le code ne se construit pas"],
  [/test\(s\) échouent|tests? échoue/i, "des tests échouent"],
  [/^aucun test/i, "aucun test ne passe"],
  [/^le nombre de tests a baissé/i, "des tests ont disparu"],
  [/^régression/i, "une fonction déjà validée ne marche plus"],
  [/^l'application ne démarre pas/i, "l'application ne démarre pas"],
  [/^au démarrage, l'application écrit/i, "l'application écrit dans son propre code"],
  [/^un secret/i, "un secret écrit dans le code"],
  [/faille/i, "une faille de sécurité dans un composant"],
  [/^le vérificateur/i, "le contrôle n'a pas pu conclure"],
]

// La cause d'un refus : le premier segment du motif, après « motif(s)) : » (fabrique.mjs). Par
// exemple « design », « critère non validé », « problème ». Un nombre ne sépare pas deux causes
// (« 2 test(s) échouent » et « 3 test(s) échouent » vont ensemble).
export function causeDuRefus(message) {
  const reste = String(message ?? "").split("motif(s)) : ")[1]
  if (!reste) return "autre"
  // Les accents graves viennent du texte pour Slack (« `npm test` échoue ») : sans eux, une même cause se regroupe.
  const segment = reste.split(/\s*:(?:\s|$)|\n/)[0].replace(/`/g, "").replace(/\s*\([^()]*\)\s*$/, "").replace(/\d+/g, "N").trim()
  if (!segment) return "autre"
  const clair = CAUSES_EN_CLAIR.find(([motif]) => motif.test(segment))?.[1]
  if (clair) return clair
  return segment.length > CAUSE_MAX ? `${segment.slice(0, CAUSE_MAX - 1).trimEnd()}…` : segment
}

// Les raisons de la sonde (deployeur/sonde.mjs) et les messages du déployeur, avec les mots de
// l'usine : une « mise en ligne », une « application », pas un déploiement ni un conteneur.
const RAISONS_EN_CLAIR = [
  [/redémarre en boucle \((\d+) redémarrage\(s\) en 30 min, (\d+) au total\)/g, "redémarre sans arrêt ($1 fois en 30 min, $2 au total)"],
  [/dernier déploiement en échec/g, "la dernière mise en ligne a échoué"],
  [/déploiement bloqué/g, "mise en ligne bloquée"],
  [/déploiement en cours/g, "mise en ligne en cours"],
  [/aucun conteneur/g, "rien ne tourne"],
  [/le conteneur tourne mais n'est pas servi/g, "l'application tourne mais n'est pas accessible"],
  [/conteneur absent/g, "l'application n'est pas lancée"],
  [/ne répond pas à \/api\/health/g, "ne répond pas"],
  [/\/api\/health répond (\d+)/g, "répond par une erreur ($1)"],
  [/\/api\/health redirige \((\d+)\)/g, "renvoie vers une autre adresse ($1)"],
  [/\/api\/health en (\d+) ms/g, "répond en $1 ms"],
  [/Docker le dit en mauvaise santé/g, "se signale en mauvaise santé"],
  [/arrêté \([a-z]+, code de sortie (\d+)(, mémoire dépassée)?\)/g, (_, code, memoire) => `arrêté${memoire ? " : mémoire dépassée" : ""} (code ${code})`],
]
export const enClair = (t) => RAISONS_EN_CLAIR.reduce((s, [motif, par]) => s.replace(motif, par), String(t ?? ""))

function lireStatut(config) {
  try {
    const s = JSON.parse(readFileSync(join(config.etatDir, "statut.json"), "utf8"))
    return s && typeof s === "object" && !Array.isArray(s) ? s : {}
  } catch {
    return {}
  }
}

// Les projets connus par leur slug (le nom des produits dans sante.json et statut.json). Une Map :
// un slug comme « constructor » ne doit rien trouver dans le prototype d'un objet.
function projetsParSlug(db) {
  return new Map(db.prepare("SELECT id, nom, slug FROM projets WHERE slug IS NOT NULL AND statut != 'supprime'").all().map((p) => [p.slug, { id: p.id, nom: p.nom || p.slug }]))
}

// Le plus grave d'abord ; avec une sonde trop ancienne (tout « inconnu »), la dernière mesure départage.
const GRAVITE = { panne: 0, alerte: 1, inconnu: 2, ok: 3 }
const gravite = (e) => GRAVITE[e] ?? 2
const parGravite = (a, b) => gravite(a.etat) - gravite(b.etat) || gravite(a.etat_mesure) - gravite(b.etat_mesure) || a.nom.localeCompare(b.nom, "fr")

// --- Les produits, d'après la sonde -------------------------------------------------------
// Une carte par produit et par environnement. Une sonde trop ancienne ne dit plus rien de
// l'état présent : chaque carte passe en « inconnu », la dernière mesure reste visible.
function parcProduits(sante, produits, config, maintenant) {
  const a = sante?.applications && typeof sante.applications === "object" ? sante.applications : null
  const age = a?.le ? Math.round((maintenant - dateDe(a.le).getTime()) / 1000) : NaN
  const produitsSonde = a?.produits && typeof a.produits === "object" ? a.produits : null
  const sonde = {
    le: iso(a?.le),
    age_s: Number.isFinite(age) ? age : null,
    // absente : déployeur plus ancien, ou aucun bilan ; muette : Docker n'a pas répondu ; perimee : plus de
    // mesure récente, ou une date illisible (on ne présente jamais comme actuel ce qu'on ne peut pas dater).
    absente: !a,
    muette: Boolean(a) && !produitsSonde,
    perimee: Boolean(produitsSonde) && (!Number.isFinite(age) || age > SONDE_PERIMEE_S),
  }
  const lignes = Object.entries(produitsSonde ?? {}).flatMap(([cle, p]) => {
    const m = /^(apercu|production)\/([a-z0-9-]+)$/.exec(cle)
    if (!m || !p || typeof p !== "object") return []
    const [, environnement, slug] = m
    const projet = produits.get(slug) ?? null
    const d = p.docker && typeof p.docker === "object" ? p.docker : null
    const demarre = d?.demarre_le ? dateDe(d.demarre_le).getTime() : NaN
    const mesure = ETATS.includes(p.etat) ? p.etat : "inconnu"
    return [{
      cle,
      environnement,
      slug,
      projet_id: projet?.id ?? null,
      nom: projet?.nom ?? slug,
      etat: sonde.perimee ? "inconnu" : mesure,
      etat_mesure: mesure,
      raison: enClair(texte(p.raison)),
      version: court(p.version),
      demarre_le: iso(d?.demarre_le),
      age_s: Number.isFinite(demarre) ? Math.max(0, Math.round((maintenant - demarre) / 1000)) : null,
      redemarrages: nb(d?.redemarrages),
      redemarrages_30_min: nb(d?.redemarrages_30_min),
      reponse_ms: nb(p.http?.code) ? nb(p.http?.ms) : null,
      adresse: projet ? adresses(config, slug)[environnement] : null,
    }]
  })
  return {
    sonde,
    productions: lignes.filter((x) => x.environnement === "production").sort(parGravite),
    apercus: lignes.filter((x) => x.environnement === "apercu").sort(parGravite),
  }
}

// --- Ce qui t'attend -------------------------------------------------------------------
// Les décisions, plans, questions et livraisons (aTraiter de console.mjs), et les produits en
// panne ou en alerte. Une décision passe d'abord, puis ce qui est cassé, puis le reste.
const ORDRE_ATTENTE = { decision: 0, panne: 1, alerte: 2, sonde: 3, plan: 4, questions: 5, livre: 6 }
function ceQuiAttend(aTraiter, parc) {
  const liste = aTraiter.map((x) => ({ ...x, depuis: iso(x.depuis), lien: `#/projets/${x.projet}` }))
  const { sonde } = parc
  if (sonde.muette) liste.push({ type: "sonde", projet: null, titre: "L'état des produits est inconnu", detail: "le serveur n'a pas pu lire l'état des applications à la dernière vérification", depuis: sonde.le, lien: "#/reglages/etat" })
  else if (sonde.perimee) liste.push({ type: "sonde", projet: null, titre: "Les produits ne sont plus vérifiés", detail: "la dernière vérification des applications est trop ancienne : leur état réel est inconnu", depuis: sonde.le, lien: "#/reglages/etat" })
  else {
    for (const x of [...parc.productions, ...parc.apercus]) {
      if (x.etat !== "panne" && x.etat !== "alerte") continue
      const ou = x.environnement === "apercu" ? "aperçu" : "production"
      liste.push({ type: x.etat, projet: x.projet_id, titre: `${x.nom} · ${ou} ${x.etat === "panne" ? "en panne" : "à surveiller"}`, detail: x.raison, depuis: null, lien: x.projet_id ? `#/projets/${x.projet_id}` : "#/reglages/etat" })
    }
  }
  return liste.map((x, i) => [x, i]).sort(([a, i], [b, j]) => (ORDRE_ATTENTE[a.type] ?? 9) - (ORDRE_ATTENTE[b.type] ?? 9) || i - j).map(([x]) => x)
}

// --- Les modèles : qui fait quoi ---------------------------------------------------------
// Le nom d'un modèle, pour tout le monde : « claude-sonnet-5-5 » devient « Claude Sonnet 5.5 », un
// modèle de Codex devient « ChatGPT (gpt-6.1-sol) ». Un modèle que l'usine n'a pas noté le dit.
export function nomModele(moteur, modele) {
  const m = String(modele ?? "").replace(/^(anthropic|openai)\//, "").slice(0, MODELE_MAX)
  // Le chiffre mineur a un ou deux chiffres : « claude-sonnet-4-20250514 » est Claude Sonnet 4 (daté), pas « 4.20250514 ».
  const claude = /^claude-([a-z]+)-(\d+)(?:[.-](\d{1,2})(?!\d))?/.exec(m)
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`
  const inconnu = !m || m === "inconnu" || m === "codex"
  if (moteur === "codex" || /^(gpt|o\d)/.test(m)) return inconnu ? "ChatGPT, modèle non noté" : `ChatGPT (${m})`
  return inconnu ? "Claude, modèle non noté" : m
}

// Les travaux notés dans les consommations (le rôle de enregistrer(), couts.mjs), dans l'ordre d'une fonction.
const TRAVAUX = {
  analyste: "Faire le plan", agent: "Construire", "relecteur-securite": "Relire la sécurité", verificateur: "Contrôler",
  designer: "Relire le design", recette: "Jouer la recette", chercheur: "Étudier un public", inventaire: "Inventorier un code repris",
  aiguillage: "Aiguiller les demandes",
}
const ORDRE_TRAVAUX = Object.keys(TRAVAUX)
const travail = (role) => TRAVAUX[role] ?? String(role ?? "autre").slice(0, ROLE_MAX)

// Qui fait quoi aujourd'hui, d'après le contrat et les réglages : le modèle de chaque travail, et
// l'ordre des relais pour les jugements (le premier disponible sert, le suivant prend le relais).
function quiFaitQuoi(ctx) {
  const { config, db } = ctx
  const m = config.modeles ?? {}
  // Un nom de modèle vient du contrat ou d'un réglage : seul un texte court est gardé, jamais un objet.
  const nom = (x) => (typeof x === "string" && x ? x.slice(0, MODELE_MAX) : null)
  const claude = (modele) => ({ moteur: "claude-code", modele: nom(modele), nom: nom(modele) ? nomModele("claude-code", nom(modele)) : "Claude, modèle par défaut" })
  // Le modèle de Codex n'est pas choisi par l'usine : c'est le dernier qu'il a annoncé (verification.mjs).
  const codex = nom(lireReglage(db, "modele_codex", null))
  const juges = (role) => relais(ctx, role).map((moteur) => (moteur === "codex" ? { moteur, modele: codex, nom: nomModele("codex", codex) } : claude(modeleJuge(config))))
  return {
    roles: [
      // Les mêmes mots que le bilan de la semaine (TRAVAUX).
      { role: "plan", travail: TRAVAUX.analyste, modeles: [claude(m.analyste?.modele)] },
      { role: "construction", travail: TRAVAUX.agent, modeles: [claude(m.atelier?.modele)] },
      // Le modèle de fabrique.mjs après un changement d'approche.
      { role: "renfort", travail: `${TRAVAUX.agent} après un changement d'approche`, modeles: [claude(m.renfort?.modele ?? MODELE_RENFORT_DEFAUT)] },
      { role: "securite", travail: TRAVAUX["relecteur-securite"], modeles: [claude(m.relecteur?.modele ?? m.atelier?.modele)] },
      { role: "verification", travail: TRAVAUX.verificateur, modeles: juges("verification") },
      { role: "design", travail: TRAVAUX.designer, modeles: juges("design") },
      { role: "recette", travail: TRAVAUX.recette, modeles: juges("recette") },
    ],
    // Un accès à un modèle (abonnement, clé, passerelle) à sa limite : l'usine passe au suivant, ou se met en pause.
    // Seuls les moteurs et les accès connus (la clé du réglage est découpée, cf. limitesEnCours).
    limites: limitesEnCours(db)
      .filter((l) => MOTEURS_RELAIS.includes(l.moteur) && MODES.includes(l.mode))
      .map((l) => ({ moteur: l.moteur, nom: l.moteur === "codex" ? "ChatGPT" : "Claude", acces: l.mode, mode: nomMode(l.mode), jusqua: iso(l.jusqua) }))
      .filter((l) => l.jusqua),
  }
}

// --- L'usine maintenant ----------------------------------------------------------------
function deploiements(statut, produits, maintenant) {
  const entrees = Object.entries(statut).flatMap(([cle, s]) => {
    const m = /^(apercu|production)\/([a-z0-9-]+)$/.exec(cle)
    if (!m || !s || typeof s !== "object") return []
    const enCours = s.etat === "en_cours"
    const sha = enCours ? s.sha_demande ?? s.sha : s.sha
    // Le message d'un échec : sa première ligne (la suite est une pile d'appels).
    const message = s.message ? enClair(texte(String(s.message).split("\n")[0].replace(/\s*:\s*$/, ""))) : null
    const projet = produits.get(m[2]) ?? null
    return [{
      cle,
      environnement: m[1],
      projet_id: projet?.id ?? null,
      nom: projet?.nom ?? m[2],
      etat: ["ok", "echec", "en_cours"].includes(s.etat) ? s.etat : "inconnu",
      sha: court(sha),
      demande_le: iso(s.demande_le),
      le: iso(s.le),
      couleur: s.couleur === "blue" || s.couleur === "green" ? s.couleur : null,
      message: s.etat === "echec" ? message : null,
      bloque: enCours && s.le ? maintenant - dateDe(s.le).getTime() > DEPLOIEMENT_BLOQUE_MS : false,
    }]
  })
  const recent = (a, b) => (b.le ?? "").localeCompare(a.le ?? "")
  return { en_cours: entrees.filter((x) => x.etat === "en_cours").sort(recent), dernier: entrees.filter((x) => x.etat !== "en_cours").sort(recent)[0] ?? null }
}

// Le serveur, d'après sante.json. Chaque mesure est un nombre ou null ; sans nombre, l'état est « inconnu ».
function serveur(s, maintenant, processeurs) {
  if (!s || typeof s !== "object") return null
  const age = Math.round((maintenant - dateDe(s.le).getTime()) / 1000)
  const objet = (x) => (x && typeof x === "object" ? x : null)
  const d = objet(s.disque)
  const m = objet(s.memoire)
  const c = Array.isArray(s.charge) ? s.charge.slice(0, 3).map(nb) : null
  const pct = nb(d?.pct)
  const [dispo, total] = [nb(m?.dispo_mo), nb(m?.total_mo)]
  const memPct = dispo !== null && total ? Math.round(100 - (dispo / total) * 100) : null
  const chargePct = c?.[0] !== null && c?.[0] !== undefined && processeurs ? Math.round((c[0] / processeurs) * 100) : null
  return {
    le: iso(s.le),
    perime: !Number.isFinite(age) || age > SONDE_PERIMEE_S,
    disque: d ? { pct, libre_go: nb(d.libre_go), total_go: nb(d.total_go), etat: pct === null ? "inconnu" : pct >= DISQUE.panne ? "panne" : pct >= DISQUE.alerte ? "alerte" : "ok" } : null,
    memoire: m ? { pct: memPct, dispo_mo: dispo, total_mo: total, swap_utilise_mo: nb(m.swap_utilise_mo) ?? 0, etat: dispo === null ? "inconnu" : dispo < MEMOIRE_MO.panne ? "panne" : dispo < MEMOIRE_MO.alerte ? "alerte" : "ok" } : null,
    charge: c ? { minute: c[0], cinq_minutes: c[1] ?? null, quinze_minutes: c[2] ?? null, processeurs, pct: chargePct, etat: chargePct === null ? "inconnu" : chargePct >= CHARGE_ALERTE * 100 ? "alerte" : "ok" } : null,
  }
}

function usineMaintenant(ctx, sante, statut, produits, maintenant, processeurs) {
  const taches = ctx.db.prepare(`SELECT t.id, t.cle, t.titre, t.statut, t.tentative, t.approche, t.maj_le, t.projet_id, p.nom
      FROM taches t JOIN projets p ON p.id = t.projet_id WHERE t.statut IN ('en_cours', 'verification') ORDER BY t.maj_le, t.id`).all()
  const qui = quiFaitQuoi(ctx)
  const role = (r) => qui.roles.find((x) => x.role === r)
  // Le dernier modèle qui a construit la tâche (noté à la fin de chaque essai de l'agent).
  const constructeur = ctx.db.prepare("SELECT moteur, modele FROM consommations WHERE tache_id = ? AND role = 'agent' AND modele != 'inconnu' ORDER BY id DESC LIMIT 1")
  return {
    taches: taches.map((t) => {
      // En construction : le modèle de l'atelier, ou le renfort après un changement d'approche ; au contrôle : les juges, dans l'ordre du relais.
      const r = t.statut === "verification" ? role("verification") : role(t.approche > 0 ? "renfort" : "construction")
      const c = constructeur.get(t.id)
      return {
        projet_id: t.projet_id, projet: t.nom ?? `Projet ${t.projet_id}`, cle: t.cle, titre: t.titre, statut: t.statut, tentative: t.tentative, approche: t.approche, depuis: iso(t.maj_le),
        modeles: r.modeles.map((x) => x.nom),
        construite_par: c ? nomModele(c.moteur, c.modele) : null,
      }
    }),
    qui_fait_quoi: qui,
    deploiements: deploiements(statut, produits, maintenant),
    serveur: serveur(sante, maintenant, processeurs),
  }
}

// --- Les 7 derniers jours ---------------------------------------------------------------
const CLES = { fusion: "fusions", refus: "refus", escalade: "escalades" }
function septJours(ctx, produits, maintenant) {
  const { db, config } = ctx
  const rc = reglagesCouts(db, config)
  const jours = joursFenetre(maintenant)
  const fenetre = new Set(jours)
  // Une marge d'un jour en temps universel, puis le tri exact par jour de Paris.
  const depuis = new Date(maintenant - (JOURS + 1) * 86_400_000).toISOString().slice(0, 19).replace("T", " ")
  const dansLaFenetre = (le) => {
    const d = dateDe(le)
    return d.getTime() <= maintenant && fenetre.has(jourParis(d))
  }
  const noms = Object.fromEntries([...produits.values()].map((p) => [p.id, p.nom]))
  for (const p of db.prepare("SELECT id, nom FROM projets").all()) noms[p.id] ??= p.nom ?? `Projet ${p.id}`

  const parJour = Object.fromEntries(jours.map((j) => [j, { jour: j, fusions: 0, refus: 0, escalades: 0 }]))
  const totaux = { fusions: 0, refus: 0, escalades: 0 }
  const causes = new Map()
  const lignes = new Map()
  const ligne = (id) => {
    const cle = id ?? 0
    if (!lignes.has(cle)) lignes.set(cle, { projet_id: id ?? null, nom: id ? noms[id] ?? `Projet ${id}` : "L'usine elle-même", fusions: 0, refus: 0, escalades: 0, usd: 0, duree_s: 0 })
    return lignes.get(cle)
  }
  for (const e of db.prepare("SELECT type, message, le, projet_id FROM journal WHERE type IN ('fusion', 'refus', 'escalade') AND le >= ?").all(depuis)) {
    if (!dansLaFenetre(e.le)) continue
    const k = CLES[e.type]
    parJour[jourParis(dateDe(e.le))][k] += 1
    totaux[k] += 1
    ligne(e.projet_id)[k] += 1
    if (e.type === "refus") {
      const c = causeDuRefus(e.message)
      causes.set(c, (causes.get(c) ?? 0) + 1)
    }
  }
  let usd = 0
  let duree = 0
  let inconnu = false
  // Les modèles au travail : un compte par travail et par modèle (moteur compris : la passerelle se paie à l'usage).
  const parModele = new Map()
  for (const c of db.prepare("SELECT projet_id, tache_id, role, moteur, modele, cout_api_usd, duree_s, le, id FROM consommations WHERE le >= ? ORDER BY id").all(depuis)) {
    if (!dansLaFenetre(c.le)) continue
    if (c.cout_api_usd === null) inconnu = true
    const l = ligne(c.projet_id)
    l.usd += c.cout_api_usd ?? 0
    l.duree_s += c.duree_s ?? 0
    usd += c.cout_api_usd ?? 0
    duree += c.duree_s ?? 0
    const cle = `${c.role}|${c.moteur}|${c.modele}`
    if (!parModele.has(cle)) parModele.set(cle, { role: c.role, moteur: c.moteur, modele: c.modele, taches: new Set(), utilisations: 0, usd: 0, duree_s: 0, prix_inconnu: false })
    const m = parModele.get(cle)
    m.utilisations += 1
    m.usd += c.cout_api_usd ?? 0
    m.duree_s += c.duree_s ?? 0
    if (c.cout_api_usd === null) m.prix_inconnu = true
    if (c.tache_id) m.taches.add(c.tache_id)
  }
  const heures = (s) => Math.round(s / 360) / 10
  const cout = (u) => montant(rc, versDevise(rc, u), { decimales: versDevise(rc, u) >= 100 ? 0 : 2 })
  const verifications = totaux.fusions + totaux.refus
  return {
    du: jours[0],
    au: jours.at(-1),
    ...totaux,
    // La part des contrôles qui laissent passer une fonction (une fusion suit un contrôle réussi).
    acceptes_pct: verifications ? Math.round((totaux.fusions / verifications) * 100) : null,
    cout_api: versDevise(rc, usd),
    cout_api_texte: cout(usd),
    cout_incomplet: inconnu,
    heures: heures(duree),
    jours: jours.map((j) => parJour[j]),
    causes: [...causes].map(([cause, n]) => ({ cause, n, pct: Math.round((n / totaux.refus) * 100) })).sort((a, b) => b.n - a.n || a.cause.localeCompare(b.cause, "fr")),
    produits: [...lignes.values()]
      .filter((l) => l.fusions || l.refus || l.escalades || l.usd || l.duree_s)
      .map(({ usd: u, duree_s, ...l }) => ({ ...l, cout_api: versDevise(rc, u), cout_api_texte: cout(u), heures: heures(duree_s) }))
      .sort((a, b) => b.cout_api - a.cout_api || b.fusions + b.refus - (a.fusions + a.refus) || a.nom.localeCompare(b.nom, "fr")),
    // Qui a fait quoi : par travail, chaque modèle, avec le nombre de fonctions et ce qu'il a coûté.
    modeles: [...parModele.values()]
      .map((m) => ({
        role: texte(m.role, ROLE_MAX), travail: travail(m.role), moteur: texte(m.moteur, MOTEUR_MAX), modele: texte(m.modele, MODELE_MAX), nom: nomModele(m.moteur, m.modele),
        // Hors abonnement, Claude passe par la passerelle : payé à l'usage (seul l'agent le note aujourd'hui).
        paye_a_l_usage: m.moteur === "passerelle",
        fonctions: m.taches.size, utilisations: m.utilisations,
        // Sans aucun prix connu, le coût est inconnu (null), pas nul ; avec une partie connue, il est incomplet (prix_inconnu).
        cout_api: m.prix_inconnu && !m.usd ? null : versDevise(rc, m.usd), cout_api_texte: m.prix_inconnu && !m.usd ? null : cout(m.usd), prix_inconnu: m.prix_inconnu, heures: heures(m.duree_s),
      }))
      .sort((a, b) => ordreTravail(a.role) - ordreTravail(b.role) || b.utilisations - a.utilisations || a.nom.localeCompare(b.nom, "fr")),
  }
}
const ordreTravail = (role) => (ORDRE_TRAVAUX.includes(role) ? ORDRE_TRAVAUX.indexOf(role) : ORDRE_TRAVAUX.length)

// --- Les modèles, tâche par tâche -------------------------------------------------------------
// Pour un projet, lot par lot : chaque tâche, tous les modèles qui y ont travaillé (par travail,
// avec le nombre de passages), et les sous-agents de l'agent quand ils ont été notés.
//   Un passage : les lignes d'un même travail notées à la même seconde (enregistrer() note un
//   passage d'un coup, une ligne par modèle). Le modèle qui porte la durée est celui du passage ;
//   un autre modèle du même passage a servi dedans (un sous-agent ou un appel interne).
const TRAVAUX_TACHE = [["construction", "agent"], ["securite", "relecteur-securite"], ["controle", "verificateur"], ["design", "designer"]]
const SOUS_AGENTS_TACHE_MAX = 20
const tableExiste = (db, nom) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(nom))

export function modelesDuProjet(ctx, projetId) {
  const { db } = ctx
  const p = db.prepare("SELECT id, nom, plan FROM projets WHERE id = ? AND statut != 'supprime'").get(projetId)
  if (!p) return null
  let lotsPlan = []
  try {
    lotsPlan = JSON.parse(p.plan ?? "null")?.lots ?? []
  } catch {}
  const taches = db.prepare("SELECT id, cle, lot, titre, statut, tentative, approche FROM taches WHERE projet_id = ? ORDER BY lot, id").all(p.id)
  // Les passages de chaque tâche, par travail : tache -> role -> le -> lignes.
  const passages = new Map()
  for (const c of db.prepare("SELECT tache_id, role, moteur, modele, duree_s, le FROM consommations WHERE projet_id = ? AND tache_id IS NOT NULL ORDER BY id").all(p.id)) {
    const t = passages.get(c.tache_id) ?? passages.set(c.tache_id, new Map()).get(c.tache_id)
    const r = t.get(c.role) ?? t.set(c.role, new Map()).get(c.role)
    const l = r.get(c.le) ?? r.set(c.le, []).get(c.le)
    l.push(c)
  }
  const agents = tableExiste(db, "agents_tache")
    ? db.prepare("SELECT tache_id, principal, type, description, modele_demande, modeles, le FROM agents_tache WHERE projet_id = ? ORDER BY id").all(p.id)
    : []
  const lireModeles = (x) => {
    try {
      const l = JSON.parse(x)
      return Array.isArray(l) ? l.filter((m) => typeof m === "string") : []
    } catch {
      return []
    }
  }
  const travauxDe = (tacheId) => {
    const roles = passages.get(tacheId) ?? new Map()
    return Object.fromEntries(TRAVAUX_TACHE.map(([cle, role]) => {
      const parModele = new Map()
      const internes = new Set()
      const liste = [...(roles.get(role) ?? new Map()).values()]
      for (const lignes of liste) {
        // Le modèle du passage : celui qui porte la durée (la première ligne de l'appel).
        const tri = [...lignes].sort((a, b) => (b.duree_s ?? 0) - (a.duree_s ?? 0))
        const nom = nomModele(tri[0].moteur, tri[0].modele)
        parModele.set(nom, (parModele.get(nom) ?? 0) + 1)
        for (const autre of tri.slice(1)) {
          const n = nomModele(autre.moteur, autre.modele)
          if (n !== nom) internes.add(n)
        }
      }
      return [cle, { passages: liste.length, modeles: [...parModele].map(([nom, n]) => ({ nom, passages: n })), dans_le_passage: [...internes] }]
    }))
  }
  const sousAgentsDe = (tacheId) => {
    const lignes = agents.filter((a) => a.tache_id === tacheId)
    const notes = lignes.filter((a) => a.principal === 1).length
    const groupes = new Map()
    for (const a of lignes.filter((x) => x.principal !== 1)) {
      const modeles = lireModeles(a.modeles).map((m) => nomModele("claude-code", m))
      const cle = `${a.type}|${modeles.join(",")}`
      const g = groupes.get(cle) ?? groupes.set(cle, { type: texte(a.type, MODELE_MAX), modeles, modele_demande: a.modele_demande ? texte(a.modele_demande, MODELE_MAX) : null, fois: 0, description: "" }).get(cle)
      g.fois += 1
      g.description = texte(a.description, TITRE_MAX)
    }
    return { passages_notes: notes, liste: [...groupes.values()].slice(0, SOUS_AGENTS_TACHE_MAX) }
  }
  const numeros = [...new Set(taches.map((t) => t.lot))].sort((a, b) => a - b)
  const premier = agents.length ? iso(agents.reduce((m, a) => (a.le < m ? a.le : m), agents[0].le)) : null
  return {
    projet: { id: p.id, nom: texte(p.nom ?? `Projet ${p.id}`) },
    // Depuis quand les sous-agents de ce projet sont notés (null : jamais encore).
    sous_agents_depuis: premier,
    lots: numeros.map((n) => ({
      numero: n,
      nom: texte(typeof lotsPlan[n - 1]?.nom === "string" ? lotsPlan[n - 1].nom : `Lot ${n}`, TITRE_MAX),
      taches: taches.filter((t) => t.lot === n).map((t) => ({
        cle: texte(t.cle, CLE_MAX), titre: texte(t.titre, TITRE_MAX), statut: texte(t.statut, CLE_MAX), tentative: t.tentative, approche: t.approche,
        travaux: travauxDe(t.id),
        sous_agents: sousAgentsDe(t.id),
      })),
    })),
  }
}

// Les projets qui ont des tâches, le plus récemment travaillé d'abord (le choix de la vue « tâche par tâche »).
function projetsAvecTaches(db) {
  return db.prepare(`SELECT p.id, p.nom, MAX(COALESCE(c.id, 0)) AS dernier FROM projets p JOIN taches t ON t.projet_id = p.id
      LEFT JOIN consommations c ON c.tache_id = t.id WHERE p.statut != 'supprime' GROUP BY p.id ORDER BY dernier DESC, p.id DESC`).all()
    .map((p) => ({ id: p.id, nom: texte(p.nom ?? `Projet ${p.id}`) }))
}

// --- La page entière ---------------------------------------------------------------------
// aTraiter : les décisions, plans, questions et livraisons en attente (console.mjs).
export function visibilite(ctx, { aTraiter = [], maintenant = Date.now(), processeurs = availableParallelism() } = {}) {
  const produits = projetsParSlug(ctx.db)
  const sante = lireSanteServeur(ctx.config)
  const parc = parcProduits(sante, produits, ctx.config, maintenant)
  return {
    le: new Date(maintenant).toISOString(),
    fuseau: FUSEAU,
    attend: ceQuiAttend(aTraiter, parc),
    sonde: parc.sonde,
    productions: parc.productions,
    apercus: parc.apercus,
    usine: usineMaintenant(ctx, sante, lireStatut(ctx.config), produits, maintenant, processeurs),
    semaine: septJours(ctx, produits, maintenant),
    // Les projets à choisir dans la vue « tâche par tâche » ; le premier est le plus récemment travaillé.
    projets_taches: projetsAvecTaches(ctx.db),
  }
}
