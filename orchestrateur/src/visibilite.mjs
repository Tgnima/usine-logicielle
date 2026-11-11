// La page « Visibilité » de la console : ce qui attend une personne, l'état réel de chaque
// produit, ce que fait l'usine en ce moment, et le bilan des 7 derniers jours.
//
// Sources, toutes en lecture seule :
//   - la base : escalades, tâches, journal (fusion, refus, escalade), consommations ;
//   - /app/etat/sante.json, écrit par le déployeur : serveur et sonde des produits (champ
//     « applications », deployeur/sonde.mjs) ;
//   - /app/etat/statut.json, écrit par le déployeur : le dernier déploiement de chaque produit.
// Rien ici n'écrit dans la base, ne touche à Docker ou n'appelle un service extérieur.
import { readFileSync } from "node:fs"
import { availableParallelism } from "node:os"
import { join } from "node:path"
import { adresses } from "./config.mjs"
import { montant, reglagesCouts, versDevise } from "./couts.mjs"
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
// Une cause de refus tient sur une ligne.
const CAUSE_MAX = 60

const JOUR = new Intl.DateTimeFormat("en-CA", { timeZone: FUSEAU, year: "numeric", month: "2-digit", day: "2-digit" })

// Une date de SQLite (« 2026-11-09 02:25:08 », en temps universel) ou ISO, en Date.
export function dateDe(le) {
  const t = String(le ?? "")
  if (!t) return new Date(NaN)
  return new Date(t.replace(" ", "T") + (/[zZ]$|[+-]\d\d:?\d\d$/.test(t) ? "" : "Z"))
}
const iso = (le) => {
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

// La cause d'un refus : le premier segment du motif, après « motif(s)) : » (fabrique.mjs). Par
// exemple « design », « critère non validé », « problème », « le build échoue ». Un nombre ne
// sépare pas deux causes (« 2 test(s) échouent » et « 3 test(s) échouent » vont ensemble).
export function causeDuRefus(message) {
  const reste = String(message ?? "").split("motif(s)) : ")[1]
  if (!reste) return "autre"
  // Les accents graves viennent du texte pour Slack (« `npm test` échoue ») : sans eux, une même cause se regroupe.
  const segment = reste.split(/\s*:(?:\s|$)|\n/)[0].replace(/`/g, "").replace(/\s*\([^()]*\)\s*$/, "").replace(/\d+/g, "N").trim()
  if (!segment) return "autre"
  return segment.length > CAUSE_MAX ? `${segment.slice(0, CAUSE_MAX - 1).trimEnd()}…` : segment
}

function lireStatut(config) {
  try {
    const s = JSON.parse(readFileSync(join(config.etatDir, "statut.json"), "utf8"))
    return s && typeof s === "object" && !Array.isArray(s) ? s : {}
  } catch {
    return {}
  }
}

// Les projets connus par leur slug (le nom des produits dans sante.json et statut.json).
function projetsParSlug(db) {
  return Object.fromEntries(db.prepare("SELECT id, nom, slug FROM projets WHERE slug IS NOT NULL AND statut != 'supprime'").all().map((p) => [p.slug, { id: p.id, nom: p.nom || p.slug }]))
}

// Le plus grave d'abord ; avec une sonde trop ancienne (tout « inconnu »), la dernière mesure départage.
const GRAVITE = { panne: 0, alerte: 1, inconnu: 2, ok: 3 }
const gravite = (e) => GRAVITE[e] ?? 2
const parGravite = (a, b) => gravite(a.etat) - gravite(b.etat) || gravite(a.etat_mesure) - gravite(b.etat_mesure) || a.nom.localeCompare(b.nom, "fr")

// --- Les produits, d'après la sonde -------------------------------------------------------
// Une carte par produit et par environnement. Une sonde trop ancienne ne dit plus rien de
// l'état présent : chaque carte passe en « inconnu », la dernière mesure reste visible.
function parcProduits(sante, produits, config, maintenant) {
  const a = sante?.applications ?? null
  const age = a?.le ? Math.round((maintenant - dateDe(a.le).getTime()) / 1000) : null
  const sonde = {
    le: iso(a?.le),
    age_s: age,
    // absente : déployeur plus ancien, ou aucun bilan ; muette : Docker n'a pas répondu ; perimee : plus de mesure récente.
    absente: !a,
    muette: Boolean(a) && !a.produits,
    perimee: Boolean(a?.produits) && (age === null || age > SONDE_PERIMEE_S),
  }
  const lignes = Object.entries(a?.produits ?? {}).flatMap(([cle, p]) => {
    const m = /^(apercu|production)\/([a-z0-9-]+)$/.exec(cle)
    if (!m || !p || typeof p !== "object") return []
    const [, environnement, slug] = m
    const projet = produits[slug] ?? null
    const d = p.docker ?? null
    const demarre = d?.demarre_le ? dateDe(d.demarre_le).getTime() : NaN
    return [{
      cle,
      environnement,
      slug,
      projet_id: projet?.id ?? null,
      nom: projet?.nom ?? slug,
      etat: sonde.perimee ? "inconnu" : ["ok", "alerte", "panne", "inconnu"].includes(p.etat) ? p.etat : "inconnu",
      etat_mesure: p.etat ?? null,
      raison: String(p.raison ?? "").slice(0, 300),
      version: p.version ? String(p.version).slice(0, 7) : null,
      demarre_le: iso(d?.demarre_le),
      age_s: Number.isFinite(demarre) ? Math.max(0, Math.round((maintenant - demarre) / 1000)) : null,
      redemarrages: Number.isFinite(d?.redemarrages) ? d.redemarrages : null,
      redemarrages_30_min: Number.isFinite(d?.redemarrages_30_min) ? d.redemarrages_30_min : null,
      reponse_ms: p.http?.code && Number.isFinite(p.http.ms) ? p.http.ms : null,
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

// --- L'usine maintenant ----------------------------------------------------------------
function deploiements(statut, produits, maintenant) {
  const entrees = Object.entries(statut).flatMap(([cle, s]) => {
    const m = /^(apercu|production)\/([a-z0-9-]+)$/.exec(cle)
    if (!m || !s || typeof s !== "object") return []
    const enCours = s.etat === "en_cours"
    const sha = enCours ? s.sha_demande ?? s.sha : s.sha
    // Le message d'un échec : sa première ligne (la suite est une pile d'appels).
    const message = s.message ? String(s.message).split("\n")[0].replace(/\s*:\s*$/, "").slice(0, 300) : null
    return [{
      cle,
      environnement: m[1],
      projet_id: produits[m[2]]?.id ?? null,
      nom: produits[m[2]]?.nom ?? m[2],
      etat: ["ok", "echec", "en_cours"].includes(s.etat) ? s.etat : "inconnu",
      sha: sha ? String(sha).slice(0, 7) : null,
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

function serveur(s, maintenant, processeurs) {
  if (!s) return null
  const age = Math.round((maintenant - dateDe(s.le).getTime()) / 1000)
  const d = s.disque ?? null
  const m = s.memoire ?? null
  const c = Array.isArray(s.charge) ? s.charge.map(Number) : null
  const memPct = m?.total_mo ? Math.round(100 - (m.dispo_mo / m.total_mo) * 100) : null
  const chargePct = c && Number.isFinite(c[0]) && processeurs ? Math.round((c[0] / processeurs) * 100) : null
  return {
    le: iso(s.le),
    perime: !Number.isFinite(age) || age > SONDE_PERIMEE_S,
    disque: d ? { pct: d.pct, libre_go: d.libre_go, total_go: d.total_go, etat: d.pct >= DISQUE.panne ? "panne" : d.pct >= DISQUE.alerte ? "alerte" : "ok" } : null,
    memoire: m ? { pct: memPct, dispo_mo: m.dispo_mo, total_mo: m.total_mo, swap_utilise_mo: m.swap_utilise_mo ?? 0, etat: m.dispo_mo < MEMOIRE_MO.panne ? "panne" : m.dispo_mo < MEMOIRE_MO.alerte ? "alerte" : "ok" } : null,
    charge: c ? { minute: c[0], cinq_minutes: c[1] ?? null, quinze_minutes: c[2] ?? null, processeurs, pct: chargePct, etat: chargePct !== null && chargePct >= CHARGE_ALERTE * 100 ? "alerte" : "ok" } : null,
  }
}

function usineMaintenant(ctx, sante, statut, produits, maintenant, processeurs) {
  const taches = ctx.db.prepare(`SELECT t.cle, t.titre, t.statut, t.tentative, t.approche, t.maj_le, t.projet_id, p.nom
      FROM taches t JOIN projets p ON p.id = t.projet_id WHERE t.statut IN ('en_cours', 'verification') ORDER BY t.maj_le, t.id`).all()
  return {
    taches: taches.map((t) => ({ projet_id: t.projet_id, projet: t.nom ?? `Projet ${t.projet_id}`, cle: t.cle, titre: t.titre, statut: t.statut, tentative: t.tentative, approche: t.approche, depuis: iso(t.maj_le) })),
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
  const noms = Object.fromEntries(Object.values(produits).map((p) => [p.id, p.nom]))
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
  for (const c of db.prepare("SELECT projet_id, cout_api_usd, duree_s, le FROM consommations WHERE le >= ?").all(depuis)) {
    if (!dansLaFenetre(c.le)) continue
    if (c.cout_api_usd === null) inconnu = true
    const l = ligne(c.projet_id)
    l.usd += c.cout_api_usd ?? 0
    l.duree_s += c.duree_s ?? 0
    usd += c.cout_api_usd ?? 0
    duree += c.duree_s ?? 0
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
  }
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
  }
}
