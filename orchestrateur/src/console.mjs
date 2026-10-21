// La console de l'usine : une interface web pour tout ce qui se fait dans Slack
// (projets, plan, fabrication en direct, décisions, production, domaines, santé,
// coûts, accès). Servie par l'orchestrateur sur le port 8091, publiée par Caddy
// derrière le portier (administrateurs seulement).
//
//   /               la console (fichiers de orchestrateur/console, sans étape de build)
//   /api/…          l'API JSON de la console
//   /couts          l'ancienne page détaillée des coûts
//
// Sécurité : chaque requête est revérifiée auprès du portier (session d'un
// administrateur) ; une action (POST, PUT, DELETE) exige du JSON et une origine
// identique (pas de requête forgée depuis un autre site) ; chaque action est notée
// au journal avec son auteur. Aucun secret n'est jamais renvoyé.
import { createServer } from "node:http"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { extname, join, normalize, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { adresses, adressePortail } from "./config.mjs"
import { decisions, maj, noter, obtenir, plan as lirePlan, taches } from "./db.mjs"
import { verifierPlan } from "./analyste.mjs"
import * as actions from "./pipeline.mjs"
import { resoudre } from "./escalade.mjs"
import { choixProduction, decrireChoix, demanderCorrections, mettreEnProduction } from "./livraison.mjs"
import { repondreDansLeFil } from "./conversation.mjs"
import { decrireApercu, garderApercu, mettreAJourUsine, prolongerApercu, retirerApercu, supprimerProjet } from "./cycle.mjs"
import { etatUsine, lireSanteServeur, resumeEtat } from "./sante.mjs"
import { bilanMois, bilanProjet, budgetMensuel, budgetProjet, ecrireReglage, evolution, lireReglage, montant, reglagesCouts } from "./couts.mjs"
import { ajouterDomaine, ipServeur, listerDomaines, retirerDomaine } from "./domaines.mjs"
import { portier, quiEstConnecte } from "./portier.mjs"
import { direct } from "./direct.mjs"
import { etatVideo, fichierVideo, genererVideo } from "./video.mjs"
import { enregistrerPieces, listerPieces, verifierPieces } from "./pieces.mjs"
import { versDevise } from "./couts.mjs"
import { page as pageCouts } from "./tableau.mjs"
import { creerPersona, lancerRecherche, lirePersona, listerPersonas, modifierPersona, obtenirPersona, supprimerPersona, validerPersona } from "./personas.mjs"
import { MODES_REPRISE } from "./reprise.mjs"
import { ecartsEnCorrections, lireRecette } from "./recette.mjs"
import { proteges } from "./profil.mjs"

const STATIQUE = fileURLToPath(new URL("../console/", import.meta.url))
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" }
const ENTETES = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}

const erreur = (code, message) => Object.assign(new Error(message), { code })

// Les raisons d'une escalade, en clair.
const RAISONS = {
  criteres: "les critères ne passent pas malgré les corrections et un changement d'approche",
  verificateur: "le vérificateur n'a pas pu juger la tâche",
  infrastructure: "un problème d'infrastructure empêche d'avancer",
  livraison: "le déploiement de l'aperçu a échoué",
  cout: "le budget du projet est atteint",
  budget: "la durée maximale du projet est atteinte",
}

// --- Lecture ------------------------------------------------------------------------

function avancement(db, p) {
  const t = taches(db, p.id)
  const fini = t.filter((x) => ["fusionnee", "abandonnee"].includes(x.statut)).length
  const enCours = t.find((x) => ["en_cours", "verification"].includes(x.statut))
  return { total: t.length, fusionnees: t.filter((x) => x.statut === "fusionnee").length, finies: fini, en_cours: enCours ? { cle: enCours.cle, titre: enCours.titre, statut: enCours.statut } : null }
}

function resumeProjet(ctx, p) {
  const { db, config } = ctx
  const plan = lirePlan(p)
  const a = p.slug ? adresses(config, p.slug) : null
  const c = bilanProjet(db, reglagesCouts(db, config), p.id)
  return {
    id: p.id,
    nom: p.nom ?? p.prompt.slice(0, 60),
    resume: plan?.resume ?? p.prompt.slice(0, 160),
    brique: plan?.pile ? null : plan?.brique ?? (plan ? "webapp" : null),
    statut: p.statut,
    lot_livre: p.lot_livre,
    lots: plan?.lots?.length ?? 0,
    avancement: avancement(db, p),
    escalades: db.prepare("SELECT COUNT(*) AS n FROM escalades WHERE projet_id = ? AND statut = 'ouverte'").get(p.id).n,
    cout: c.mesure ? montant(reglagesCouts(db, config), c.api) : null,
    apercu: a && p.lot_livre && !p.apercu_retire ? a.apercu : null,
    production: a && p.statut === "en_production" ? a.production : null,
    apercu_vie: decrireApercu(p),
    repris: Boolean(p.origine),
    persona: p.persona_id ? (db.prepare("SELECT nom FROM personas WHERE id = ?").get(p.persona_id)?.nom ?? null) : null,
    maj_le: p.maj_le,
  }
}

