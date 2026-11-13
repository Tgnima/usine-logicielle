// Les services que la console branche en plus des IA : Sentry et PostHog.
//
// Un registre À PART des IDENTIFIANTS de fournisseurs.mjs : ceux-là partent dans l'environnement
// de chaque travail de l'atelier et du vérificateur, où tourne le code des produits. Les clés
// d'ici n'y vont jamais ; chacune déclare qui la reçoit (destinataires), et rien d'autre ne la lit.
//
// Vers le déployeur et les applications, elles passent par la boîte : un volume en mémoire vive
// (tmpfs), que l'orchestrateur écrit et que le déployeur lit (deployeur/boite.mjs). Elle ne
// contient que les clés destinées au déployeur ou aux applications, posées ou coupées dans la
// console ; une clé absente de la boîte laisse servir la valeur du serveur.
//
// Trois états par clé :
//   - posée dans la console : chiffrée dans le coffre, comme les clés des IA (fournisseurs.mjs) ;
//   - coupée : une valeur vide explicite, qui l'emporte sur celle du serveur (« Couper l'envoi ») ;
//   - absente : la valeur du serveur (secrets.sh) sert, comme avant.
// Une valeur saisie n'est jamais renvoyée : seulement ses 4 derniers caractères, la date et l'auteur.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { lireDsn } from "../../commun/observabilite.mjs"
import { secret } from "./config.mjs"
import { ecrireReglage, lireReglage } from "./couts.mjs"
import { noter } from "./db.mjs"
import { chiffrer, dechiffrer } from "./fournisseurs.mjs"
import { redemanderEtat } from "./github.mjs"
import { MONITEUR, obs, reglerObservabilite } from "./observabilite.mjs"
import { envoyerEssai, reglerCourriel, verifierCourriel } from "./courriel.mjs"
import { PASSERELLE } from "./moteurs.mjs"

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

const ligne = (v) => String(v ?? "").trim()
const sansEspace = (libelle, min = 8) => (brut) => {
  const v = ligne(brut)
  if (v.length < min || /\s/.test(v)) throw erreur(400, `${libelle} : la valeur semble incomplète (pas d'espace, au moins ${min} caractères).`)
  return { valeur: v, horsUE: false }
}
export function validerHoteSmtp(brut) {
  const v = ligne(brut).toLowerCase()
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(v)) throw erreur(400, "Serveur d'envoi : une adresse comme smtp.mon-fournisseur.fr, sans https:// ni port.")
  return { valeur: v, horsUE: false }
}
export function validerPortSmtp(brut) {
  const v = ligne(brut)
  if (!/^\d{2,5}$/.test(v) || Number(v) > 65535) throw erreur(400, "Port : un nombre, d'habitude 587 (ou 465).")
  return { valeur: v, horsUE: false }
}
export function validerSecuriteSmtp(brut) {
  const v = ligne(brut)
  if (!["0", "1"].includes(v)) throw erreur(400, "Sécurité : STARTTLS (port 587) ou TLS direct (port 465).")
  return { valeur: v, horsUE: false }
}
export function validerExpediteur(brut) {
  const v = ligne(brut)
  if (v.length > 200 || /[\r\n]/.test(v) || !/^([^<>@]{0,100}<)?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(v)) throw erreur(400, "Expéditeur : une adresse, ou « Nom <adresse> ».")
  return { valeur: v, horsUE: false }
}
export function validerJetonBot(brut) {
  const v = ligne(brut)
  if (/^xapp-/.test(v)) throw erreur(400, "C'est le jeton de l'application (xapp-). Ici, il faut le jeton du bot, qui commence par xoxb-.")
  if (!/^xoxb-[A-Za-z0-9-]{20,}$/.test(v)) throw erreur(400, "Jeton du bot Slack : il commence par xoxb- (OAuth & Permissions, Bot User OAuth Token).")
  return { valeur: v, horsUE: false }
}
export function validerJetonApp(brut) {
  const v = ligne(brut)
  if (/^xoxb-/.test(v)) throw erreur(400, "C'est le jeton du bot (xoxb-). Ici, il faut le jeton de l'application, qui commence par xapp-.")
  if (!/^xapp-[A-Za-z0-9-]{20,}$/.test(v)) throw erreur(400, "Jeton de l'application Slack : il commence par xapp- (Basic Information, App-Level Tokens, avec connections:write).")
  return { valeur: v, horsUE: false }
}
export function validerCanal(brut) {
  const v = ligne(brut)
  if (!/^[CG][A-Z0-9]{8,12}$/.test(v)) throw erreur(400, "Canal : son identifiant, qui commence par C (dans Slack : clic droit sur le canal, Copier le lien, la fin de l'adresse).")
  return { valeur: v, horsUE: false }
}
export function validerAdmins(brut) {
  const ids = ligne(brut).split(/[\s,]+/).filter(Boolean)
  if (ids.includes("*")) throw erreur(400, "« * » donnerait les droits à tout l'espace Slack : nomme plutôt les personnes.")
  if (!ids.length || ids.some((x) => !/^[UW][A-Z0-9]{8,12}$/.test(x))) throw erreur(400, "Administrateurs : leurs identifiants Slack, qui commencent par U, séparés par des virgules (profil, ⋮, Copier l'identifiant du membre).")
  return { valeur: [...new Set(ids)].join(","), horsUE: false }
}

