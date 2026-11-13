// Les services que la console branche en plus des IA : Sentry et PostHog.
//
// Un registre À PART des IDENTIFIANTS de fournisseurs.mjs : ceux-là partent dans l'environnement
// de chaque travail de l'atelier et du vérificateur, où tourne le code des produits. Les clés
// d'ici n'y vont jamais ; chacune déclare qui la reçoit (destinataires), et rien d'autre ne la lit.
//
// Trois états par clé :
//   - posée dans la console : chiffrée dans le coffre, comme les clés des IA (fournisseurs.mjs) ;
//   - coupée : une valeur vide explicite, qui l'emporte sur celle du serveur (« Couper l'envoi ») ;
//   - absente : la valeur du serveur (secrets.sh) sert, comme avant.
// Une valeur saisie n'est jamais renvoyée : seulement ses 4 derniers caractères, la date et l'auteur.
import { lireDsn } from "../../commun/observabilite.mjs"
import { secret } from "./config.mjs"
import { ecrireReglage, lireReglage } from "./couts.mjs"
import { noter } from "./db.mjs"
import { chiffrer, dechiffrer } from "./fournisseurs.mjs"
import { MONITEUR, obs, reglerObservabilite } from "./observabilite.mjs"

const erreur = (code, message, extra = {}) => Object.assign(new Error(message), { code, ...extra })

// --- Les formats ------------------------------------------------------------------------------
// Chaque validation renvoie la valeur à garder (nettoyée), ou lève une erreur lisible.
// horsUE : la valeur est valable, mais ses données partiraient hors d'Europe (confirmation exigée).

export function validerDsn(brut) {
  const v = String(brut ?? "").trim()
  if (/^sntry[su]_/.test(v)) throw erreur(400, "C'est un jeton de lecture Sentry : il sert aux IA pour lire les erreurs (Réglages, Connecteurs). Ici, il faut la clé d'envoi (DSN), qui commence par https://.")
  const d = lireDsn(v)
  if (!d) throw erreur(400, "Ce n'est pas une clé d'envoi Sentry. Elle commence par https:// et finit par un numéro de projet. Sur Sentry : Settings, Projects, ton projet, Client Keys (DSN).")
  if (!v.startsWith("https://")) throw erreur(400, "La clé d'envoi doit commencer par https:// : sinon les erreurs voyageraient en clair.")
  return { valeur: v, horsUE: !/(^|\.)de\.sentry\.io$/.test(d.hote) }
}

export function validerJetonPosthog(brut) {
  const v = String(brut ?? "").trim()
  if (/^phx_/.test(v)) throw erreur(400, "C'est une clé personnelle PostHog : elle ouvre tout ton compte. Ici, il faut le jeton du projet (il commence par phc_), qui ne sert qu'à envoyer.")
  if (!/^phc_[A-Za-z0-9_-]{20,200}$/.test(v)) throw erreur(400, "Ce n'est pas un jeton de projet PostHog : il commence par phc_. Sur PostHog : Settings, Project, Project token.")
  return { valeur: v, horsUE: false }
}

// eu.i.posthog.com (défaut), us.i.posthog.com, ou l'adresse d'un relais (proxy) de l'entreprise.
export function validerHotePosthog(brut) {
  const v = String(brut ?? "").trim().replace(/^https:\/\//, "").replace(/\/+$/, "").toLowerCase()
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+(:\d{2,5})?$/.test(v)) throw erreur(400, "Région PostHog : choisis Europe ou États-Unis, ou indique l'adresse de ton relais (par exemple ph.mon-entreprise.fr).")
  return { valeur: v, horsUE: v === "us.i.posthog.com" || v === "app.posthog.com" }
}

// --- Le registre ------------------------------------------------------------------------------
// destinataires : qui reçoit la clé. Pour l'instant l'orchestrateur seul ; le déployeur et les
// applications gardent la valeur du serveur.
export const CLES_SERVICES = {
  SENTRY_DSN: { service: "sentry", libelle: "Clé d'envoi Sentry (DSN)", secret: true, serveur: () => secret("sentry_dsn"), valider: validerDsn, destinataires: ["orchestrateur"] },
  POSTHOG_TOKEN: { service: "posthog", libelle: "Jeton de projet PostHog", secret: true, serveur: () => secret("posthog_token"), valider: validerJetonPosthog, destinataires: ["orchestrateur"] },
  POSTHOG_HOTE: { service: "posthog", libelle: "Région PostHog", secret: false, serveur: () => process.env.POSTHOG_HOTE ?? "", defaut: "eu.i.posthog.com", valider: validerHotePosthog, destinataires: ["orchestrateur"] },
}
// La clé principale de chaque service : celle que « Couper l'envoi » vide.
export const SERVICES = {
  sentry: { libelle: "Sentry", principale: "SENTRY_DSN" },
  posthog: { libelle: "PostHog", principale: "POSTHOG_TOKEN" },
}

const cleReglage = (nom) => `service_${nom}`
function entree(ctx, nom) {
  try {
    return JSON.parse(lireReglage(ctx.db, cleReglage(nom), "null"))
  } catch {
    return null
  }
}