function aTraiter(ctx) {
  const { db } = ctx
  const liste = []
  for (const e of db.prepare("SELECT e.*, p.nom FROM escalades e JOIN projets p ON p.id = e.projet_id WHERE e.statut = 'ouverte' ORDER BY e.id").all()) {
    const t = e.tache_id ? obtenir(db, "taches", e.tache_id) : null
    liste.push({ type: "decision", projet: e.projet_id, titre: `${e.nom} · décision attendue`, detail: `${t ? `${t.cle} : ` : ""}${RAISONS[e.raison] ?? e.raison}` })
  }
  for (const p of db.prepare("SELECT * FROM projets WHERE statut IN ('plan_a_valider', 'questions', 'livre') ORDER BY id DESC").all()) {
    const plan = lirePlan(p)
    if (p.statut === "plan_a_valider") liste.push({ type: "plan", projet: p.id, titre: `${p.nom} · plan à valider`, detail: `${plan?.lots?.length ?? 0} lots, ${plan?.lots?.reduce((n, l) => n + l.taches.length, 0) ?? 0} tâches` })
    if (p.statut === "questions") liste.push({ type: "questions", projet: p.id, titre: `${p.nom ?? "Nouveau projet"} · l'analyste a des questions`, detail: (plan?.questions ?? []).slice(0, 1).join("") })
    if (p.statut === "livre") liste.push({ type: "livre", projet: p.id, titre: `${p.nom} · livré`, detail: "à mettre en production ou à corriger" })
  }
  return liste
}

async function resume(ctx) {
  const { db, config } = ctx
  const projets = db.prepare("SELECT * FROM projets WHERE statut NOT IN ('supprime') ORDER BY maj_le DESC, id DESC LIMIT 50").all().map((p) => resumeProjet(ctx, p))
  const s = lireSanteServeur(config)
  const rc = reglagesCouts(db, config)
  const b = bilanMois(db, rc)
  const budget = budgetMensuel(db, rc)
  const enCours = db.prepare("SELECT COUNT(*) AS n FROM taches WHERE statut IN ('en_cours', 'verification')").get().n
  return {
    usine: { base: config.domaine.base, portail: adressePortail(config), arretee: existsSync(join(config.dataDir, "STOP")), taches_en_cours: enCours, mise_a_jour: s?.mise_a_jour ?? null },
    a_traiter: aTraiter(ctx),
    projets,
    serveur: s ? { disque: s.disque?.pct ?? null, memoire: s.memoire ? Math.round(100 - (s.memoire.dispo_mo / s.memoire.total_mo) * 100) : null } : null,
    couts: { mois: montant(rc, b.api), reel: montant(rc, b.reel), budget: budget > 0 ? montant(rc, budget) : null, pct: budget > 0 ? Math.round((b.api / budget) * 100) : null },
  }
}

function capturesProjet(ctx, projetId) {
  const dossier = join(ctx.config.dataDir, "captures", String(projetId))
  if (!existsSync(dossier)) return []
  const liste = []
  for (const cle of readdirSync(dossier)) {
    if (!/^T\d+$/.test(cle)) continue
    for (const f of readdirSync(join(dossier, cle)).filter((x) => /^[\w.-]+\.png$/.test(x))) liste.push({ tache: cle, fichier: f, url: `/api/captures/${projetId}/${cle}/${f}` })
  }
  return liste.sort((a, b) => Number(b.tache.slice(1)) - Number(a.tache.slice(1))).slice(0, 24)
}

async function detailProjet(ctx, id) {
  const { db, config } = ctx
  const p = obtenir(db, "projets", id)
  if (!p || p.statut === "supprime") throw erreur(404, "Projet introuvable.")
  const plan = lirePlan(p)
  const t = taches(db, id).map((x) => ({ id: x.id, cle: x.cle, lot: x.lot, titre: x.titre, statut: x.statut, tentative: x.tentative, approche: x.approche, pr: x.pr, tests: x.tests, design: x.design ? JSON.parse(x.design) : null, retours: x.statut === "fusionnee" ? null : x.retours?.slice(0, 1500) ?? null }))
  let etapes = []
  try {
    etapes = JSON.parse(lireReglage(db, `suivi_${id}`, "[]"))
  } catch {}
  return {
    ...resumeProjet(ctx, p),
    prompt: p.prompt,
    depot: p.depot ? `https://github.com/${p.depot}` : null,
    plan,
    taches: t,
    etapes,
    journal: db.prepare("SELECT id, le, type, message, tache_id FROM journal WHERE projet_id = ? ORDER BY id DESC LIMIT 80").all(id).reverse(),
    escalades: db.prepare("SELECT id, tache_id, raison, options, cree_le FROM escalades WHERE projet_id = ? AND statut = 'ouverte' ORDER BY id").all(id).map((e) => ({ ...e, raison: RAISONS[e.raison] ?? e.raison, options: JSON.parse(e.options), tache: e.tache_id ? obtenir(db, "taches", e.tache_id)?.cle : null })),
    decisions: decisions(db, id).slice(-10),
    production_choix: choixProduction(config, p.production ? JSON.parse(p.production) : null),
    production_texte: p.production ? decrireChoix(JSON.parse(p.production)) : null,
    domaines: listerDomaines(db, id),
    domaines_liste: db.prepare("SELECT hote, statut, message, verifie_le FROM domaines WHERE projet_id = ? AND statut != 'retire' ORDER BY id").all(id),
    ip_serveur: (await ipServeur(config).catch(() => []))[0] ?? null,
    captures: capturesProjet(ctx, id),
    pieces: listerPieces(config, id).map((x) => ({ nom: x.nom, taille: x.taille })),
    video: etatVideo(ctx, id),
    estimation: plan?.lots?.length ? estimation(ctx, plan.lots.reduce((n, l) => n + l.taches.length, 0)) : null,
    apercu_garde: !!p.apercu_garde,
    origine: p.origine ? { ...JSON.parse(p.origine), url: `https://github.com/${JSON.parse(p.origine).depot}` } : null,
    branche: p.branche ?? "main",
    persona_id: p.persona_id ?? null,
    inventaire: p.inventaire ? JSON.parse(p.inventaire) : null,
    profil: p.profil ? JSON.parse(p.profil) : null,
    recette: lireRecette(p),
    pr_livraison: p.pr_livraison && p.depot ? `https://github.com/${p.depot}/pull/${p.pr_livraison}` : null,
    budget: (() => {
      const rc = reglagesCouts(db, config)
      const bp = budgetProjet(db, rc, p)
      return bp > 0 ? montant(rc, bp) : null
    })(),
  }
}

