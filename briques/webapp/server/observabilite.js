// L'observabilité du produit : ses erreurs vers Sentry, son pouls vers PostHog.
//
// Côté serveur seulement : la CSP du produit ('self') bloque tout envoi depuis le navigateur.
// Sans dépendance (fetch). Les clés viennent de l'usine (SENTRY_DSN, POSTHOG_TOKEN, POSTHOG_HOTE),
// avec le nom du produit (USINE_PRODUIT), son environnement (USINE_ENVIRONNEMENT : apercu ou
// production) et sa version (USINE_VERSION). Sans clé, ou sous node --test, rien ne part.
// Un envoi ne bloque jamais le produit : tout part en arrière-plan, et une erreur d'envoi est ignorée.
//
// Ce qui part :
//   - les erreurs non attrapées et chaque console.error : le message masqué et la pile ;
//   - toutes les 5 minutes, un événement « pouls » : des COMPTEURS seulement (nombres et
//     booléens), jamais un texte saisi, un nom, une adresse.
//
// Ajouter un compteur au pouls : dans server/demarrage.js, ajouterPouls(() => ({ en_retard: n })).
// Signaler une erreur attrapée : signalerErreur(error, { etape: "relève" }).
// Ne modifie pas ce fichier : le masquage des données personnelles y vit, identique à celui de
// l'usine (commun/observabilite.mjs, vérifié par un test de l'usine).
import { randomUUID } from "node:crypto"
import { inspect } from "node:util"

// --- Ce qui ne sort jamais (mêmes motifs que l'usine) ---------------------------------------
const MASQUES = [
  [/\u001b\[[0-9;?]*[A-Za-z]/g, ""],
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
  [/[A-Za-z0-9_-]{24,}/g, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? "[jeton]" : m)],
]
export const MOTIFS_MASQUES = MASQUES.map(([motif]) => `${motif.source}/${motif.flags}`)

export function nettoyer(texte, max = 1000) {
  let t = typeof texte === "string" ? texte : String(texte ?? "")
  if (t.length > max * 4) t = t.slice(0, max * 4)
  for (const [motif, remplacement] of MASQUES) t = t.replace(motif, remplacement)
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

// Les compteurs du pouls : des nombres et des booléens seulement, sous des noms simples.
export function compteursSurs(valeurs) {
  const surs = {}
  for (const [cle, v] of Object.entries(valeurs ?? {}).slice(0, 60)) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(cle)) continue
    if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "boolean" || v === null) surs[cle] = v
  }
  return surs
}

// --- Sentry ----------------------------------------------------------------------------------
export function lireDsn(dsn) {
  try {
    const u = new URL(String(dsn ?? "").trim())
    const morceaux = u.pathname.split("/").filter(Boolean)
    const projet = morceaux.pop()
    if (!["https:", "http:"].includes(u.protocol) || !u.username || !/^\d+$/.test(projet ?? "")) return null
    const chemin = morceaux.length ? `/${morceaux.join("/")}` : ""
    return { cle: decodeURIComponent(u.username), projet, base: `${u.protocol}//${u.host}${chemin}/api/${projet}` }
  } catch {
    return null
  }
}