// --- Le registre ------------------------------------------------------------------------------
// destinataires : qui reçoit la clé (orchestrateur, deployeur, applications). Seules celles qui vont
// au déployeur ou aux applications entrent dans la boîte.
const TOUS = ["orchestrateur", "deployeur", "applications"]
export const CLES_SERVICES = {
  SENTRY_DSN: { service: "sentry", libelle: "Clé d'envoi Sentry (DSN)", secret: true, serveur: () => secret("sentry_dsn"), valider: validerDsn, destinataires: TOUS },
  POSTHOG_TOKEN: { service: "posthog", libelle: "Jeton de projet PostHog", secret: true, serveur: () => secret("posthog_token"), valider: validerJetonPosthog, destinataires: TOUS },
  POSTHOG_HOTE: { service: "posthog", libelle: "Région PostHog", secret: false, serveur: () => process.env.POSTHOG_HOTE ?? "", defaut: "eu.i.posthog.com", valider: validerHotePosthog, destinataires: TOUS },
  // L'envoi d'emails : un bloc. Si le serveur d'envoi est posé dans la console, tout le bloc vient
  // de la console (un champ absent y est vide) : jamais l'hôte de l'une avec le mot de passe de l'autre.
  SMTP_HOST: { service: "smtp", libelle: "Serveur d'envoi", secret: false, serveur: () => process.env.SMTP_HOST ?? "", valider: validerHoteSmtp, destinataires: TOUS },
  SMTP_PORT: { service: "smtp", libelle: "Port", secret: false, serveur: () => process.env.SMTP_PORT ?? "", valider: validerPortSmtp, destinataires: TOUS },
  SMTP_SECURE: { service: "smtp", libelle: "Sécurité", secret: false, serveur: () => process.env.SMTP_SECURE ?? "", valider: validerSecuriteSmtp, destinataires: TOUS },
  EMAIL_EXPEDITEUR: { service: "smtp", libelle: "Expéditeur", secret: false, serveur: () => process.env.EMAIL_EXPEDITEUR ?? "", valider: validerExpediteur, destinataires: TOUS },
  SMTP_USER: { service: "smtp", libelle: "Identifiant", secret: true, serveur: () => secret("smtp_user"), valider: sansEspace("Identifiant", 3), destinataires: TOUS },
  SMTP_PASS: { service: "smtp", libelle: "Mot de passe", secret: true, serveur: () => secret("smtp_pass"), valider: sansEspace("Mot de passe", 6), destinataires: TOUS },
  // La passerelle IA des applications : une clé à elles, jamais celle des agents. Sans elle, les
  // applications gardent la clé commune du serveur (comme avant).
  AI_GATEWAY_API_KEY_APPLIS: { service: "passerelle", libelle: "Clé de passerelle des applications", secret: true, serveur: () => "", valider: sansEspace("Clé de passerelle", 20), destinataires: ["applications"] },
  // Slack : pour l'orchestrateur seul, jamais dans la boîte.
  SLACK_BOT_TOKEN: { service: "slack", libelle: "Jeton du bot (xoxb-)", secret: true, serveur: () => secret("slack_bot_token"), valider: validerJetonBot, destinataires: ["orchestrateur"] },
  SLACK_APP_TOKEN: { service: "slack", libelle: "Jeton de l'application (xapp-)", secret: true, serveur: () => secret("slack_app_token"), valider: validerJetonApp, destinataires: ["orchestrateur"] },
  SLACK_CANAL: { service: "slack", libelle: "Canal", secret: false, serveur: (ctx) => ctx?.config?.serveur?.slackCanal ?? "", valider: validerCanal, destinataires: ["orchestrateur"] },
  ADMIN_USER_IDS: { service: "slack", libelle: "Administrateurs", secret: false, serveur: (ctx) => ctx?.config?.serveur?.slackAdmins ?? "", valider: validerAdmins, destinataires: ["orchestrateur"] },
}
// La clé principale de chaque service : celle que « Couper l'envoi » vide.
export const SERVICES = {
  sentry: { libelle: "Sentry", principale: "SENTRY_DSN" },
  posthog: { libelle: "PostHog", principale: "POSTHOG_TOKEN" },
  smtp: { libelle: "L'envoi d'emails", principale: "SMTP_HOST" },
  passerelle: { libelle: "La passerelle des applications", principale: "AI_GATEWAY_API_KEY_APPLIS" },
  slack: { libelle: "Slack", principale: "SLACK_BOT_TOKEN" },
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
  const serveur = String(def.serveur(ctx) ?? "").trim()
  if (serveur) return { valeur: serveur, source: "serveur", illisible }
  if (def.defaut) return { valeur: def.defaut, source: "defaut", illisible }
  return { valeur: "", source: "aucune", illisible }
}