async function santeEtCouts(ctx) {
  const { db, config } = ctx
  const { composants, serveur } = await etatUsine(ctx)
  const rc = reglagesCouts(db, config)
  const b = bilanMois(db, rc)
  const budget = budgetMensuel(db, rc)
  const projets = db.prepare("SELECT * FROM projets WHERE statut NOT IN ('abandonne', 'supprime') ORDER BY id DESC").all()
  return {
    etat: resumeEtat(composants),
    composants,
    serveur: serveur ? { disque: serveur.disque, memoire: serveur.memoire, mise_a_jour: serveur.mise_a_jour ?? null, le: serveur.le } : null,
    couts: {
      api: montant(rc, b.api), reel: montant(rc, b.reel), budget: budget > 0 ? montant(rc, budget) : null, pct: budget > 0 ? Math.round((b.api / budget) * 100) : null,
      evolution: evolution(db, rc, 6).map((e) => ({ mois: e.mois, api: e.api, reel: e.reel, api_texte: montant(rc, e.api), reel_texte: montant(rc, e.reel) })),
      projets: projets.map((p) => {
        const c = bilanProjet(db, rc, p.id)
        const bp = budgetProjet(db, rc, p)
        return { id: p.id, nom: p.nom ?? p.prompt.slice(0, 40), statut: p.statut, mesure: c.mesure, api: montant(rc, c.api), reel: montant(rc, c.reel), budget_pct: bp > 0 ? Math.round((c.api / bp) * 100) : null, refus: c.refus, escalades: c.escalades }
      }),
    },
  }
}

// L'estimation d'un projet, d'après l'historique de l'usine : le coût (équivalent API) et le
// temps de calcul moyens d'une tâche fusionnée, multipliés par le nombre de tâches. Sans
// historique suffisant (moins de 5 tâches mesurées), pas d'estimation : on n'invente rien.
export function estimation(ctx, nbTaches = null) {
  const { db, config } = ctx
  const rc = reglagesCouts(db, config)
  const t = db.prepare(`SELECT COUNT(*) AS n, AVG(cout) AS cout, AVG(duree) AS duree FROM (
      SELECT t.id, SUM(COALESCE(c.cout_api_usd, 0)) AS cout, SUM(c.duree_s) AS duree
      FROM taches t JOIN consommations c ON c.tache_id = t.id WHERE t.statut = 'fusionnee' GROUP BY t.id)`).get()
  if (!t || t.n < 5) return { disponible: false, mesurees: t?.n ?? 0 }
  const plans = db.prepare("SELECT plan FROM projets WHERE plan IS NOT NULL AND statut NOT IN ('abandonne', 'questions', 'analyse')").all()
    .map((p) => { try { return JSON.parse(p.plan).lots ?? [] } catch { return [] } }).filter((l) => l.length)
  const tachesTypiques = plans.length ? Math.round(plans.reduce((s, l) => s + Math.min(l.slice(0, 6).reduce((n, x) => n + (x.taches?.length ?? 0), 0), 40), 0) / plans.length) : null
  const n = nbTaches ?? tachesTypiques
  if (!n) return { disponible: false, mesurees: t.n }
  const minutes = Math.round((t.duree * n) / 60)
  return {
    disponible: true,
    mesurees: t.n,
    taches: n,
    typique: nbTaches === null,
    cout: montant(rc, versDevise(rc, t.cout * n), { decimales: 0 }),
    duree: minutes >= 90 ? `${Math.round(minutes / 60)} h` : `${minutes} min`,
    par_tache: montant(rc, versDevise(rc, t.cout)),
  }
}