// La valeur qui sert vraiment, et d'où elle vient : console, coupe, serveur, defaut ou aucune.
// Une valeur de la console illisible (coffre verrouillé) laisse servir celle du serveur.
export function valeurService(ctx, nom) {
  const def = CLES_SERVICES[nom]
  if (!def) throw erreur(400, "Réglage inconnu.")
  const e = entree(ctx, nom)
  let illisible = false
  if (e?.coupe) return { valeur: "", source: "coupe" }
  if (e && def.secret && e.iv) {
    try {
      return { valeur: dechiffrer(ctx, e), source: "console" }
    } catch {
      illisible = true
    }
  } else if (e && !def.secret && typeof e.valeur === "string") return { valeur: e.valeur, source: "console" }
  const serveur = String(def.serveur() ?? "").trim()
  if (serveur) return { valeur: serveur, source: "serveur", illisible }
  if (def.defaut) return { valeur: def.defaut, source: "defaut", illisible }
  return { valeur: "", source: "aucune", illisible }
}

// Appliquer à l'orchestrateur ce qui sert vraiment : tout de suite, sans redémarrage.
export function appliquerServices(ctx, regler = reglerObservabilite) {
  const v = (nom) => {
    const r = valeurService(ctx, nom)
    if (r.illisible) console.error(`Services : ${CLES_SERVICES[nom].libelle} illisible (coffre verrouillé ?) ; la valeur du serveur sert.`)
    return r.valeur
  }
  return regler({ sentryDsn: v("SENTRY_DSN"), posthogJeton: v("POSTHOG_TOKEN"), posthogHote: v("POSTHOG_HOTE") })
}

export function poserService(ctx, nom, valeur, par, { confirme = false } = {}, regler = reglerObservabilite) {
  const def = CLES_SERVICES[nom]
  if (!def) throw erreur(400, "Réglage inconnu.")
  if (String(valeur ?? "").length > 2000) throw erreur(400, `${def.libelle} : valeur trop longue.`)
  const { valeur: v, horsUE } = def.valider(valeur)
  if (horsUE && confirme !== true) throw erreur(409, `${def.libelle} : les données partiraient hors d'Europe. Crée plutôt un projet en région européenne, ou confirme pour garder ce choix.`, { horsUE: true })
  const quand = { le: new Date().toISOString(), par }
  ecrireReglage(ctx.db, cleReglage(nom), JSON.stringify(def.secret ? { ...chiffrer(ctx, v), fin: v.slice(-4), ...quand } : { valeur: v, ...quand }))
  noter(ctx.db, { projet: null, type: "reglage", message: `${def.libelle} posée dans la console par ${par}${horsUE ? " (hors d'Europe, confirmé)" : ""}` })
  appliquerServices(ctx, regler)
  return { ok: true, message: `${def.libelle} enregistrée : l'usine s'en sert dès maintenant. Le déployeur et les applications gardent pour l'instant celle du serveur.` }
}

// Retirer ce que la console a posé (valeur ou coupure) : la valeur du serveur reprend.
export function retirerService(ctx, nom, par, regler = reglerObservabilite) {
  const def = CLES_SERVICES[nom]
  if (!def) throw erreur(400, "Réglage inconnu.")
  ctx.db.prepare("DELETE FROM reglages WHERE cle = ?").run(cleReglage(nom))
  noter(ctx.db, { projet: null, type: "reglage", message: `${def.libelle} retirée de la console par ${par}` })
  appliquerServices(ctx, regler)
  const reprend = valeurService(ctx, nom).source === "serveur"
  return { ok: true, message: reprend ? `${def.libelle} retirée : la valeur du serveur reprend.` : `${def.libelle} retirée.` }
}

// Couper l'envoi : une valeur vide explicite, qui l'emporte aussi sur celle du serveur.
export function couperService(ctx, service, par, regler = reglerObservabilite) {
  const s = SERVICES[service]
  if (!s) throw erreur(400, "Service inconnu.")
  ecrireReglage(ctx.db, cleReglage(s.principale), JSON.stringify({ coupe: true, le: new Date().toISOString(), par }))
  noter(ctx.db, { projet: null, type: "reglage", message: `${s.libelle} : envoi coupé dans la console par ${par}` })
  appliquerServices(ctx, regler)
  return { ok: true, message: `${s.libelle} : plus rien n'est envoyé par l'usine. « Retirer » rend la main à la valeur du serveur.` }
}

