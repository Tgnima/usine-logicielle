// L'observabilité de l'usine : Sentry (erreurs, incidents, battement de cœur) et PostHog
// (événements, journaux), sans dépendance : fetch seul. Le même fichier sert l'orchestrateur et
// le déployeur ; leurs images le copient en /commun, au même endroit relatif que dans le dépôt.
//
//   Sentry   les erreurs au format envelope (POST <hôte>/api/<projet>/envelope/), le battement
//            de cœur par l'API cron HTTP (<hôte>/api/<projet>/cron/<moniteur>/<clé>/). L'hôte vient
//            du DSN : en région européenne, o<org>.ingest.de.sentry.io.
//   PostHog  les événements par /batch/, les journaux au format OTLP JSON par /i/v1/logs.
//            Région européenne par défaut : eu.i.posthog.com.
//
// Trois règles :
//   - jamais bloquant : tout est mis en file et part par lots, en arrière-plan, avec des délais
//     courts. Une file pleine perd ses plus vieux éléments ; une erreur d'envoi est comptée,
//     jamais levée ni réessayée ;
//   - rien de personnel ne sort : tout texte passe par nettoyer() (adresses email, téléphones,
//     IBAN, adresses IP, jetons et clés masqués, longueur limitée), et un événement ne porte que
//     des valeurs simples (nombres, booléens, textes courts nettoyés) ;
//   - sans clé, rien ne part. Sous node --test non plus, sauf si le test fournit son propre fetch.
import { randomUUID } from "node:crypto"
import { inspect } from "node:util"

// --- Ce qui ne sort jamais ----------------------------------------------------------------
// L'ordre compte : les jetons et les identifiants d'une adresse avant les adresses email
// (« x-access-token:ghs_…@github.com »), les adresses email avant les téléphones.
const MASQUES = [
  [/\u001b\[[0-9;?]*[A-Za-z]/g, ""], // couleurs du terminal
  [/[\u0000-\u0008\u000b-\u001f\u007f]/g, ""],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abeoprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9_-]{16,}|ph[cx]_[A-Za-z0-9]{16,}|usp_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16})/g, "[secret]"],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, "[secret]"],
  [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [secret]"],
  [/\b(pass(?:word|wd)?|mot_de_passe|mdp|secret|token|jeton|api[_-]?key|apikey|authorization|cookie|dsn)(["']?\s*[:=]\s*["']?)(?!\[secret\])[^\s"'&,;]+/gi, "$1$2[secret]"],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[secret]@"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, "[email]"],
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g, "[iban]"],
  [/(?<![\w+])(?:\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}|0[1-9](?:[\s.-]?\d{2}){4})(?!\w)/g, "[téléphone]"],
  [/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g, "[ip]"],
  [/\b(?:[0-9a-f]{1,4}:){4,7}[0-9a-f]{1,4}\b/gi, "[ip]"],
  [/(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,5})?(?![\w:])/gi, (m) => (m.length > 2 ? "[ip]" : m)],
  // Un jeton aléatoire (lien public d'un produit, identifiant de session, UUID) : 24 caractères
  // ou plus, lettres ET chiffres. Un nom de conteneur ou de fichier (sans chiffre) reste lisible.
  [/[A-Za-z0-9_-]{24,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? "[jeton]" : m)],
]
// Les motifs, pour vérifier que la copie des produits (briques/webapp/server/observabilite.js) masque pareil.
export const MOTIFS_MASQUES = MASQUES.map(([motif]) => `${motif.source}/${motif.flags}`)

