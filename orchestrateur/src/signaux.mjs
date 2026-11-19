// Les signaux de la boucle d'amélioration : ce que Sentry et PostHog disent des applications de
// production, lu par du code, en lecture seule, avec les clés des connecteurs Sentry et PostHog
// (connecteurs.mjs, actifs). Rien n'est jamais écrit chez eux.
//
//   Sentry   toutes les 5 minutes (propositions.mjs, passageBoucle), pour chaque application de
//            production : ses sujets non résolus, dans l'environnement production, avec les
//            étiquettes produit et service égales au produit (module des produits,
//            server/observabilite.js). Les incidents « en panne » du déployeur ont le service
//            usine-deployeur : ils n'y sont pas (la sonde et le pilote les voient déjà). Un sujet
//            nouveau, qui revient ou en hausse, vu dans l'heure, devient un signal.
//   PostHog  au moment d'une proposition : le dernier pouls et ses erreurs depuis le démarrage, le
//            dernier état, les déploiements ratés (24 h), les lignes d'erreur des journaux (1 h).
//
// Un signal ne lance rien : il va à proposer() (propositions.mjs), qui crée ou complète une
// proposition, et seule une personne la lance. Ce module n'importe pas la livraison : il n'a aucun
// moyen de demander une correction.
import { createHash } from "node:crypto"
import { cleConnecteurActif } from "./connecteurs.mjs"
import { valeurService } from "./services.mjs"

const MINUTE_MS = 60_000
const JOUR_MS = 24 * 60 * MINUTE_MS
// Un sujet vu dans l'heure : il se passe encore quelque chose. Plus ancien, il ne déclenche rien
// (à la mise en route, les vieux sujets ne font pas une avalanche de propositions).
export const RECENT_MS = 60 * MINUTE_MS
const DELAI_MS = 15_000
// Sans sous-état (ancienne API), un sujet est « nouveau » s'il est apparu dans la semaine.
const NOUVEAU_MS = 7 * JOUR_MS
// Ce qu'on demande à Sentry pour chaque application : 25 sujets au plus, vus dans les 24 h.
const SUJETS_MAX = "25"
// Une lecture entière de Sentry ne dure pas plus d'une minute : au-delà, les applications restantes
// attendent le passage suivant (chaque appel est déjà borné à DELAI_MS).
const LECTURE_MAX_MS = 60_000
const PERIODE_SENTRY = "24h"
// Les sous-états de Sentry qui font un signal, et leur nom pour une personne.
export const NATURES = { new: "nouvelle", regressed: "revient", escalating: "en hausse" }
// Le nom d'un produit (slug) : la seule valeur qui entre dans une requête Sentry ou PostHog.
export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/