// --- Tester -----------------------------------------------------------------------------------
// Sans dépense et sans bruit : pour Sentry, le battement de cœur habituel (aucun sujet créé) ;
// pour PostHog, la lecture des drapeaux, qui refuse un jeton inconnu (/batch/ accepte tout).
// Réponses constatées le 13 nov. 2026 : Sentry 403 pour une clé inconnue, 400 pour une clé mal
// formée ; PostHog 401 pour un jeton inconnu.
export function traduireEchec(service, detail) {
  const d = String(detail ?? "")
  const code = Number(/HTTP (\d{3})/.exec(d)?.[1]) || null
  const nom = SERVICES[service]?.libelle ?? service
  if (/pas de réponse|timeout|délai/i.test(d)) return `${nom} ne répond pas depuis le serveur (délai dépassé) : réessaie dans quelques minutes.`
  if (code === 401 || code === 403) return service === "posthog" ? "PostHog refuse ce jeton dans cette région : vérifie le jeton, ou la région (Europe ou États-Unis)." : "Sentry refuse cette clé : elle a été supprimée ou désactivée, ou le projet n'existe plus."
  if (code === 400) return `${nom} ne reconnaît pas cette clé : elle a sans doute été copiée incomplète.`
  if (code === 429) return `${nom} : quota atteint. Les envois reprendront d'eux-mêmes au prochain cycle de facturation.`
  if (code) return `${nom} a répondu par une erreur (HTTP ${code}).`
  return `${nom} est injoignable depuis le serveur (${d.slice(0, 120) || "erreur réseau"}).`
}

const cleTest = (service) => `test_service_${service}`
function lireTest(ctx, service) {
  try {
    return JSON.parse(lireReglage(ctx.db, cleTest(service), "null"))
  } catch {
    return null
  }
}

export async function testerService(ctx, service, { instance = obs, fetch: envoyer = globalThis.fetch, delaiMs = 8_000 } = {}) {
  if (!SERVICES[service]) throw erreur(400, "Service inconnu.")
  let r
  if (service === "sentry") {
    if (!instance.actif.sentry) r = { ok: false, message: "Aucune clé Sentry en service : colle d'abord la clé d'envoi." }
    else {
      await instance.battement(MONITEUR).catch(() => false)
      const b = instance.etat().battement
      r = b.joignable ? { ok: true, message: `Sentry a bien reçu le signal de l'usine (moniteur ${MONITEUR}).` } : { ok: false, message: traduireEchec("sentry", b.dernier_echec?.detail) }
    }
  } else {
    const jeton = valeurService(ctx, "POSTHOG_TOKEN").valeur
    const hote = valeurService(ctx, "POSTHOG_HOTE").valeur || "eu.i.posthog.com"
    if (!jeton) r = { ok: false, message: "Aucun jeton PostHog en service : colle d'abord le jeton du projet." }
    else if (process.env.NODE_TEST_CONTEXT && envoyer === globalThis.fetch) r = { ok: false, message: "Hors réseau (tests)." }
    else {
      try {
        const res = await envoyer(`https://${hote}/flags/?v=2`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ api_key: jeton, distinct_id: "usine-test" }), signal: AbortSignal.timeout(delaiMs) })
        await res.body?.cancel?.().catch(() => {})
        r = res.ok ? { ok: true, message: `PostHog reconnaît ce jeton (${hote}).` } : { ok: false, message: traduireEchec("posthog", `HTTP ${res.status}`) }
      } catch (e) {
        r = { ok: false, message: traduireEchec("posthog", e?.name === "TimeoutError" ? "pas de réponse" : e?.message) }
      }
    }
  }
  ecrireReglage(ctx.db, cleTest(service), JSON.stringify({ le: new Date().toISOString(), ok: r.ok, message: r.message }))
  return r
}

// --- Ce que la console affiche (jamais une valeur secrète) ------------------------------------
const CANAUX = { sentry: ["battement", "erreurs"], posthog: ["evenements", "journaux"] }
export function etatServices(ctx, instance = obs) {
  const etat = instance.etat()
  return {
    services: Object.entries(SERVICES).map(([id, s]) => ({
      id,
      libelle: s.libelle,
      actif: Boolean(instance.actif[id]),
      cles: Object.entries(CLES_SERVICES).filter(([, d]) => d.service === id).map(([nom, d]) => {
        const e = entree(ctx, nom)
        const { valeur, source, illisible } = valeurService(ctx, nom)
        const horsUE = valeur ? (() => {
          try {
            return d.valider(valeur).horsUE
          } catch {
            return null
          }
        })() : null
        return {
          nom, libelle: d.libelle, secret: d.secret, source, illisible: Boolean(illisible), hors_ue: horsUE,
          console: e && !e.coupe ? { fin: d.secret ? e.fin : null, le: e.le, par: e.par } : null,
          coupe: e?.coupe ? { le: e.le, par: e.par } : null,
          serveur: Boolean(String(d.serveur() ?? "").trim()),
          // Une valeur publique (la région) se montre ; une valeur secrète, jamais.
          valeur: d.secret ? null : valeur,
          destinataires: d.destinataires,
        }
      }),
      envoi: Object.fromEntries(CANAUX[id].map((c) => [c, { envoyes: etat[c].envoyes, echecs: etat[c].echecs, joignable: etat[c].joignable, dernier_ok: etat[c].dernier_ok, dernier_echec: etat[c].dernier_echec ? { le: etat[c].dernier_echec.le, message: traduireEchec(id, etat[c].dernier_echec.detail) } : null }])),
      test: lireTest(ctx, id),
    })),
  }
}