// Un texte qui peut sortir : masqué, sans caractères de contrôle, limité à max caractères.
export function nettoyer(texte, max = 1000) {
  let t = typeof texte === "string" ? texte : String(texte ?? "")
  if (t.length > max * 4) t = t.slice(0, max * 4) // le coût des motifs reste borné
  for (const [motif, remplacement] of MASQUES) t = t.replace(motif, remplacement)
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// Les propriétés d'un événement : des valeurs simples seulement, les textes nettoyés et courts.
// Un objet, un tableau ou une fonction ne sort jamais (il pourrait porter n'importe quoi).
export function proprietesSures(proprietes, { maxTexte = 200 } = {}) {
  const sures = {}
  for (const [cle, valeur] of Object.entries(proprietes ?? {}).slice(0, 60)) {
    if (!/^[\w.$-]{1,64}$/.test(cle)) continue
    if (typeof valeur === "number") {
      if (Number.isFinite(valeur)) sures[cle] = valeur
    } else if (typeof valeur === "boolean" || valeur === null) sures[cle] = valeur
    else if (typeof valeur === "string") sures[cle] = nettoyer(valeur, maxTexte)
  }
  return sures
}

// Les étiquettes Sentry : des textes de 200 caractères au plus, des clés simples.
function etiquettesSures(etiquettes) {
  const sures = {}
  for (const [cle, valeur] of Object.entries(etiquettes ?? {})) {
    if (valeur === undefined || valeur === null || valeur === "" || !/^[\w.:-]{1,32}$/.test(cle)) continue
    if (["string", "number", "boolean"].includes(typeof valeur)) sures[cle] = nettoyer(String(valeur), 200)
  }
  return sures
}

// --- Sentry -------------------------------------------------------------------------------
// https://<clé publique>@<hôte>/<projet>  ->  { cle, projet, base: https://<hôte>/api/<projet> }
export function lireDsn(dsn) {
  try {
    const u = new URL(String(dsn ?? "").trim())
    const morceaux = u.pathname.split("/").filter(Boolean)
    const projet = morceaux.pop()
    if (!["https:", "http:"].includes(u.protocol) || !u.username || !/^\d+$/.test(projet ?? "")) return null
    const chemin = morceaux.length ? `/${morceaux.join("/")}` : ""
    return { cle: decodeURIComponent(u.username), projet, hote: u.host, base: `${u.protocol}//${u.host}${chemin}/api/${projet}` }
  } catch {
    return null
  }
}

// Les cadres d'une pile V8, de l'appelant à l'appelé (le dernier est celui de l'erreur), 50 au plus.
export function cadresDePile(pile) {
  const cadres = []
  for (const ligne of String(pile ?? "").split("\n")) {
    const m = /^\s*at (?:(?:async )?(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(ligne)
    if (!m) continue
    const fichier = nettoyer(m[2].replace(/^file:\/\//, ""), 300)
    cadres.push({ function: nettoyer(m[1] ?? "?", 200), filename: fichier, abs_path: fichier, lineno: Number(m[3]), colno: Number(m[4]), in_app: !/node_modules|^node:|^internal\//.test(fichier) })
    if (cadres.length >= 50) break
  }
  return cadres.reverse()
}

const versTexte = (x) => (typeof x === "string" ? x : inspect(x, { depth: 2, breakLength: Infinity }))

// Un événement Sentry : une erreur (exception) ou un message (incident). Rien d'autre n'y entre
// que le type, le message nettoyé, la pile, le niveau et les étiquettes.
export function evenementSentry({ erreur = null, message = null, niveau = "error", service, environnement, version = null, etiquettes = {}, empreinte = null, gere = true, maintenant = Date.now() }) {
  const e = { event_id: randomUUID().replaceAll("-", ""), timestamp: maintenant / 1000, platform: "node", level: niveau, logger: service, environment: environnement, tags: etiquettesSures({ service, ...etiquettes }) }
  if (version) e.release = `${service}@${version}`
  if (erreur !== null && erreur !== undefined) {
    const err = erreur instanceof Error ? erreur : null
    const cadres = err ? cadresDePile(err.stack) : []
    e.exception = { values: [{ type: nettoyer(err?.name || "Error", 100), value: nettoyer(err ? err.message : versTexte(erreur), 1000) || "(sans message)", ...(cadres.length ? { stacktrace: { frames: cadres } } : {}), mechanism: { type: "generic", handled: gere } }] }
  }
  if (message) e.message = nettoyer(message, 1000)
  if (!e.exception && !e.message) e.message = "(sans message)"
  if (empreinte?.length) e.fingerprint = empreinte.map((x) => nettoyer(String(x), 200))
  return e
}

export function enveloppe(evenement, maintenant = new Date()) {
  const corps = JSON.stringify(evenement)
  const entete = { event_id: evenement.event_id, sent_at: maintenant.toISOString() }
  return `${JSON.stringify(entete)}\n${JSON.stringify({ type: "event", length: new TextEncoder().encode(corps).length, content_type: "application/json" })}\n${corps}\n`
}

// --- PostHog : les journaux (OTLP JSON) -----------------------------------------------------
// L'heure d'une ligne en nanosecondes (texte), à partir d'un horodatage ISO (jusqu'à 9 décimales,
// comme docker logs --timestamps) ou d'un nombre de millisecondes.
export function nanos(horodatage) {
  if (typeof horodatage === "string") {
    const ms = Date.parse(horodatage)
    if (!Number.isNaN(ms)) {
      const fraction = (/T[\d:]+\.(\d+)/.exec(horodatage)?.[1] ?? "").padEnd(9, "0").slice(0, 9)
      return (BigInt(Math.floor(ms / 1000)) * 1_000_000_000n + BigInt(fraction)).toString()
    }
  }
  const ms = typeof horodatage === "number" && Number.isFinite(horodatage) ? horodatage : Date.now()
  return (BigInt(Math.round(ms)) * 1_000_000n).toString()
}

const GRAVITES = { debug: [5, "DEBUG"], info: [9, "INFO"], warn: [13, "WARN"], error: [17, "ERROR"], fatal: [21, "FATAL"] }
function attributsOtlp(objet) {
  return Object.entries(objet).flatMap(([key, v]) => {
    if (typeof v === "string") return [{ key, value: { stringValue: v } }]
    if (typeof v === "boolean") return [{ key, value: { boolValue: v } }]
    if (typeof v === "number") return [{ key, value: Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v } }]
    return []
  })
}

// Les lignes regroupées par service et environnement : une ressource OTLP chacune.
export function corpsJournaux(lignes, maintenant = Date.now()) {
  const groupes = new Map()
  for (const l of lignes) {
    const cle = `${l.service}\u0000${l.environnement}\u0000${l.version ?? ""}`
    if (!groupes.has(cle)) groupes.set(cle, { service: l.service, environnement: l.environnement, version: l.version, lignes: [] })
    groupes.get(cle).lignes.push(l)
  }
  const observe = nanos(maintenant)
  return {
    resourceLogs: [...groupes.values()].map((g) => ({
      resource: { attributes: attributsOtlp({ "service.name": g.service, "deployment.environment": g.environnement, ...(g.version ? { "service.version": g.version } : {}) }) },
      scopeLogs: [{
        scope: { name: "usine-logicielle" },
        logRecords: g.lignes.map((l) => {
          const [numero, texte] = GRAVITES[l.niveau] ?? GRAVITES.info
          return { timeUnixNano: l.t, observedTimeUnixNano: observe, severityNumber: numero, severityText: texte, body: { stringValue: l.texte }, attributes: attributsOtlp(l.attributs ?? {}) }
        }),
      }],
    })),
  }
}

// --- L'instance -----------------------------------------------------------------------------
const MAX_EVENEMENTS = 2000
const MAX_JOURNAUX = 5000
const MAX_ERREURS = 50

export function creerObservabilite({
  sentryDsn = "",
  posthogJeton = "",
  posthogHote = "eu.i.posthog.com",
  service,
  environnement = "production",
  version = null, // un texte, ou une fonction qui le donne au moment de l'envoi
  fetch: fetchFourni = null,
  intervalleMs = 10_000,
  delaiMs = 5_000,
  erreursParHeure = 20,
  signaler = (texte) => console.warn(texte),
} = {}) {
  // Sous node --test, rien ne part vers les vrais services.
  const horsReseau = Boolean(process.env.NODE_TEST_CONTEXT) && !fetchFourni
  const envoyer = fetchFourni ?? globalThis.fetch
  const dsn = horsReseau ? null : lireDsn(sentryDsn)
  const jeton = horsReseau ? "" : String(posthogJeton ?? "").trim()
  const hote = (/^https?:\/\//.test(posthogHote) ? posthogHote : `https://${posthogHote}`).replace(/\/+$/, "")
  const laVersion = () => {
    try {
      return (typeof version === "function" ? version() : version) || null
    } catch {
      return null
    }
  }
  const auth = dsn ? `Sentry sentry_version=7, sentry_client=usine-logicielle/1, sentry_key=${dsn.cle}` : ""

  const files = { erreurs: [], evenements: [], journaux: [] }
  const comptes = Object.fromEntries(["erreurs", "evenements", "journaux", "battement"].map((c) => [c, { envoyes: 0, echecs: 0, perdus: 0, ignores: 0, joignable: null, dernier_echec: null }]))
  let minuterie = null
  let vidage = null
  let sentryEnPauseJusqua = 0
  const vues = new Map() // empreinte d'une erreur -> dernier envoi (doublons : une fois par heure)
  let fenetre = { debut: Date.now(), n: 0 }

  const demarrer = () => {
    if (minuterie) return
    minuterie = setInterval(() => vider().catch(() => {}), intervalleMs)
    minuterie.unref?.() // ne retient jamais le processus
  }
  const pousser = (canal, element, max) => {
    const file = files[canal]
    if (file.length >= max) {
      file.shift()
      comptes[canal].perdus += 1
    }
    file.push(element)
    demarrer()
  }
  // Une erreur d'envoi est comptée ; elle n'est signalée qu'au changement (joignable ou non), par
  // signaler() : jamais console.error, que brancherProcessus() renverrait vers Sentry.
  const LIBELLES = { erreurs: "erreurs (Sentry)", evenements: "événements (PostHog)", journaux: "journaux (PostHog)", battement: "battements de cœur (Sentry)" }
  const constater = (canal, ok, n, detail = "") => {
    const c = comptes[canal]
    if (ok) {
      if (c.joignable === false) signaler(`Observabilité : ${LIBELLES[canal]} de nouveau envoyés.`)
      c.envoyes += n
    } else {
      if (c.joignable !== false) signaler(`Observabilité : envoi des ${LIBELLES[canal]} impossible (${nettoyer(detail, 200)}) ; les suivants sont ignorés sans bruit jusqu'au retour.`)
      c.echecs += n
      c.dernier_echec = { le: new Date().toISOString(), detail: nettoyer(detail, 200) }
    }
    c.joignable = ok
  }
  async function poster(canal, url, corps, entetes, n) {
    try {
      const res = await envoyer(url, { method: "POST", headers: entetes, body: corps, signal: AbortSignal.timeout(delaiMs) })
      await res.body?.cancel?.().catch(() => {})
      if (res.status === 429 && canal === "erreurs") sentryEnPauseJusqua = Date.now() + (Number(res.headers?.get?.("retry-after")) || 60) * 1000
      constater(canal, res.ok, n, res.ok ? "" : `HTTP ${res.status}`)
      return res.ok
    } catch (e) {
      constater(canal, false, n, e?.name === "TimeoutError" ? `pas de réponse en ${delaiMs} ms` : e?.message ?? String(e))
      return false
    }
  }

  // Un lot par canal à chaque passage ; ce qui reste part au passage suivant.
  function vider() {
    if (vidage) return vidage
    vidage = (async () => {
      const envois = []
      if (files.evenements.length) {
        const lot = files.evenements.splice(0, 500)
        envois.push(poster("evenements", `${hote}/batch/`, JSON.stringify({ api_key: jeton, batch: lot }), { "content-type": "application/json" }, lot.length))
      }
      if (files.journaux.length) {
        const lot = files.journaux.splice(0, 1000)
        envois.push(poster("journaux", `${hote}/i/v1/logs`, JSON.stringify(corpsJournaux(lot)), { "content-type": "application/json", authorization: `Bearer ${jeton}` }, lot.length))
      }
      if (files.erreurs.length && Date.now() >= sentryEnPauseJusqua) {
        // Une erreur par enveloppe (le format n'en admet qu'une) : 10 au plus par passage.
        const lot = files.erreurs.splice(0, 10)
        envois.push((async () => {
          for (const e of lot) await poster("erreurs", `${dsn.base}/envelope/`, enveloppe(e), { "content-type": "application/x-sentry-envelope", "x-sentry-auth": auth }, 1)
        })())
      }
      await Promise.allSettled(envois)
    })().finally(() => {
      vidage = null
    })
    return vidage
  }

  // Les doublons d'une même erreur ne partent qu'une fois par heure, et 20 erreurs par heure au
  // plus : le plan gratuit de Sentry (5 000 par mois) ne se vide pas sur une boucle d'erreurs.
  function admettre(cle) {
    const t = Date.now()
    if (t - fenetre.debut > 3_600_000) fenetre = { debut: t, n: 0 }
    const vue = vues.get(cle)
    if ((vue && t - vue < 60 * 60_000) || fenetre.n >= erreursParHeure) {
      comptes.erreurs.ignores += 1
      return false
    }
    vues.set(cle, t)
    if (vues.size > 500) vues.delete(vues.keys().next().value)
    fenetre.n += 1
    return true
  }

  // Une erreur (exception) ou un incident (message) pour Sentry. environnement : celui de
  // l'instance, ou celui d'un produit (un incident du déployeur sur un aperçu, par exemple).
  function erreur(err, { message = null, niveau = "error", etiquettes = {}, empreinte = null, gere = true, environnement: env = environnement } = {}) {
    if (!dsn) return false
    try {
      const e = evenementSentry({ erreur: err, message, niveau, service, environnement: env, version: laVersion(), etiquettes, empreinte, gere })
      const v = e.exception?.values[0]
      const cle = [empreinte?.join("|") ?? "", v?.type ?? "", v?.value ?? "", e.message ?? "", v?.stacktrace?.frames.at(-1)?.filename ?? ""].join("¦").replace(/\d+/g, "#").slice(0, 500)
      if (!admettre(cle)) return false
      pousser("erreurs", e, MAX_ERREURS)
      return true
    } catch {
      return false
    }
  }
  const incident = (message, options = {}) => erreur(null, { niveau: "error", ...options, message })

  // Un événement PostHog : sans profil de personne, avec des propriétés simples seulement.
  function evenement(nom, proprietes = {}, { distinctId = null, horodatage = null } = {}) {
    if (!jeton) return false
    try {
      const v = laVersion()
      pousser("evenements", {
        event: nettoyer(nom, 100),
        distinct_id: nettoyer(distinctId ?? service, 200),
        timestamp: new Date(horodatage ?? Date.now()).toISOString(),
        properties: { service, environnement, ...(v ? { version: v } : {}), ...proprietesSures(proprietes), $process_person_profile: false },
      }, MAX_EVENEMENTS)
      return true
    } catch {
      return false
    }
  }

  // Une ligne de journal pour PostHog. service et environnement : ceux de l'instance, ou ceux
  // d'un produit (le déployeur envoie les journaux de chaque conteneur).
  function journal(texte, { niveau = "info", horodatage = Date.now(), service: s = service, environnement: env = environnement, version: v = laVersion(), attributs = {} } = {}) {
    if (!jeton) return false
    try {
      pousser("journaux", { t: nanos(horodatage), niveau: GRAVITES[niveau] ? niveau : "info", texte: nettoyer(texte, 2000), service: nettoyer(s, 100), environnement: nettoyer(env, 50), version: v ? nettoyer(v, 50) : null, attributs: proprietesSures(attributs) }, MAX_JOURNAUX)
      return true
    } catch {
      return false
    }
  }

  // Le battement de cœur (moniteur cron de Sentry), envoyé tout de suite, sans attendre. Le
  // moniteur est créé ou mis à jour par l'envoi lui-même (monitor_config) : rien à régler à la main.
  function battement(moniteur, { statut = "ok", planning = "* * * * *", marge = 2, dureeMax = 2, seuilPanne = 2 } = {}) {
    if (!dsn) return Promise.resolve(false)
    const corps = { status: statut, monitor_config: { schedule: { type: "crontab", value: planning }, checkin_margin: marge, max_runtime: dureeMax, timezone: "UTC", failure_issue_threshold: seuilPanne, recovery_threshold: 1 } }
    return poster("battement", `${dsn.base}/cron/${encodeURIComponent(moniteur)}/${encodeURIComponent(dsn.cle)}/`, JSON.stringify(corps), { "content-type": "application/json" }, 1)
  }

  // Tout envoyer avant de s'arrêter (au plus limiteMs). La minuterie de l'attente n'est pas
  // détachée : après une exception non attrapée, elle garde le processus jusqu'à process.exit(1).
  async function arreter(limiteMs = 3_000) {
    if (minuterie) clearInterval(minuterie)
    minuterie = null
    const fin = Date.now() + limiteMs
    while (Date.now() < fin && (files.evenements.length || files.journaux.length || (files.erreurs.length && Date.now() >= sentryEnPauseJusqua))) {
      let attente
      await Promise.race([vider(), new Promise((r) => (attente = setTimeout(r, Math.max(0, fin - Date.now()))))])
      clearTimeout(attente)
    }
  }

  // Les erreurs du processus : console.error, et les exceptions non attrapées (une promesse
  // rejetée sans gestionnaire en devient une : comportement par défaut de Node, gardé). Après
  // une exception non attrapée, le processus s'arrête comme avant (code 1), une fois l'erreur partie.
  let branche = false
  function brancherProcessus() {
    if (!dsn || branche) return
    branche = true
    const ecrire = console.error.bind(console)
    console.error = (...args) => {
      ecrire(...args)
      try {
        const err = args.find((a) => a instanceof Error)
        const texte = args.filter((a) => a !== err).map(versTexte).join(" ").trim()
        if (err) erreur(err, { message: texte || null })
        else if (texte) incident(texte)
      } catch {}
    }
    process.on("uncaughtException", (err, origine) => {
      ecrire(origine === "unhandledRejection" ? "Promesse rejetée sans gestionnaire :" : "Exception non attrapée :", err)
      erreur(err, { niveau: "fatal", gere: false, etiquettes: { origine } })
      arreter(2_000).finally(() => process.exit(1))
    })
  }

  const etat = () => ({ sentry: Boolean(dsn), posthog: Boolean(jeton), files: Object.fromEntries(Object.entries(files).map(([k, f]) => [k, f.length])), ...structuredClone(comptes) })

  return { actif: { sentry: Boolean(dsn), posthog: Boolean(jeton) }, erreur, incident, evenement, journal, battement, vider, arreter, brancherProcessus, etat }
}