// L'envoi d'emails en un bloc : celui de la console si son serveur d'envoi y est posé (ou coupé),
// sinon null (le serveur). Un champ que la console n'a pas posé y est vide.
export function blocCourriel(ctx) {
  const hote = valeurService(ctx, "SMTP_HOST")
  if (hote.source !== "console" && hote.source !== "coupe") return null
  const c = (nom) => {
    const r = valeurService(ctx, nom)
    return r.source === "console" ? r.valeur : ""
  }
  return { hote: hote.valeur, port: c("SMTP_PORT"), securite: c("SMTP_SECURE"), expediteur: c("EMAIL_EXPEDITEUR"), utilisateur: c("SMTP_USER"), motDePasse: c("SMTP_PASS") }
}

// Slack : les valeurs qui servent, dans la configuration de l'orchestrateur (lue à chaque message).
function reglerSlackConfig(ctx) {
  if (!ctx.config?.secrets) return
  ctx.config.secrets.slackBot = valeurService(ctx, "SLACK_BOT_TOKEN").valeur
  ctx.config.secrets.slackApp = valeurService(ctx, "SLACK_APP_TOKEN").valeur
  ctx.config.slack = { ...(ctx.config.slack ?? {}), canal: valeurService(ctx, "SLACK_CANAL").valeur, admins: valeurService(ctx, "ADMIN_USER_IDS").valeur.split(",").map((s) => s.trim()).filter(Boolean) }
}

// --- La boîte vers le déployeur -----------------------------------------------------------------
// version : un compteur, augmenté à chaque changement fait dans la console. Le déployeur note dans
// statut.json la version reçue par chaque conteneur : jamais une empreinte des valeurs (une
// empreinte courte d'un mot de passe se casserait hors ligne).
export const versionBoite = (ctx) => Number(lireReglage(ctx.db, "boite_version", "0")) || 0
const changerVersion = (ctx) => ecrireReglage(ctx.db, "boite_version", String(versionBoite(ctx) + 1))