function cadresDePile(pile) {
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

// --- L'instance --------------------------------------------------------------------------------
const PERIODE_POULS_MS = 5 * 60_000

export function creerObservabilite({ env = process.env, fetch: fetchFourni = null, delaiMs = 5_000, erreursParHeure = 20, signaler = (t) => console.warn(t) } = {}) {
  const horsReseau = Boolean(env.NODE_TEST_CONTEXT) && !fetchFourni
  const envoyer = fetchFourni ?? globalThis.fetch
  const dsn = horsReseau ? null : lireDsn(env.SENTRY_DSN)
  const jeton = horsReseau ? "" : String(env.POSTHOG_TOKEN ?? "").trim()
  const hoteBrut = env.POSTHOG_HOTE || "eu.i.posthog.com"
  const hote = (/^https?:\/\//.test(hoteBrut) ? hoteBrut : `https://${hoteBrut}`).replace(/\/+$/, "")
  const produit = nettoyer(env.USINE_PRODUIT || "produit", 64)
  const environnement = env.USINE_ENVIRONNEMENT === "apercu" ? "apercu" : env.USINE_ENVIRONNEMENT === "production" ? "production" : "developpement"
  const version = env.USINE_VERSION ? nettoyer(env.USINE_VERSION, 40) : null
  const comptes = { erreurs: { envoyees: 0, echecs: 0, ignorees: 0 }, pouls: { envoyes: 0, echecs: 0 } }
  const vues = new Map()
  let fenetre = { debut: Date.now(), n: 0 }
  let enPauseJusqua = 0
  let injoignable = false

  async function poster(canal, url, corps, entetes) {
    try {
      const res = await envoyer(url, { method: "POST", headers: entetes, body: corps, signal: AbortSignal.timeout(delaiMs) })
      await res.body?.cancel?.().catch(() => {})
      if (res.status === 429 && canal === "erreurs") enPauseJusqua = Date.now() + (Number(res.headers?.get?.("retry-after")) || 60) * 1000
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      comptes[canal][canal === "erreurs" ? "envoyees" : "envoyes"] += 1
      if (injoignable) signaler("Observabilité : envois rétablis.")
      injoignable = false
      return true
    } catch (e) {
      comptes[canal].echecs += 1
      // Signalé une fois, par console.warn : jamais console.error, qui repartirait vers Sentry.
      if (!injoignable) signaler(`Observabilité : envoi impossible (${nettoyer(e?.message ?? e, 200)}) ; les suivants sont ignorés sans bruit.`)
      injoignable = true
      return false
    }
  }

  // Une erreur pour Sentry : une même erreur une fois par heure, 20 par heure au plus (quota gratuit :
  // une erreur qui revient chaque minute coûte 24 envois par jour, pas 1 440).
  function signalerErreur(erreur, { message = null, niveau = "error", gere = true, etiquettes = {} } = {}) {
    if (!dsn || Date.now() < enPauseJusqua) return Promise.resolve(false)
    try {
      const err = erreur instanceof Error ? erreur : null
      const e = { event_id: randomUUID().replaceAll("-", ""), timestamp: Date.now() / 1000, platform: "node", level: niveau, logger: produit, environment: environnement, tags: { produit, service: produit } }
      for (const [k, v] of Object.entries(etiquettes)) if (/^[\w.:-]{1,32}$/.test(k) && ["string", "number", "boolean"].includes(typeof v)) e.tags[k] = nettoyer(String(v), 200)
      if (version) e.release = `${produit}@${version}`
      if (erreur !== null && erreur !== undefined) {
        const cadres = err ? cadresDePile(err.stack) : []
        e.exception = { values: [{ type: nettoyer(err?.name || "Error", 100), value: nettoyer(err ? err.message : versTexte(erreur), 1000) || "(sans message)", ...(cadres.length ? { stacktrace: { frames: cadres } } : {}), mechanism: { type: "generic", handled: gere } }] }
      }
      if (message) e.message = nettoyer(message, 1000)
      if (!e.exception && !e.message) return Promise.resolve(false)
      const v = e.exception?.values[0]
      const cle = [v?.type, v?.value, e.message, v?.stacktrace?.frames.at(-1)?.filename].join("¦").replace(/\d+/g, "#").slice(0, 500)
      const t = Date.now()
      if (t - fenetre.debut > 3_600_000) fenetre = { debut: t, n: 0 }
      if ((vues.get(cle) && t - vues.get(cle) < 60 * 60_000) || fenetre.n >= erreursParHeure) {
        comptes.erreurs.ignorees += 1
        return Promise.resolve(false)
      }
      vues.set(cle, t)
      if (vues.size > 500) vues.delete(vues.keys().next().value)
      fenetre.n += 1
      const corps = JSON.stringify(e)
      const enveloppe = `${JSON.stringify({ event_id: e.event_id, sent_at: new Date().toISOString() })}\n${JSON.stringify({ type: "event", length: new TextEncoder().encode(corps).length, content_type: "application/json" })}\n${corps}\n`
      return poster("erreurs", `${dsn.base}/envelope/`, enveloppe, { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_client=usine-produit/1, sentry_key=${dsn.cle}` })
    } catch {
      return Promise.resolve(false)
    }
  }

  // Le pouls : les compteurs de chaque fonction ajoutée, plus la durée de marche et la mémoire.
  const sources = []
  const ajouterPouls = (fonction) => sources.push(fonction)
  async function envoyerPouls() {
    if (!jeton) return false
    const compteurs = {}
    let echecs = 0
    for (const f of sources) {
      try {
        Object.assign(compteurs, compteursSurs(await f()))
      } catch (e) {
        echecs += 1
        signalerErreur(e, { message: "Pouls : un compteur a échoué" })
      }
    }
    const proprietes = { produit, environnement, ...(version ? { version } : {}), ...compteurs, pouls_echecs: echecs, erreurs_depuis_demarrage: erreursVues, en_marche_s: Math.round(process.uptime()), memoire_mo: Math.round(process.memoryUsage().rss / 1e6), $process_person_profile: false }
    return poster("pouls", `${hote}/batch/`, JSON.stringify({ api_key: jeton, batch: [{ event: "pouls", distinct_id: `produit:${produit}`, timestamp: new Date().toISOString(), properties: proprietes }] }), { "content-type": "application/json" })
  }

  // Au démarrage (server/demarrage.js) : les erreurs du processus, puis le pouls toutes les 5 min.
  // Après une exception non attrapée, le processus s'arrête comme avant (code 1), l'erreur partie.
  let demarre = false
  let erreursVues = 0 // chaque console.error depuis le démarrage : un compteur du pouls
  function demarrer({ premierPoulsMs = 30_000 } = {}) {
    if (demarre || (!dsn && !jeton)) return
    demarre = true
    const ecrire = console.error.bind(console)
    console.error = (...args) => {
      ecrire(...args)
      erreursVues += 1
      if (!dsn) return
      try {
        const err = args.find((a) => a instanceof Error)
        const texte = args.filter((a) => a !== err).map(versTexte).join(" ").trim()
        signalerErreur(err ?? null, { message: texte || null })
      } catch {}
    }
    if (dsn) {
      process.on("uncaughtException", (err, origine) => {
        ecrire(origine === "unhandledRejection" ? "Promesse rejetée sans gestionnaire :" : "Exception non attrapée :", err)
        let fin
        Promise.race([signalerErreur(err, { niveau: "fatal", gere: false }), new Promise((r) => (fin = setTimeout(r, 2_000)))]).finally(() => {
          clearTimeout(fin)
          process.exit(1)
        })
      })
    }
    if (jeton) {
      setTimeout(() => envoyerPouls().catch(() => {}), premierPoulsMs).unref()
      setInterval(() => envoyerPouls().catch(() => {}), PERIODE_POULS_MS).unref()
    }
  }

  return { actif: { sentry: Boolean(dsn), posthog: Boolean(jeton) }, produit, environnement, demarrer, signalerErreur, ajouterPouls, envoyerPouls, etat: () => structuredClone(comptes) }
}

// L'instance du produit.
const instance = creerObservabilite()
export const demarrerObservabilite = (options) => instance.demarrer(options)
export const ajouterPouls = (fonction) => instance.ajouterPouls(fonction)
export const signalerErreur = (erreur, options) => instance.signalerErreur(erreur, options)