// L'historique : qui a fait quoi (validations, décisions, production, corrections, réglages…).
const TYPES_HISTORIQUE = ["demande", "validation", "decision", "production", "abandon", "cycle", "plan", "domaine", "corrections", "remarque", "escalade", "erreur"]
function historique(ctx, { projet = null, type = null } = {}) {
  const types = type && TYPES_HISTORIQUE.includes(type) ? [type] : TYPES_HISTORIQUE
  const filtre = projet ? "AND j.projet_id = ?" : ""
  const lignes = ctx.db.prepare(`SELECT j.id, j.le, j.type, j.message, j.projet_id, p.nom AS projet FROM journal j LEFT JOIN projets p ON p.id = j.projet_id
      WHERE j.type IN (${types.map(() => "?").join(",")}) ${filtre} ORDER BY j.id DESC LIMIT 200`).all(...types, ...(projet ? [projet] : []))
  // L'auteur, quand le message le dit (« … par x », « (par x) », « validé par x »).
  return lignes.map((l) => ({ ...l, message: l.message.slice(0, 600), par: (l.message.match(/\bpar ([^\s()]+@[^\s()]+|[A-Za-zÀ-ÿ0-9._-]{2,40})\)?\s*$/) ?? l.message.match(/\(par ([^)]+)\)/))?.[1] ?? null }))
}