// Le contenu : les clés posées (leur valeur) ou coupées (vide) dans la console, pour le déployeur
// et les applications. Une clé illisible (coffre verrouillé) n'y entre pas : le serveur sert.
export function contenuBoite(ctx) {
  const cles = {}
  for (const [nom, d] of Object.entries(CLES_SERVICES)) {
    if (!d.destinataires.some((x) => x === "deployeur" || x === "applications")) continue
    const { valeur, source } = valeurService(ctx, nom)
    if (source === "console" || source === "coupe") cles[nom] = valeur
  }
  return { version: versionBoite(ctx), le: new Date().toISOString(), cles }
}

let boiteAbsente = false
// dossier : config.boiteDir (BOITE_DIR, /app/boite par défaut) ; sans dossier (tests), rien n'est écrit.
export function ecrireBoite(ctx, dossier = ctx.config?.boiteDir) {
  if (!dossier) return false
  try {
    mkdirSync(dossier, { recursive: true, mode: 0o700 })
    const fichier = join(dossier, "deployeur.json")
    writeFileSync(`${fichier}.tmp`, JSON.stringify(contenuBoite(ctx)), { mode: 0o600 })
    renameSync(`${fichier}.tmp`, fichier)
    boiteAbsente = false
    return true
  } catch (e) {
    // Une installation sans le volume (docker-compose.yml d'avant) : le serveur sert, on le dit une fois.
    if (!boiteAbsente) console.log(`Boîte du déployeur indisponible (${e.code ?? e.message}) : le déployeur garde les clés du serveur.`)
    boiteAbsente = true
    return false
  }
}

// Appliquer ce qui sert vraiment : à l'orchestrateur tout de suite, au déployeur par la boîte.
export function appliquerServices(ctx, regler = reglerObservabilite, { boite = true } = {}) {
  const v = (nom) => {
    const r = valeurService(ctx, nom)
    if (r.illisible) console.error(`Services : ${CLES_SERVICES[nom].libelle} illisible (coffre verrouillé ?) ; la valeur du serveur sert.`)
    return r.valeur
  }
  const change = regler({ sentryDsn: v("SENTRY_DSN"), posthogJeton: v("POSTHOG_TOKEN"), posthogHote: v("POSTHOG_HOTE") })
  reglerCourriel(blocCourriel(ctx))
  reglerSlackConfig(ctx)
  if (boite) ecrireBoite(ctx)
  return change
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
  changerVersion(ctx)
  appliquerServices(ctx, regler)
  apresChangement(ctx, nom)
  return { ok: true, message: messagePose(def) }
}

// Ce que dit la console après une pose : qui s'en sert, et quand.
function messagePose(def) {
  const d = def.destinataires
  if (def.service === "slack") return `${def.libelle} enregistré${def.secret ? "" : "(s)"} : Slack se reconnecte avec les réglages de la console.`
  if (!d.includes("orchestrateur")) return `${def.libelle} enregistrée : les applications la recevront à leur prochaine mise en ligne, ou par « Appliquer ».`
  return `${def.libelle} enregistré(e) : l'usine s'en sert dès maintenant, le déployeur dans la minute. Les applications le recevront à leur prochaine mise en ligne, ou par « Appliquer ».`
}
// Slack ne relit pas ses jetons en marche : sa connexion se rouvre (index.mjs, ctx.relancerSlack).
function apresChangement(ctx, nom) {
  if (CLES_SERVICES[nom]?.service !== "slack" || !["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"].includes(nom)) return
  Promise.resolve(ctx.relancerSlack?.()).catch((e) => console.error("Slack (relance) :", e.message))
}

// Retirer ce que la console a posé (valeur ou coupure) : la valeur du serveur reprend.
export function retirerService(ctx, nom, par, regler = reglerObservabilite) {
  const def = CLES_SERVICES[nom]
  if (!def) throw erreur(400, "Réglage inconnu.")
  ctx.db.prepare("DELETE FROM reglages WHERE cle = ?").run(cleReglage(nom))
  noter(ctx.db, { projet: null, type: "reglage", message: `${def.libelle} retirée de la console par ${par}` })
  changerVersion(ctx)
  appliquerServices(ctx, regler)
  apresChangement(ctx, nom)
  const reprend = valeurService(ctx, nom).source === "serveur"
  return { ok: true, message: reprend ? `${def.libelle} retirée : la valeur du serveur reprend.` : `${def.libelle} retirée.` }
}