// Un texte venu de Sentry ou de PostHog, sur une ligne, borné, sans balise ni caractère invisible
// (contrôles, largeur nulle, sens d'écriture, étiquettes Unicode) : il est cité dans une consigne et
// dans Slack, il ne doit rien pouvoir y fermer, y ouvrir, ni y cacher.
export const court = (s, n = 200) => String(s ?? "").normalize("NFKC").replace(/[\p{C}\p{Zl}\p{Zp}<>`]/gu, " ").replace(/\s+/g, " ").trim().slice(0, n)
const iso = (x) => {
  const t = Date.parse(x)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
export const lienSur = (x) => {
  try {
    const u = new URL(String(x))
    return u.protocol === "https:" && !u.username && !u.password ? u.href.slice(0, 300) : null
  } catch {
    return null
  }
}

// L'API de Sentry d'après le DSN de l'usine : o<organisation>.ingest[.<région>].sentry.io/<projet>.
// Le jeton de lecture ne part que vers sentry.io : un DSN qui pointe ailleurs (un Sentry hébergé par
// l'entreprise, ou une adresse changée dans la console) n'est pas lu, le jeton ne le suit pas.
export function apiSentry(dsn) {
  let u
  try {
    u = new URL(String(dsn ?? "").trim())
  } catch {
    return null
  }
  const projet = u.pathname.split("/").filter(Boolean).pop()
  if (u.protocol !== "https:" || !/^\d{1,20}$/.test(projet ?? "")) return null
  const m = /^o(\d{1,20})\.ingest\.(?:([a-z]{2})\.)?sentry\.io$/.exec(u.hostname)
  return m ? { base: `https://${m[2] ? `${m[2]}.` : ""}sentry.io/api/0`, organisation: m[1], projet } : null
}

// L'API de PostHog d'après l'hôte d'envoi (POSTHOG_HOTE), dans une liste fermée : la clé personnelle
// ne part que vers PostHog lui-même, jamais vers un relais d'envoi ni une autre adresse.
const API_POSTHOG = { "": "https://eu.posthog.com", "eu.i.posthog.com": "https://eu.posthog.com", "eu.posthog.com": "https://eu.posthog.com", "us.i.posthog.com": "https://us.posthog.com", "us.posthog.com": "https://us.posthog.com", "app.posthog.com": "https://us.posthog.com" }
export function apiPostHog(hote) {
  const h = String(hote ?? "").trim().toLowerCase().replace(/^https:\/\//, "").replace(/\/+$/, "")
  return Object.hasOwn(API_POSTHOG, h) ? API_POSTHOG[h] : null
}

// Sur une liste demandée pour une période (statsPeriod), firstSeen et count ne valent que pour cette
// période : un vieux sujet y paraît récent. lifetime donne la vraie première fois et le vrai total
// (vérifié sur l'API le 19 nov. 2026).
const premiereFois = (s) => s?.lifetime?.firstSeen ?? s?.firstSeen
const total = (s) => s?.lifetime?.count ?? s?.count

// Un sujet Sentry en signal. nature : nouvelle, revient, en hausse.
export function signalSentry(produit, s, nature, maintenant = Date.now()) {
  return {
    source: "sentry",
    produit,
    cle: `sentry:${s.id}`,
    le: new Date(maintenant).toISOString(),
    titre: court(s.title, 160) || "erreur sans titre",
    detail: {
      sujet: court(s.shortId, 40) || null,
      lieu: court(s.culprit, 120) || null,
      occurrences: Math.max(0, Math.round(Number(total(s)) || 0)),
      premiere: iso(premiereFois(s)),
      derniere: iso(s.lastSeen),
      nature,
      lien: lienSur(s.permalink),
    },
  }
}

// Les sujets qui deviennent un signal : non résolu, une erreur (pas un avertissement), nouveau, qui
// revient ou en hausse, et vu dans l'heure. Sans sous-état (ancienne API) : nouveau s'il est apparu
// dans la semaine.
export function signauxSentry(produit, sujets, maintenant = Date.now()) {
  const signaux = []
  for (const s of Array.isArray(sujets) ? sujets : []) {
    if (!s || !/^\d{1,20}$/.test(String(s.id ?? ""))) continue
    if (s.status && s.status !== "unresolved") continue
    if (!["error", "fatal"].includes(s.level)) continue
    const derniere = Date.parse(s.lastSeen)
    if (!Number.isFinite(derniere) || maintenant - derniere > RECENT_MS) continue
    const premiere = Date.parse(premiereFois(s))
    const nature = s.substatus ? NATURES[s.substatus] : Number.isFinite(premiere) && maintenant - premiere < NOUVEAU_MS ? NATURES.new : null
    if (!nature) continue
    signaux.push(signalSentry(produit, s, nature, maintenant))
  }
  return signaux
}

// Ce que la console montre de la lecture : la dernière fois, et ce qui n'a pas marché (jamais la clé).
const lecture = () => ({ sentry: { ok: null, le: null, message: "pas encore lu", applications: 0 }, posthog: { ok: null, le: null, message: "pas encore lu" } })
let etat = lecture()
// Le projet PostHog trouvé, rangé par adresse, empreinte de la clé et jeton d'envoi : une autre clé le recherche.
const projetsPostHog = new Map()
const empreinte = (cle) => createHash("sha256").update(String(cle)).digest("hex").slice(0, 16)
export function oublierSources() {
  etat = lecture()
  projetsPostHog.clear()
}
function noterLecture(source, ok, message, maintenant, extra = {}) {
  etat[source] = { ...etat[source], ok, le: new Date(maintenant).toISOString(), message: court(message, 160), ...extra }
}

// Les valeurs en service : celles de la console, sinon celles du serveur (services.mjs).
const enService = (ctx, nom) => {
  try {
    return valeurService(ctx, nom).valeur || ""
  } catch {
    return ""
  }
}

// Pour la console : branchée ou non, et la dernière lecture.
export function etatSources(ctx, { dsn = enService(ctx, "SENTRY_DSN"), hote = enService(ctx, "POSTHOG_HOTE") } = {}) {
  const sentry = Boolean(cleConnecteurActif(ctx, "sentry")) && Boolean(apiSentry(dsn))
  const posthog = Boolean(cleConnecteurActif(ctx, "posthog")) && Boolean(apiPostHog(hote))
  return { sentry: { branche: sentry, ...etat.sentry }, posthog: { branche: posthog, ...etat.posthog } }
}

// Un appel en lecture : jeton en en-tête, délai borné, aucune redirection suivie (le jeton ne part
// jamais vers un autre hôte). L'erreur ne dit que le code de réponse.
async function appeler(url, cle, { corps = null, fetch: f = fetch } = {}) {
  const res = await f(url, {
    method: corps ? "POST" : "GET",
    headers: { authorization: `Bearer ${cle}`, accept: "application/json", ...(corps ? { "content-type": "application/json" } : {}) },
    ...(corps ? { body: JSON.stringify(corps) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(DELAI_MS),
  })
  if (!res.ok) throw new Error(`réponse ${res.status}${res.status === 401 || res.status === 403 ? " (clé refusée ou droits insuffisants)" : ""}`)
  return res.json()
}

// Les sujets Sentry de chaque application de production (produits : leurs slugs). Renvoie
// { signaux, vus } ; vus sert à la mesure après une correction : pour chaque sujet vu dans les
// 24 h, son dernier passage et son signal (« revient »), { <id du sujet>: { derniere, signal } }.
// Jamais d'exception : une lecture ratée est notée pour la console, et ne rend rien.
export async function lireSentry(ctx, produits, { maintenant = Date.now(), fetch: f = fetch, dsn = enService(ctx, "SENTRY_DSN") } = {}) {
  const vide = { signaux: [], vus: {} }
  const cle = cleConnecteurActif(ctx, "sentry")
  const api = apiSentry(dsn)
  if (!cle || !api) {
    noterLecture("sentry", false, !cle ? "connecteur Sentry inactif ou sans jeton" : "DSN Sentry absent, ou hors de sentry.io", maintenant, { applications: 0 })
    return vide
  }
  const liste = [...new Set(produits)].filter((p) => SLUG.test(p))
  const signaux = []
  const vus = {}
  const limite = Date.now() + LECTURE_MAX_MS
  let lues = 0
  try {
    for (const produit of liste) {
      if (Date.now() > limite) break
      lues += 1
      const params = new URLSearchParams({ project: api.projet, environment: "production", statsPeriod: PERIODE_SENTRY, limit: SUJETS_MAX, query: `is:unresolved produit:${produit} service:${produit}` })
      const sujets = await appeler(`${api.base}/organizations/${api.organisation}/issues/?${params}`, cle, { fetch: f })
      signaux.push(...signauxSentry(produit, sujets, maintenant))
      for (const s of Array.isArray(sujets) ? sujets : []) {
        const derniere = Date.parse(s?.lastSeen)
        if (/^\d{1,20}$/.test(String(s?.id ?? "")) && Number.isFinite(derniere)) vus[String(s.id)] = { derniere, signal: signalSentry(produit, s, NATURES.regressed, maintenant) }
      }
    }
  } catch (e) {
    noterLecture("sentry", false, `lecture impossible : ${e.message}`, maintenant, { applications: 0 })
    return vide
  }
  const reste = liste.length - lues
  noterLecture("sentry", true, `${lues} application(s) lue(s)${reste ? `, ${reste} au prochain passage (lecture trop longue)` : ""}, ${signaux.length} erreur(s) à signaler`, maintenant, { applications: lues })
  return { signaux, vus }
}

// Le projet PostHog de l'usine : celui du jeton d'envoi (posthog_token), sinon le seul que la clé voit.
async function projetPostHog(base, cle, f, jeton) {
  const cleCache = `${base} ${empreinte(cle)} ${jeton}`
  if (projetsPostHog.has(cleCache)) return projetsPostHog.get(cleCache)
  let id = null
  try {
    const r = await appeler(`${base}/api/projects/`, cle, { fetch: f })
    const liste = Array.isArray(r?.results) ? r.results : []
    id = (liste.find((p) => jeton && p?.api_token === jeton) ?? (liste.length === 1 ? liste[0] : null))?.id ?? null
  } catch {}
  if (!id) id = (await appeler(`${base}/api/projects/@current/`, cle, { fetch: f }))?.id ?? null
  if (!/^\d{1,20}$/.test(String(id ?? ""))) throw new Error("projet PostHog introuvable (la clé doit voir le projet de l'usine)")
  projetsPostHog.set(cleCache, String(id))
  return String(id)
}

async function hogql(base, projet, cle, requete, f) {
  const r = await appeler(`${base}/api/projects/${projet}/query/`, cle, { corps: { query: { kind: "HogQLQuery", query: requete }, name: "usine-boucle-amelioration" }, fetch: f })
  const colonnes = Array.isArray(r?.columns) ? r.columns : []
  const ligne = Array.isArray(r?.results?.[0]) ? r.results[0] : []
  return Object.fromEntries(colonnes.map((c, i) => [c, ligne[i] ?? null]))
}

// Les requêtes du contexte d'un produit. Les journaux sont sur une autre grappe que les événements
// chez PostHog : deux requêtes. Le slug est vérifié (SLUG) ici même, avant d'entrer dans la requête.
export function requetesPostHog(produit) {
  if (!SLUG.test(String(produit ?? ""))) throw new Error("nom de produit refusé")
  return requetes(produit)
}
const requetes = (produit) => ({
  evenements: `SELECT maxIf(timestamp, event = 'pouls') AS dernier_pouls, argMaxIf(properties.erreurs_depuis_demarrage, timestamp, event = 'pouls') AS erreurs_depuis_demarrage, maxIf(timestamp, event = 'etat_produit') AS dernier_etat, countIf(event = 'deploiement' AND properties.resultat != 'ok') AS deploiements_rates FROM events WHERE timestamp > now() - INTERVAL 1 DAY AND distinct_id = 'produit:${produit}' AND properties.environnement = 'production'`,
  journaux: `SELECT countIf(severity_text IN ('error', 'fatal')) AS erreurs, countIf(severity_text = 'warn') AS avertissements FROM logs WHERE timestamp > now() - INTERVAL 1 HOUR AND service_name = '${produit}' AND resource_attributes.\`deployment.environment\` = 'production'`,
})

const nombre = (x) => (x === null || x === undefined || x === "" || !Number.isFinite(Number(x)) ? null : Math.round(Number(x)))
const date = (x) => {
  // ClickHouse rend « 1970-01-01 00:00:00 » quand rien n'a été vu.
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(String(x ?? "")) ? x : `${String(x ?? "").replace(" ", "T")}Z`)
  return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : null
}

// Les chiffres de PostHog pour un produit, ou null (connecteur inactif, lecture ratée). Jamais d'exception.
export async function contextePostHog(ctx, produit, { fetch: f = fetch, hote = enService(ctx, "POSTHOG_HOTE"), jeton = enService(ctx, "POSTHOG_TOKEN"), maintenant = Date.now() } = {}) {
  if (!SLUG.test(String(produit ?? ""))) return null
  const cle = cleConnecteurActif(ctx, "posthog")
  const base = apiPostHog(hote)
  if (!cle || !base) {
    noterLecture("posthog", false, !cle ? "connecteur PostHog inactif ou sans clé" : "région PostHog hors de la liste (eu ou us) : la clé ne part pas ailleurs", maintenant)
    return null
  }
  try {
    const projet = await projetPostHog(base, cle, f, jeton)
    const q = requetesPostHog(produit)
    const e = await hogql(base, projet, cle, q.evenements, f)
    const j = await hogql(base, projet, cle, q.journaux, f).catch(() => null)
    noterLecture("posthog", true, `chiffres de ${produit} lus`, maintenant)
    return {
      dernier_pouls: date(e.dernier_pouls),
      erreurs_depuis_demarrage: nombre(e.erreurs_depuis_demarrage),
      dernier_etat: date(e.dernier_etat),
      deploiements_rates_24h: nombre(e.deploiements_rates),
      lignes_erreur_1h: j ? nombre(j.erreurs) : null,
      lignes_avertissement_1h: j ? nombre(j.avertissements) : null,
      le: new Date(maintenant).toISOString(),
    }
  } catch (e) {
    noterLecture("posthog", false, `lecture impossible : ${e.message}`, maintenant)
    return null
  }
}