// Les réglages : la forge du code (GitHub aujourd'hui, GitLab prévu), les budgets
// (modifiables, comme dans Slack) et le contrat de l'usine (lecture).
let compteGithub = { valeur: null, le: 0 }
async function reglages(ctx) {
  const { config, db } = ctx
  let compte = Date.now() - compteGithub.le < 300_000 ? compteGithub.valeur : null
  if (!compte) try {
    const r = await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${config.secrets.github}`, "user-agent": "usine-logicielle" }, signal: AbortSignal.timeout(8_000) })
    compte = r.ok ? { ok: true, login: (await r.json()).login } : { ok: false, detail: `réponse ${r.status}` }
  } catch (e) {
    compte = { ok: false, detail: "GitHub injoignable" }
  }
  compteGithub = { valeur: compte, le: Date.now() }
  const rc = reglagesCouts(db, config)
  return {
    forge: {
      type: "github",
      compte,
      proprietaire: config.github.proprietaire,
      visibilite: config.github.visibilite ?? "private",
      depot_etat: config.github.depot_etat,
    },
    couts: {
      devise: rc.couts?.devise ?? "EUR",
      budget_mensuel: Number(rc.budget?.mensuel ?? 0),
      budget_par_projet: Number(rc.budget?.par_projet ?? 0),
      alertes: rc.budget?.alertes ?? [50, 80, 100],
      serveur_mensuel: Number(rc.couts?.serveur_mensuel ?? 0),
      abonnements: (rc.couts?.abonnements ?? []).map((a) => ({ nom: a.nom, mensuel: Number(a.mensuel ?? 0) })),
    },
    contrat: {
      modeles: Object.entries(config.modeles ?? {}).map(([role, m]) => ({ role, moteur: m.moteur ?? "passerelle", modele: m.modele ?? "par défaut" })),
      autonomie: config.autonomie ?? {},
      politiques: config.politiques ?? {},
      apercus_jours: Number(config.apercus?.duree_vie_jours ?? 7),
      finition: config.finition !== false,
      demo: !!config.demo?.actif,
      perimetre_protege: config.perimetre_protege ?? [],
    },
  }
}

function enregistrerCouts(ctx, c, qui) {
  const { db } = ctx
  let s = {}
  try {
    s = JSON.parse(lireReglage(db, "couts", "{}"))
  } catch {}
  const nombre = (v, nom) => {
    const n = Number(String(v ?? "").replace(",", "."))
    if (!Number.isFinite(n) || n < 0 || n > 1e7) throw erreur(400, `${nom} : un montant positif est attendu.`)
    return n
  }
  s.budget = { ...(s.budget ?? {}), mensuel: nombre(c.budget_mensuel, "Budget mensuel"), par_projet: nombre(c.budget_par_projet, "Budget par projet") }
  const base = reglagesCouts(db, ctx.config).couts?.abonnements ?? []
  s.couts = {
    ...(s.couts ?? {}),
    serveur_mensuel: nombre(c.serveur_mensuel, "Serveur"),
    abonnements: base.map((a, i) => ({ ...a, mensuel: c.abonnements?.[i] !== undefined ? nombre(c.abonnements[i], a.nom) : a.mensuel })),
  }
  ecrireReglage(db, "couts", JSON.stringify(s))
  console.log(`Réglages des coûts modifiés dans la console par ${qui.email}`)
  return { ok: true, message: "Budgets et coûts enregistrés." }
}

// --- Actions ------------------------------------------------------------------------

const PRODUCTION_VALEURS = { donnees: ["demo", "vide"], emails: ["captures", "reels"], horloge: ["acceleree", "reelle"], acces: ["protege", "public"] }
function demandeProduction(corps) {
  const d = {}
  for (const [k, valeurs] of Object.entries(PRODUCTION_VALEURS)) if (corps[k] !== undefined) {
    if (!valeurs.includes(corps[k])) throw erreur(400, `${k} : valeur inconnue`)
    d[k] = corps[k]
  }
  if (corps.destinataires_autorises !== undefined) d.destinataires_autorises = String(corps.destinataires_autorises).split(/[\s,;]+/).filter((x) => /^[^\s@]*@[^\s@]+\.[^\s@]+$/.test(x)).slice(0, 50)
  if (d.emails === "reels" && !d.destinataires_autorises?.length) throw erreur(400, "Emails réels : indique au moins un destinataire autorisé (adresse ou @domaine).")
  return d
}

const productionsEnCours = new Set()

// Un persona choisi pour un projet : il doit exister et être validé (sa fiche a été relue).
function personaValide(ctx, id) {
  if (id === undefined || id === null || id === "") return null
  const p = obtenirPersona(ctx.db, Number(id))
  if (!p) throw erreur(400, "Persona introuvable.")
  if (p.statut !== "valide") throw erreur(409, `Le persona « ${p.nom} » n'est pas validé : relis sa fiche et valide-la d'abord.`)
  return p.id
}

// Les routes : [méthode, motif, gestionnaire(ctx, params, corps, qui)].
const ROUTES = [
  ["GET", /^\/api\/moi$/, (_ctx, _p, _c, qui) => ({ email: qui.email, role: qui.role })],
  ["GET", /^\/api\/resume$/, (ctx) => resume(ctx)],
  ["GET", /^\/api\/estimation$/, (ctx) => estimation(ctx)],
  ["GET", /^\/api\/historique$/, (ctx, _p, _c, _q, url) => historique(ctx, { projet: Number(url.searchParams.get("projet")) || null, type: url.searchParams.get("type") })],
  ["GET", /^\/api\/sante$/, (ctx) => santeEtCouts(ctx)],
  ["GET", /^\/api\/projets\/(\d+)$/, (ctx, [id]) => detailProjet(ctx, Number(id))],
  // Le direct : ce que fait l'agent (ou le vérificateur) sur la tâche en cours du projet.
  ["GET", /^\/api\/projets\/(\d+)\/direct$/, (ctx, [id]) => direct(ctx, ctx.db.prepare("SELECT * FROM taches WHERE projet_id = ? AND statut IN ('en_cours', 'verification') ORDER BY id LIMIT 1").get(Number(id)))],

  ["POST", /^\/api\/projets$/, async (ctx, _p, c, qui) => {
    const prompt = String(c.prompt ?? "").trim()
    if (prompt.length < 20) throw erreur(400, "Décris un peu plus ce que tu veux construire (20 caractères au moins).")
    if (prompt.length > 8000) throw erreur(400, "La demande est trop longue (8 000 caractères au plus).")
    let fichiers
    try {
      fichiers = verifierPieces(c.pieces)
    } catch (e) {
      throw erreur(400, e.message)
    }
    const personaId = personaValide(ctx, c.persona_id)
    // Les pièces sont posées avant le lancement de l'analyse, qui les lit.
    const id = await actions.nouveauProjet(ctx, { prompt, demandeur: qui.email, personaId, avant: (projetId) => enregistrerPieces(ctx.config, projetId, fichiers) })
    return { ok: true, id }
  }],
  // Reprendre un dépôt existant (un reverse engineering, par exemple) pour un persona.
  ["POST", /^\/api\/projets\/reprendre$/, async (ctx, _p, c, qui) => {
    const adresse = String(c.adresse ?? "").trim()
    if (!adresse) throw erreur(400, "Donne l'adresse du dépôt GitHub.")
    const mode = MODES_REPRISE.includes(c.mode) ? c.mode : "auto"
    const consigne = String(c.consigne ?? "").trim()
    if (consigne.length > 6000) throw erreur(400, "La consigne est trop longue (6 000 caractères au plus).")
    const r = await actions.reprendreDepot(ctx, { adresse, personaId: personaValide(ctx, c.persona_id), mode, consigne, demandeur: qui.email })
    if (!r.ok) throw erreur(409, r.message)
    return r
  }],
  ["POST", /^\/api\/projets\/(\d+)\/corriger-recette$/, (ctx, [id], _c, qui) => {
    const p = obtenir(ctx.db, "projets", Number(id))
    const texte = ecartsEnCorrections(lireRecette(p))
    if (!texte) throw erreur(409, "La recette n'a relevé aucun écart.")
    return demanderCorrections(ctx, Number(id), texte, qui.email)
  }],

  ["GET", /^\/api\/personas$/, (ctx) => ({ personas: listerPersonas(ctx.db) })],
  ["GET", /^\/api\/personas\/(\d+)$/, (ctx, [id]) => {
    const p = lirePersona(obtenirPersona(ctx.db, Number(id)))
    if (!p) throw erreur(404, "Persona introuvable.")
    return { ...p, projets: ctx.db.prepare("SELECT id, nom, statut FROM projets WHERE persona_id = ? AND statut != 'supprime' ORDER BY id DESC").all(p.id) }
  }],
  ["POST", /^\/api\/personas$/, (ctx, _p, c, qui) => creerPersona(ctx, { nom: c.nom, brief: c.brief, par: qui.email })],
  ["PUT", /^\/api\/personas\/(\d+)$/, (ctx, [id], c, qui) => modifierPersona(ctx, Number(id), c, qui.email)],
  ["POST", /^\/api\/personas\/(\d+)\/approfondir$/, (ctx, [id], c, qui) => {
    const p = obtenirPersona(ctx.db, Number(id))
    if (!p) throw erreur(404, "Persona introuvable.")
    if (p.statut === "recherche") throw erreur(409, "Une recherche est déjà en cours.")
    lancerRecherche(ctx, p.id, { consignes: String(c.consignes ?? "").trim().slice(0, 3000), par: qui.email })
    return { ok: true, message: "Recherche relancée : la fiche approfondie arrive ici dans quelques minutes." }
  }],
  ["POST", /^\/api\/personas\/(\d+)\/valider$/, (ctx, [id], _c, qui) => validerPersona(ctx, Number(id), qui.email)],
  ["DELETE", /^\/api\/personas\/(\d+)$/, (ctx, [id]) => supprimerPersona(ctx, Number(id))],
  ["PUT", /^\/api\/projets\/(\d+)\/plan$/, (ctx, [id], c, qui) => {
    const p = obtenir(ctx.db, "projets", Number(id))
    if (p?.statut !== "plan_a_valider") throw erreur(409, "Le plan ne se modifie qu'avant sa validation.")
    const avant = lirePlan(p)
    // Seuls les champs qu'on édite dans la console changent ; le reste du plan est gardé tel quel.
    const plan = { ...avant, lots: c.plan?.lots ?? avant.lots }
    const problemes = verifierPlan(plan, { protege: proteges(ctx.config, p).filter((f) => !f.includes("*")), repris: Boolean(p.origine) })
    if (problemes.length) throw erreur(400, `Plan refusé : ${problemes.slice(0, 3).join(" ; ")}`)
    maj(ctx.db, "projets", p.id, { plan: JSON.stringify(plan) })
    noter(ctx.db, { projet: p.id, type: "plan", message: `Plan modifié dans la console par ${qui.email}` })
    return { ok: true }
  }],
  ["POST", /^\/api\/projets\/(\d+)\/valider$/, (ctx, [id], _c, qui) => actions.validerPlan(ctx, Number(id), qui.email)],
  ["POST", /^\/api\/projets\/(\d+)\/abandonner$/, (ctx, [id], _c, qui) => actions.abandonnerPlan(ctx, Number(id), qui.email)],
  ["POST", /^\/api\/projets\/(\d+)\/message$/, async (ctx, [id], c, qui) => {
    const texte = String(c.texte ?? "").trim()
    if (!texte) throw erreur(400, "Message vide.")
    const r = await repondreDansLeFil(ctx, Number(id), texte, qui.email)
    return { ok: true, message: r ?? "Message transmis à l'usine." }
  }],
  ["POST", /^\/api\/projets\/(\d+)\/video$/, (ctx, [id], _c, qui) => {
    try {
      return genererVideo(ctx, Number(id), qui.email)
    } catch (e) {
      throw erreur(409, e.message)
    }
  }],
  ["POST", /^\/api\/projets\/(\d+)\/corriger$/, (ctx, [id], c, qui) => demanderCorrections(ctx, Number(id), String(c.texte ?? ""), qui.email)],
  ["POST", /^\/api\/escalades\/(\d+)$/, (ctx, [id], c, qui) => resoudre(ctx, Number(id), { choix: String(c.choix ?? ""), texte: String(c.texte ?? ""), par: qui.email })],
  ["POST", /^\/api\/projets\/(\d+)\/production$/, (ctx, [id], c, qui) => {
    if (c.confirme !== true) throw erreur(400, "La mise en production doit être confirmée.")
    const demande = demandeProduction(c)
    const p = obtenir(ctx.db, "projets", Number(id))
    if (!["livre", "en_production"].includes(p?.statut)) throw erreur(409, `Le projet est « ${p?.statut ?? "inconnu"} » : pas de mise en production possible maintenant.`)
    if (demande.emails === "reels" && !process.env.SMTP_HOST) throw erreur(409, "Emails réels demandés, mais aucun service d'envoi n'est configuré sur le serveur.")
    if (productionsEnCours.has(p.id)) throw erreur(409, "Une mise en production de ce projet est déjà en cours.")
    productionsEnCours.add(p.id)
    // La mise en production prend plusieurs minutes : on répond tout de suite, le suivi arrive par le journal.
    mettreEnProduction(ctx, p.id, qui.email, demande)
      .then((r) => r?.ok === false && noter(ctx.db, { projet: p.id, type: "erreur", message: `Mise en production refusée : ${r.message}` }))
      .catch((e) => console.error("Production (console) :", e.message))
      .finally(() => productionsEnCours.delete(p.id))
    return { ok: true, message: "Mise en production lancée." }
  }],
  ["POST", /^\/api\/projets\/(\d+)\/domaines$/, (ctx, [id], c, qui) => ajouterDomaine(ctx, Number(id), String(c.hote ?? ""), qui.email)],
  ["DELETE", /^\/api\/projets\/(\d+)\/domaines\/([a-z0-9.-]+)$/, (ctx, [id, hote], _c, qui) => retirerDomaine(ctx, Number(id), hote, qui.email)],
  ["POST", /^\/api\/projets\/(\d+)\/apercu\/(prolonger|garder|retirer)$/, (ctx, [id, action], _c, qui) => ({ prolonger: prolongerApercu, garder: garderApercu, retirer: retirerApercu })[action](ctx, Number(id), qui.email)],
  ["POST", /^\/api\/projets\/(\d+)\/supprimer$/, (ctx, [id], c, qui) => {
    if (c.confirme !== true) throw erreur(400, "La suppression doit être confirmée.")
    return supprimerProjet(ctx, Number(id), qui.email)
  }],

  ["POST", /^\/api\/usine\/(stop|reprendre|mettre-a-jour)$/, (ctx, [action], _c, qui) => (action === "stop" ? actions.arreter(ctx, qui.email) : action === "reprendre" ? actions.reprendre(ctx) : mettreAJourUsine(ctx, qui.email))],

  ["GET", /^\/api\/reglages$/, (ctx) => reglages(ctx)],
  ["PUT", /^\/api\/reglages\/couts$/, (ctx, _p, c, qui) => enregistrerCouts(ctx, c, qui)],

  ["GET", /^\/api\/acces$/, async (ctx) => {
    const noms = Object.fromEntries(ctx.db.prepare("SELECT slug, nom FROM projets WHERE slug IS NOT NULL").all().map((p) => [p.slug, p.nom]))
    const [utilisateurs, cles] = await Promise.all([portier("utilisateurs"), portier("cles").catch(() => [])])
    return { utilisateurs, cles: cles.filter((c) => c.actif), noms }
  }],
  ["POST", /^\/api\/acces\/utilisateurs$/, async (_ctx, _p, c, qui) => {
    const email = String(c.email ?? "").trim().toLowerCase()
    // Réinviter un compte existant changerait son rôle en silence : on renvoie son lien à la place.
    if ((await portier("utilisateurs")).some((u) => u.email === email)) throw erreur(409, "Ce compte existe déjà : utilise « Renvoyer l'invitation » dans la liste.")
    const r = await portier("utilisateurs", { methode: "POST", corps: { email: c.email, nom: c.nom ?? null, role: c.role === "admin" ? "admin" : "membre", applis: Array.isArray(c.applis) ? c.applis : [], par: qui.email } })
    // Le lien d'invitation n'est montré qu'à l'administrateur qui invite, pour le transmettre si l'email n'arrive pas.
    const { courrielConfigure, envoyerInvitation } = await import("./courriel.mjs")
    let envoye = false
    if (courrielConfigure()) envoye = await envoyerInvitation({ email: c.email, lien: r.lien, role: c.role, applis: c.applis ?? [], par: qui.email }).then(() => true).catch(() => false)
    return { ok: true, envoye, lien: envoye ? null : r.lien }
  }],
  ["DELETE", /^\/api\/acces\/utilisateurs\/(\d+)$/, async (_ctx, [id], _c, qui) => {
    const tous = await portier("utilisateurs")
    const u = tous.find((x) => x.id === Number(id))
    if (!u) throw erreur(404, "Compte introuvable.")
    if (u.email === qui.email) throw erreur(409, "Tu ne peux pas retirer ton propre accès.")
    if (u.role === "admin" && tous.filter((x) => x.role === "admin" && x.actif).length <= 1) throw erreur(409, "C'est le dernier administrateur : invites-en un autre d'abord.")
    return portier(`utilisateurs/${u.id}`, { methode: "DELETE" })
  }],
  ["POST", /^\/api\/acces\/utilisateurs\/(\d+)\/invitation$/, async (_ctx, [id], _c, qui) => {
    const u = (await portier("utilisateurs")).find((x) => x.id === Number(id))
    if (!u) throw erreur(404, "Compte introuvable.")
    const { lien } = await portier(`utilisateurs/${u.id}/invitation`, { methode: "POST" })
    const { courrielConfigure, envoyerInvitation } = await import("./courriel.mjs")
    const envoye = courrielConfigure() ? await envoyerInvitation({ email: u.email, lien, role: u.role, applis: u.applis, par: qui.email }).then(() => true).catch(() => false) : false
    return { ok: true, envoye, lien: envoye ? null : lien }
  }],
  ["POST", /^\/api\/acces\/cles$/, (_ctx, _p, c, qui) => portier("cles", { methode: "POST", corps: { nom: c.nom, applis: c.applis, par: qui.email } })],
  ["DELETE", /^\/api\/acces\/cles\/(\d+)$/, (_ctx, [id]) => portier(`cles/${Number(id)}`, { methode: "DELETE" })],
]

// --- Serveur -------------------------------------------------------------------------

function envoyerJson(res, code, corps) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...ENTETES })
  res.end(JSON.stringify(corps))
}

async function lireJson(req, max = 200_000) {
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw erreur(415, "JSON attendu.")
  let corps = ""
  for await (const morceau of req) {
    corps += morceau
    if (corps.length > max) throw erreur(413, "Requête trop volumineuse.")
  }
  try {
    return corps ? JSON.parse(corps) : {}
  } catch {
    throw erreur(400, "JSON invalide.")
  }
}

function servirFichier(res, chemin) {
  const cible = normalize(join(STATIQUE, chemin === "/" ? "index.html" : chemin))
  if (!cible.startsWith(STATIQUE.replace(/[\\/]$/, "") + sep) || !existsSync(cible)) return false
  res.writeHead(200, { "content-type": TYPES[extname(cible)] ?? "application/octet-stream", "cache-control": "no-cache", ...ENTETES })
  res.end(readFileSync(cible))
  return true
}

export async function traiter(ctx, req, res) {
  const url = new URL(req.url, "http://console")
  const qui = await quiEstConnecte(req)
  if (!qui?.autorise || qui.role !== "admin") {
    if (url.pathname.startsWith("/api/")) return envoyerJson(res, 403, { erreur: "Accès réservé aux administrateurs de l'usine." })
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" })
    return res.end("Accès réservé aux administrateurs de l'usine.")
  }
  try {
    // Les captures d'écran gardées par l'usine.
    const cap = url.pathname.match(/^\/api\/captures\/(\d+)\/(T\d+)\/([\w.-]+\.png)$/)
    if (cap && req.method === "GET") {
      const f = join(ctx.config.dataDir, "captures", cap[1], cap[2], cap[3])
      if (!existsSync(f)) return envoyerJson(res, 404, { erreur: "Capture introuvable." })
      res.writeHead(200, { "content-type": "image/png", "cache-control": "private, max-age=3600", ...ENTETES })
      return res.end(readFileSync(f))
    }
    const vid = url.pathname.match(/^\/api\/projets\/(\d+)\/video\.mp4$/)
    if (vid && req.method === "GET") {
      const f = fichierVideo(ctx.config, Number(vid[1]))
      if (!existsSync(f)) return envoyerJson(res, 404, { erreur: "Pas encore de vidéo." })
      const contenu = readFileSync(f)
      const plage = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""))
      const nom = url.searchParams.has("telecharger") ? { "content-disposition": `attachment; filename="presentation-${vid[1]}.mp4"` } : {}
      if (plage) {
        const debut = plage[1] ? Number(plage[1]) : Math.max(0, contenu.length - Number(plage[2]))
        const fin = plage[1] && plage[2] ? Math.min(Number(plage[2]), contenu.length - 1) : contenu.length - 1
        if (debut >= contenu.length || debut > fin) return res.writeHead(416, { "content-range": `bytes */${contenu.length}` }).end()
        res.writeHead(206, { "content-type": "video/mp4", "accept-ranges": "bytes", "content-range": `bytes ${debut}-${fin}/${contenu.length}`, "content-length": fin - debut + 1, "cache-control": "private, no-cache", ...nom, ...ENTETES })
        return res.end(contenu.subarray(debut, fin + 1))
      }
      res.writeHead(200, { "content-type": "video/mp4", "accept-ranges": "bytes", "content-length": contenu.length, "cache-control": "private, no-cache", ...nom, ...ENTETES })
      return res.end(contenu)
    }
    if (url.pathname.startsWith("/api/")) {
      const route = ROUTES.find(([m, motif]) => m === req.method && motif.test(url.pathname))
      if (!route) return envoyerJson(res, 404, { erreur: "Route inconnue." })
      let corps = {}
      if (req.method !== "GET") {
        // Une action vient de la console elle-même, jamais d'un autre site.
        const hote = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "")
        const origine = String(req.headers.origin ?? "")
        let hoteOrigine = ""
        try {
          hoteOrigine = new URL(origine).host
        } catch {}
        if (!hoteOrigine || hoteOrigine !== hote) throw erreur(403, "Origine refusée.")
        corps = await lireJson(req, req.method === "POST" && url.pathname === "/api/projets" ? 9_000_000 : 200_000)
        console.log(`Console : ${req.method} ${url.pathname} par ${qui.email}`)
      }
      const r = await route[2](ctx, url.pathname.match(route[1]).slice(1), corps, qui, url)
      if (r && r.ok === false) return envoyerJson(res, 409, { erreur: r.message ?? "Action impossible." })
      return envoyerJson(res, 200, r ?? { ok: true })
    }
    if (url.pathname === "/couts") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...ENTETES })
      return res.end(await pageCouts(ctx))
    }
    if (req.method === "GET" && servirFichier(res, url.pathname)) return
    // Une adresse de la console (#/projets/2…) : la page d'entrée.
    if (req.method === "GET" && !extname(url.pathname) && servirFichier(res, "/")) return
    envoyerJson(res, 404, { erreur: "Introuvable." })
  } catch (error) {
    const code = error.code >= 400 && error.code < 600 ? error.code : 500
    if (code === 500) console.error("Console :", error)
    envoyerJson(res, code, { erreur: code === 500 ? "Erreur de la console." : error.message })
  }
}

export function demarrerConsole(ctx, port = 8091) {
  createServer((req, res) => traiter(ctx, req, res)).listen(port, "0.0.0.0", () => console.log(`Console de l'usine sur le port ${port}.`))
}