// Couper l'envoi : une valeur vide explicite, qui l'emporte aussi sur celle du serveur.
export function couperService(ctx, service, par, regler = reglerObservabilite) {
  const s = SERVICES[service]
  if (!s) throw erreur(400, "Service inconnu.")
  ecrireReglage(ctx.db, cleReglage(s.principale), JSON.stringify({ coupe: true, le: new Date().toISOString(), par }))
  noter(ctx.db, { projet: null, type: "reglage", message: `${s.libelle} : coupé dans la console par ${par}` })
  changerVersion(ctx)
  appliquerServices(ctx, regler)
  apresChangement(ctx, s.principale)
  return { ok: true, message: `${s.libelle} : coupé, même avec la valeur du serveur. « Retirer » rend la main au serveur.` }
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

// Une erreur d'envoi d'email en clair (codes de nodemailer).
export function traduireEchecSmtp(e) {
  const code = e?.code ?? ""
  if (code === "EAUTH" || e?.responseCode === 535) return "Le serveur d'envoi refuse l'identifiant ou le mot de passe."
  if (["ECONNECTION", "ECONNREFUSED", "EDNS", "ENOTFOUND"].includes(code)) return "Le serveur d'envoi est introuvable ou refuse la connexion : vérifie son adresse et son port."
  if (code === "ETIMEDOUT" || /timeout/i.test(e?.message ?? "")) return "Le serveur d'envoi ne répond pas (délai dépassé) : vérifie le port (587 ou 465) et la sécurité."
  if (code === "ETLS" || /ssl|tls|wrong version/i.test(e?.message ?? "")) return "La sécurité ne correspond pas au port : STARTTLS va avec 587, TLS direct avec 465."
  return `L'envoi d'emails ne marche pas (${String(e?.message ?? e).slice(0, 120)}).`
}

// Un email d'essai, à l'administrateur qui le demande.
export async function essaiCourriel(ctx, email, envoyerEmail = envoyerEssai) {
  try {
    await envoyerEmail(email)
    noter(ctx.db, { projet: null, type: "reglage", message: `Email d'essai envoyé à ${email}` })
    return { ok: true, message: `Email d'essai envoyé à ${email} : vérifie ta boîte (et les indésirables).` }
  } catch (e) {
    return { ok: false, message: traduireEchecSmtp(e) }
  }
}

export async function testerService(ctx, service, options = {}) {
  const { instance = obs, fetch: envoyer = globalThis.fetch, delaiMs = 8_000 } = options
  if (!SERVICES[service]) throw erreur(400, "Service inconnu.")
  let r
  if (service === "sentry") {
    if (!instance.actif.sentry) r = { ok: false, message: "Aucune clé Sentry en service : colle d'abord la clé d'envoi." }
    else {
      await instance.battement(MONITEUR).catch(() => false)
      const b = instance.etat().battement
      r = b.joignable ? { ok: true, message: `Sentry a bien reçu le signal de l'usine (moniteur ${MONITEUR}).` } : { ok: false, message: traduireEchec("sentry", b.dernier_echec?.detail) }
    }
  } else if (service === "smtp") {
    try {
      if (!valeurService(ctx, "SMTP_HOST").valeur) r = { ok: false, message: "Aucun serveur d'envoi : renseigne d'abord le serveur, le port et l'expéditeur." }
      else {
        await (options.verifier ?? verifierCourriel)()
        r = { ok: true, message: "Le serveur d'envoi accepte la connexion et les identifiants. Tu peux t'envoyer un email d'essai." }
      }
    } catch (e) {
      r = { ok: false, message: traduireEchecSmtp(e) }
    }
  } else if (service === "slack") {
    const bot = valeurService(ctx, "SLACK_BOT_TOKEN").valeur
    if (!bot) r = { ok: false, message: "Aucun jeton de bot : colle d'abord le jeton xoxb-." }
    else if (process.env.NODE_TEST_CONTEXT && envoyer === globalThis.fetch) r = { ok: false, message: "Hors réseau (tests)." }
    else {
      try {
        const res = await envoyer("https://slack.com/api/auth.test", { method: "POST", headers: { authorization: `Bearer ${bot}` }, signal: AbortSignal.timeout(delaiMs) })
        const j = await res.json().catch(() => ({}))
        const admins = valeurService(ctx, "ADMIN_USER_IDS").valeur
        r = j.ok ? { ok: true, message: `Slack reconnaît le bot dans l'espace « ${String(j.team ?? "").slice(0, 80)} ».${admins ? "" : " Attention : aucun administrateur n'est désigné, personne ne peut décider depuis Slack."}` } : { ok: false, message: j.error === "invalid_auth" || j.error === "token_revoked" ? "Slack refuse ce jeton de bot : il a été révoqué, ou l'application a été réinstallée." : `Slack a répondu : ${String(j.error ?? res.status).slice(0, 80)}.` }
      } catch (e) {
        r = { ok: false, message: traduireEchec("slack", e?.name === "TimeoutError" ? "pas de réponse" : e?.message) }
      }
    }
  } else if (service === "passerelle") {
    const cle = valeurService(ctx, "AI_GATEWAY_API_KEY_APPLIS").valeur
    if (!cle) r = { ok: false, message: "Aucune clé dédiée : les applications utilisent la clé commune du serveur, s'il y en a une." }
    else if (process.env.NODE_TEST_CONTEXT && envoyer === globalThis.fetch) r = { ok: false, message: "Hors réseau (tests)." }
    else {
      try {
        const res = await envoyer(`${PASSERELLE}/v1/models`, { headers: { authorization: `Bearer ${cle}` }, signal: AbortSignal.timeout(delaiMs) })
        await res.body?.cancel?.().catch(() => {})
        r = res.ok ? { ok: true, message: "La passerelle accepte cette clé." } : { ok: false, message: res.status === 401 || res.status === 403 ? "La passerelle refuse cette clé : elle a été supprimée, ou copiée incomplète." : `La passerelle a répondu HTTP ${res.status}.` }
      } catch (e) {
        r = { ok: false, message: traduireEchec("passerelle", e?.name === "TimeoutError" ? "pas de réponse" : e?.message) }
      }
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

// --- Appliquer aux applications --------------------------------------------------------------
// Pas de nouveau mécanisme dans le déployeur : on redemande le même état (même version du code)
// avec une nouvelle date ; le déployeur le redéploie avec les clés du moment. Construction en
// cache (l'image porte le sha), bascule blue/green habituelle pour une production. Rien de secret
// ne part sur GitHub : seulement une date.
const lireJson = (fichier) => {
  try {
    return JSON.parse(readFileSync(fichier, "utf8"))
  } catch {
    return null
  }
}
const nomProduit = (ctx, slug) => ctx.db.prepare("SELECT nom FROM projets WHERE slug = ?").get(slug)?.nom ?? slug

// Les applications en ligne et la version des clés qu'elles ont reçue.
export function applicationsEtCles(ctx) {
  const statut = lireJson(join(ctx.config.etatDir ?? "/app/etat", "statut.json")) ?? {}
  const version = versionBoite(ctx)
  return Object.entries(statut).filter(([, s]) => s?.etat === "ok" && s.conteneur).map(([cle, s]) => {
    const [environnement, slug] = cle.split("/")
    return { cle, environnement, slug, nom: nomProduit(ctx, slug), a_jour: version === 0 || s.boite === version }
  })
}

let applicationEnCours = false
export async function appliquerAuxApplications(ctx, par, { confirme = false, redemander = redemanderEtat } = {}) {
  if (confirme !== true) throw erreur(400, "Redémarrer les applications doit être confirmé.")
  if (applicationEnCours) return { ok: false, message: "C'est déjà en cours." }
  const aFaire = applicationsEtCles(ctx).filter((a) => !a.a_jour)
  if (!aFaire.length) return { ok: true, message: "Toutes les applications ont déjà les clés de la console." }
  applicationEnCours = true
  ;(async () => {
    for (const a of aFaire) {
      const chemin = a.environnement === "production" ? `production/${a.slug}.json` : `apercus/${a.slug}.json`
      try {
        await redemander(ctx.config, chemin, `${a.nom} (${a.environnement === "production" ? "production" : "aperçu"}) : nouvelles clés de la console (${par})`, { viaPR: a.environnement === "production" })
      } catch (e) {
        noter(ctx.db, { projet: null, type: "erreur", message: `Clés de la console : ${a.nom} pas redemandé (${e.message})` })
      }
    }
  })().catch((e) => console.error("Appliquer les clés :", e.message)).finally(() => (applicationEnCours = false))
  noter(ctx.db, { projet: null, type: "reglage", message: `Clés de la console appliquées à ${aFaire.length} application(s) par ${par}` })
  return { ok: true, message: `${aFaire.length} application(s) vont redémarrer avec les clés de la console, dans les minutes qui viennent : ${aFaire.map((a) => `${a.nom}${a.environnement === "production" ? "" : " (aperçu)"}`).join(", ")}.` }
}

// --- Ce que la console affiche (jamais une valeur secrète) ------------------------------------
function actifService(ctx, id, instance) {
  if (id === "sentry" || id === "posthog") return Boolean(instance.actif[id])
  if (id === "smtp") return Boolean(valeurService(ctx, "SMTP_HOST").valeur)
  if (id === "slack") return Boolean(valeurService(ctx, "SLACK_BOT_TOKEN").valeur && valeurService(ctx, "SLACK_APP_TOKEN").valeur)
  return Boolean(valeurService(ctx, "AI_GATEWAY_API_KEY_APPLIS").valeur)
}
const CANAUX = { sentry: ["battement", "erreurs"], posthog: ["evenements", "journaux"] }
const CANAUX_DEPLOYEUR = { sentry: ["erreurs"], posthog: ["evenements", "journaux"] }
export function etatServices(ctx, instance = obs) {
  const etat = instance.etat()
  const sante = lireJson(join(ctx.config.etatDir ?? "/app/etat", "sante.json"))
  const version = versionBoite(ctx)
  const applications = applicationsEtCles(ctx)
  // Le déployeur : a-t-il lu la dernière boîte, et ce qu'il envoie vraiment.
  const deployeur = (id) => {
    const o = sante?.observabilite
    if (!o) return { connu: false }
    const a_jour = version === 0 || sante.boite?.version === version
    const envoi = Object.fromEntries((CANAUX_DEPLOYEUR[id] ?? []).map((c) => [c, o[c] ? { ...o[c], dernier_echec: o[c].dernier_echec ? { le: o[c].dernier_echec.le, message: traduireEchec(id, o[c].dernier_echec.detail) } : null } : null]))
    return { connu: true, a_jour, actif: Boolean(o[id]), envoi, le: sante.le }
  }
  return {
    version_boite: version,
    applications: { total: applications.length, a_jour: applications.filter((a) => a.a_jour).length, en_retard: applications.filter((a) => !a.a_jour).map((a) => ({ nom: a.nom, environnement: a.environnement })), en_cours: applicationEnCours },
    services: Object.entries(SERVICES).map(([id, s]) => ({
      id,
      libelle: s.libelle,
      actif: actifService(ctx, id, instance),
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
          serveur: Boolean(String(d.serveur(ctx) ?? "").trim()),
          // Une valeur publique (la région) se montre ; une valeur secrète, jamais.
          valeur: d.secret ? null : valeur,
          destinataires: d.destinataires,
        }
      }),
      envoi: Object.fromEntries((CANAUX[id] ?? []).map((c) => [c, { envoyes: etat[c].envoyes, echecs: etat[c].echecs, joignable: etat[c].joignable, dernier_ok: etat[c].dernier_ok, dernier_echec: etat[c].dernier_echec ? { le: etat[c].dernier_echec.le, message: traduireEchec(id, etat[c].dernier_echec.detail) } : null }])),
      deployeur: id === "slack" ? null : deployeur(id),
      ...(id === "slack" ? { connecte: Boolean(ctx.slackConnecte?.()) } : {}),
      test: lireTest(ctx, id),
    })),
  }
}
