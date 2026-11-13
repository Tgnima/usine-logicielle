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
//   - coupée : un drapeau à part (service_<nom>_coupe), qui l'emporte sur toute valeur, celle du
//     serveur comprise (« Couper l'envoi »). La valeur de la console reste : « Ne plus couper » la
//     rétablit ; « Retirer » efface tout et rend la main au serveur ;
//   - absente : la valeur du serveur (secrets.sh) sert, comme avant.
// Une valeur saisie n'est jamais renvoyée : seulement la date, l'auteur et, pour une clé longue et
// aléatoire, ses 4 derniers caractères (jamais pour un mot de passe choisi par une personne).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { lireDsn } from "../../commun/observabilite.mjs"
import { secret } from "./config.mjs"
import { ecrireReglage, lireReglage } from "./couts.mjs"
import { noter } from "./db.mjs"
import { chiffrer, dechiffrer } from "./fournisseurs.mjs"
import { redemanderEtat } from "./github.mjs"
import { MONITEUR, obs, reglerObservabilite } from "./observabilite.mjs"
import { courrielDuServeur, envoyerEssai, reglerCourriel, verifierCourriel } from "./courriel.mjs"
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
  return { valeur: v, horsUE: sentryHorsUE(d.hote) }
}
// Hors d'Europe : seulement sentry.io hors de sa région européenne (de.sentry.io). Un Sentry
// hébergé par l'entreprise (sentry.mon-entreprise.fr) n'en dit rien : il est là où elle l'a mis.
export function sentryHorsUE(hote) {
  const h = String(hote ?? "").toLowerCase().replace(/:\d+$/, "")
  return /(^|\.)sentry\.io$/.test(h) && !/(^|\.)de\.sentry\.io$/.test(h)
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
// f : le libellé est féminin (« enregistrée ») ; apercu: false : on ne garde pas ses 4 derniers
// caractères (un mot de passe choisi par une personne se devinerait plus vite).
const TOUS = ["orchestrateur", "deployeur", "applications"]
export const CLES_SERVICES = {
  SENTRY_DSN: { service: "sentry", libelle: "Clé d'envoi Sentry (DSN)", f: true, secret: true, serveur: () => secret("sentry_dsn"), valider: validerDsn, destinataires: TOUS },
  POSTHOG_TOKEN: { service: "posthog", libelle: "Jeton de projet PostHog", secret: true, serveur: () => secret("posthog_token"), valider: validerJetonPosthog, destinataires: TOUS },
  POSTHOG_HOTE: { service: "posthog", libelle: "Région PostHog", f: true, secret: false, serveur: () => process.env.POSTHOG_HOTE ?? "", defaut: "eu.i.posthog.com", valider: validerHotePosthog, destinataires: TOUS },
  // L'envoi d'emails : un bloc. Si le serveur d'envoi est posé dans la console, tout le bloc vient
  // de la console (un champ absent y est vide) : jamais l'hôte de l'une avec le mot de passe de l'autre.
  SMTP_HOST: { service: "smtp", libelle: "Serveur d'envoi", secret: false, serveur: () => process.env.SMTP_HOST ?? "", valider: validerHoteSmtp, destinataires: TOUS },
  SMTP_PORT: { service: "smtp", libelle: "Port", secret: false, serveur: () => process.env.SMTP_PORT ?? "", valider: validerPortSmtp, destinataires: TOUS },
  SMTP_SECURE: { service: "smtp", libelle: "Sécurité", f: true, secret: false, serveur: () => process.env.SMTP_SECURE ?? "", valider: validerSecuriteSmtp, destinataires: TOUS },
  EMAIL_EXPEDITEUR: { service: "smtp", libelle: "Expéditeur", secret: false, serveur: () => process.env.EMAIL_EXPEDITEUR ?? "", valider: validerExpediteur, destinataires: TOUS },
  SMTP_USER: { service: "smtp", libelle: "Identifiant", secret: true, serveur: () => secret("smtp_user"), valider: sansEspace("Identifiant", 3), destinataires: TOUS },
  SMTP_PASS: { service: "smtp", libelle: "Mot de passe", secret: true, apercu: false, serveur: () => secret("smtp_pass"), valider: sansEspace("Mot de passe", 6), destinataires: TOUS },
  // La passerelle IA des applications : une clé à elles, jamais celle des agents. Sans elle, les
  // applications gardent la clé commune du serveur (comme avant).
  AI_GATEWAY_API_KEY_APPLIS: { service: "passerelle", libelle: "Clé de passerelle des applications", f: true, secret: true, serveur: () => "", valider: sansEspace("Clé de passerelle", 20), destinataires: ["applications"] },
  // Slack : pour l'orchestrateur seul, jamais dans la boîte.
  SLACK_BOT_TOKEN: { service: "slack", libelle: "Jeton du bot (xoxb-)", secret: true, serveur: () => secret("slack_bot_token"), valider: validerJetonBot, destinataires: ["orchestrateur"] },
  SLACK_APP_TOKEN: { service: "slack", libelle: "Jeton de l'application (xapp-)", secret: true, serveur: () => secret("slack_app_token"), valider: validerJetonApp, destinataires: ["orchestrateur"] },
  SLACK_CANAL: { service: "slack", libelle: "Canal", secret: false, serveur: (ctx) => ctx?.config?.serveur?.slackCanal ?? "", valider: validerCanal, destinataires: ["orchestrateur"] },
  ADMIN_USER_IDS: { service: "slack", libelle: "Administrateurs", secret: false, serveur: (ctx) => ctx?.config?.serveur?.slackAdmins ?? "", valider: validerAdmins, destinataires: ["orchestrateur"] },
}
// La clé principale de chaque service : celle que « Couper l'envoi » coupe.
export const SERVICES = {
  sentry: { libelle: "Sentry", principale: "SENTRY_DSN" },
  posthog: { libelle: "PostHog", principale: "POSTHOG_TOKEN" },
  smtp: { libelle: "L'envoi d'emails", principale: "SMTP_HOST" },
  passerelle: { libelle: "La passerelle des applications", principale: "AI_GATEWAY_API_KEY_APPLIS" },
  slack: { libelle: "Slack", principale: "SLACK_BOT_TOKEN" },
}

const cleReglage = (nom) => `service_${nom}`
const cleCoupe = (nom) => `service_${nom}_coupe`
const lire = (ctx, cle) => {
  try {
    return JSON.parse(lireReglage(ctx.db, cle, "null"))
  } catch {
    return null
  }
}
const effacer = (ctx, cle) => ctx.db.prepare("DELETE FROM reglages WHERE cle = ?").run(cle)
// La valeur posée dans la console (chiffrée pour un secret), sans la coupure.
function entree(ctx, nom) {
  const e = lire(ctx, cleReglage(nom))
  return e && !e.coupe ? e : null
}
// La coupure ({ le, par }), ou null. Une coupure écrite à la place de la valeur (avant le drapeau à
// part) compte encore : elle n'avait plus de valeur à rétablir.
function coupure(ctx, nom) {
  const c = lire(ctx, cleCoupe(nom))
  if (c) return c
  const ancienne = lire(ctx, cleReglage(nom))
  return ancienne?.coupe ? { le: ancienne.le, par: ancienne.par } : null
}

// La valeur qui sert vraiment, et d'où elle vient : console, coupe, serveur, defaut ou aucune.
// Une valeur de la console illisible (coffre verrouillé) laisse servir celle du serveur.
export function valeurService(ctx, nom) {
  const def = CLES_SERVICES[nom]
  if (!def) throw erreur(400, "Réglage inconnu.")
  if (coupure(ctx, nom)) return { valeur: "", source: "coupe" }
  const e = entree(ctx, nom)
  let illisible = false
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
// version : un compteur, augmenté seulement quand le contenu de la boîte change (une clé pour le
// déployeur ou les applications : jamais Slack, ni une valeur reposée à l'identique). Le déployeur
// note dans statut.json la version reçue par chaque conteneur : jamais une empreinte des valeurs
// (une empreinte courte d'un mot de passe se casserait hors ligne).
export const versionBoite = (ctx) => Number(lireReglage(ctx.db, "boite_version", "0")) || 0
const clesBoite = (ctx) => JSON.stringify(contenuBoite(ctx).cles)
// avant : clesBoite(ctx) lu avant le changement.
function changerVersionSi(ctx, avant) {
  if (clesBoite(ctx) !== avant) ecrireReglage(ctx.db, "boite_version", String(versionBoite(ctx) + 1))
}

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
  const avant = clesBoite(ctx)
  ecrireReglage(ctx.db, cleReglage(nom), JSON.stringify(def.secret ? { ...chiffrer(ctx, v), ...(def.apercu === false ? {} : { fin: v.slice(-4) }), ...quand } : { valeur: v, ...quand }))
  // Une nouvelle valeur sert aussitôt : la coupure de cette clé tombe.
  effacer(ctx, cleCoupe(nom))
  noter(ctx.db, { projet: null, type: "reglage", message: `${def.libelle} posée dans la console par ${par}${horsUE ? " (hors d'Europe, confirmé)" : ""}` })
  changerVersionSi(ctx, avant)
  appliquerServices(ctx, regler)
  apresChangement(ctx, nom)
  return { ok: true, message: messagePose(ctx, nom) }
}

const accord = (def, mot) => `${mot}${def.f ? "e" : ""}`
// Ce que dit la console après une pose : qui s'en sert, et quand.
function messagePose(ctx, nom) {
  const def = CLES_SERVICES[nom]
  const enregistre = `${def.libelle} ${accord(def, "enregistré")}`
  if (def.service === "slack") {
    // Le canal et les administrateurs se relisent à chaque message ; les jetons rouvrent la connexion.
    if (nom === "SLACK_CANAL") return "Canal enregistré : pris en compte dès le prochain message."
    if (nom === "ADMIN_USER_IDS") return "Administrateurs enregistrés : pris en compte dès le prochain message."
    const autre = nom === "SLACK_BOT_TOKEN" ? "SLACK_APP_TOKEN" : "SLACK_BOT_TOKEN"
    if (!valeurService(ctx, autre).valeur) return `${enregistre}. Il manque encore ${autre === "SLACK_APP_TOKEN" ? "le jeton de l'application" : "le jeton du bot"} pour brancher Slack.`
    return `${enregistre} : la connexion à Slack se rouvre avec ces réglages.`
  }
  if (def.service === "smtp") {
    const bloc = blocCourriel(ctx)
    const pronom = def.f ? "elle" : "il"
    // Le serveur d'envoi ne vient pas de la console : tout l'envoi vient du serveur, rien d'ici ne sert.
    if (!bloc) return `${enregistre}, mais ${pronom} ne sert pas encore : l'envoi garde tous les réglages du serveur tant que le serveur d'envoi n'est pas enregistré ici.`
    if (!bloc.hote) return `${enregistre} : ${pronom} servira quand l'envoi ne sera plus coupé.`
    // Ce qui manque au bloc de la console, dont ce que le serveur avait et qui ne sert plus.
    const perdus = [!bloc.utilisateur && secret("smtp_user") && "l'identifiant", !bloc.motDePasse && secret("smtp_pass") && "le mot de passe"].filter(Boolean)
    const manque = [!bloc.expediteur && "l'expéditeur", ...perdus].filter(Boolean)
    const liste = manque.length > 1 ? `${manque.slice(0, -1).join(", ")} et ${manque.at(-1)}` : manque[0]
    return `${enregistre} : l'usine s'en sert dès maintenant, les applications à leur prochaine mise en ligne ou par « Appliquer ».${manque.length ? ` Il manque encore ici ${liste}${perdus.length ? " (ceux du serveur ne servent plus)" : ""}.` : ""}`
  }
  if (!def.destinataires.includes("orchestrateur")) return `${enregistre} : les applications la recevront à leur prochaine mise en ligne, ou par « Appliquer ».`
  return `${enregistre} : l'usine s'en sert dès maintenant, le déployeur dans la minute. Les applications ${def.f ? "la" : "le"} recevront à leur prochaine mise en ligne, ou par « Appliquer ».`
}
// Après chaque changement : le dernier test du service ne dit plus rien de la nouvelle valeur ; Slack
// ne relit pas ses jetons en marche, sa connexion se rouvre (index.mjs, ctx.relancerSlack).
function apresChangement(ctx, nom) {
  effacer(ctx, cleTest(CLES_SERVICES[nom].service))
  if (!["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN"].includes(nom)) return
  Promise.resolve(ctx.relancerSlack?.()).catch((e) => console.error("Slack (relance) :", e.message))
}

// Retirer ce que la console a posé (valeur et coupure) : la valeur du serveur reprend.
export function retirerService(ctx, nom, par, regler = reglerObservabilite) {
  const def = CLES_SERVICES[nom]
  if (!def) throw erreur(400, "Réglage inconnu.")
  const avant = clesBoite(ctx)
  effacer(ctx, cleReglage(nom))
  effacer(ctx, cleCoupe(nom))
  noter(ctx.db, { projet: null, type: "reglage", message: `${def.libelle} ${accord(def, "retiré")} de la console par ${par}` })
  changerVersionSi(ctx, avant)
  appliquerServices(ctx, regler)
  apresChangement(ctx, nom)
  const reprend = valeurService(ctx, nom).source === "serveur"
  return { ok: true, message: `${def.libelle} ${accord(def, "retiré")}${reprend ? " : la valeur du serveur reprend." : "."}` }
}

// Couper l'envoi : un drapeau qui l'emporte sur toute valeur, celle du serveur comprise. La valeur
// de la console reste en place, pour « Ne plus couper ».
export function couperService(ctx, service, par, regler = reglerObservabilite) {
  const s = SERVICES[service]
  if (!s) throw erreur(400, "Service inconnu.")
  const avant = clesBoite(ctx)
  ecrireReglage(ctx.db, cleCoupe(s.principale), JSON.stringify({ le: new Date().toISOString(), par }))
  noter(ctx.db, { projet: null, type: "reglage", message: `${s.libelle} : coupé dans la console par ${par}` })
  changerVersionSi(ctx, avant)
  appliquerServices(ctx, regler)
  apresChangement(ctx, s.principale)
  return { ok: true, message: `${s.libelle} : coupé, même avec la valeur du serveur. « Ne plus couper » le rebranche comme avant ; « Retirer » efface la valeur de la console.` }
}

// Ne plus couper : seule la coupure tombe ; la valeur d'avant (console, sinon serveur) sert de nouveau.
export function reprendreService(ctx, service, par, regler = reglerObservabilite) {
  const s = SERVICES[service]
  if (!s) throw erreur(400, "Service inconnu.")
  const avant = clesBoite(ctx)
  effacer(ctx, cleCoupe(s.principale))
  if (lire(ctx, cleReglage(s.principale))?.coupe) effacer(ctx, cleReglage(s.principale)) // une coupure d'avant le drapeau
  noter(ctx.db, { projet: null, type: "reglage", message: `${s.libelle} : rebranché dans la console par ${par}` })
  changerVersionSi(ctx, avant)
  appliquerServices(ctx, regler)
  apresChangement(ctx, s.principale)
  const { source } = valeurService(ctx, s.principale)
  return { ok: true, message: `${s.libelle} : rebranché${source === "console" ? ", avec la valeur de la console" : source === "serveur" ? ", avec la valeur du serveur" : ". Il n'y a pas encore de valeur : colle-la ici"}.` }
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
  // STARTTLS refusé (ou retiré en route) : l'usine n'envoie jamais le mot de passe en clair.
  if (e?.command === "STARTTLS" || (code === "ETLS" && /STARTTLS/i.test(e?.message ?? ""))) return "Le serveur d'envoi ne propose pas de connexion chiffrée (STARTTLS) : l'usine n'y envoie pas le mot de passe en clair. Essaie TLS direct (port 465), ou vérifie l'adresse et le port."
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
    // Ce qui sert vraiment : le bloc de la console, sinon celui du serveur (jamais un mélange).
    const envoi = blocCourriel(ctx) ?? courrielDuServeur()
    try {
      if (!envoi.hote) r = { ok: false, message: "Aucun serveur d'envoi : renseigne d'abord le serveur, le port et l'expéditeur." }
      else {
        await (options.verifier ?? verifierCourriel)()
        // La vérification exige le chiffrement (TLS direct, ou STARTTLS obligatoire) : un succès veut dire chiffré.
        const connexion = envoi.utilisateur ? "accepte la connexion chiffrée et les identifiants" : "accepte la connexion chiffrée, sans identifiant"
        r = envoi.expediteur
          ? { ok: true, message: `Le serveur d'envoi ${connexion}. Tu peux t'envoyer un email d'essai.` }
          : { ok: false, message: `Le serveur d'envoi ${connexion}, mais il manque l'expéditeur : sans lui, aucun email ne part.` }
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

// Les demandes faites par « Appliquer », par base (une usine en a une ; chaque test, la sienne) :
// clé du statut -> { version, demande_le, le }. Une application redemandée pour la version en
// cours reste « en cours » tant que le déployeur ne l'a pas prise (30 min au plus : une demande
// perdue peut être refaite). Un second clic ne la redéploie donc pas une deuxième fois.
const demandes = new WeakMap()
const DEMANDE_MAX_MS = 30 * 60_000
const demandesDe = (ctx) => {
  let m = demandes.get(ctx.db)
  if (!m) demandes.set(ctx.db, (m = new Map()))
  return m
}
const applicationsEnCours = new WeakSet() // les bases dont « Appliquer » écrit en ce moment

// Les applications en ligne et la version des clés qu'elles ont reçue. En ligne : déployée, en
// cours de redéploiement, ou dont le dernier déploiement a échoué alors que l'ancienne version
// tourne encore (elle garde ses anciennes clés : elle reste comptée, en retard).
export function applicationsEtCles(ctx) {
  const statut = lireJson(join(ctx.config.etatDir ?? "/app/etat", "statut.json")) ?? {}
  const version = versionBoite(ctx)
  const faites = demandesDe(ctx)
  return Object.entries(statut).filter(([, s]) => s?.conteneur && ["ok", "en_cours", "echec"].includes(s.etat)).map(([cle, s]) => {
    const [environnement, slug] = cle.split("/")
    const d = faites.get(cle)
    // Demandée pour cette version, et pas encore prise par le déployeur (il recopie demande_le).
    const demandee = Boolean(d && d.version === version && Date.now() - d.le < DEMANDE_MAX_MS && (!d.demande_le || s.demande_le !== d.demande_le))
    return { cle, environnement, slug, nom: nomProduit(ctx, slug), a_jour: version === 0 || s.boite === version, echec: s.etat === "echec", en_cours: s.etat === "en_cours" || demandee }
  })
}

export async function appliquerAuxApplications(ctx, par, { confirme = false, redemander = redemanderEtat } = {}) {
  if (confirme !== true) throw erreur(400, "Redémarrer les applications doit être confirmé.")
  if (applicationsEnCours.has(ctx.db)) return { ok: false, message: "C'est déjà en cours." }
  const version = versionBoite(ctx)
  const enRetard = applicationsEtCles(ctx).filter((a) => !a.a_jour)
  const aFaire = enRetard.filter((a) => !a.en_cours)
  if (!aFaire.length) return { ok: true, message: enRetard.length ? "Le redémarrage est déjà en cours : les applications reçoivent les clés de la console." : "Toutes les applications ont déjà les clés de la console." }
  applicationsEnCours.add(ctx.db)
  const faites = demandesDe(ctx)
  ;(async () => {
    for (const a of aFaire) {
      const chemin = a.environnement === "production" ? `production/${a.slug}.json` : `apercus/${a.slug}.json`
      try {
        const demande = await redemander(ctx.config, chemin, `${a.nom} (${a.environnement === "production" ? "production" : "aperçu"}) : nouvelles clés de la console (${par})`, { viaPR: a.environnement === "production" })
        if (demande) faites.set(a.cle, { version, demande_le: typeof demande === "string" ? demande : null, le: Date.now() })
        else noter(ctx.db, { projet: null, type: "erreur", message: `Clés de la console : ${a.nom} pas redemandé (son état souhaité n'existe plus)` })
      } catch (e) {
        noter(ctx.db, { projet: null, type: "erreur", message: `Clés de la console : ${a.nom} pas redemandé (${e.message})` })
      }
    }
  })().catch((e) => console.error("Appliquer les clés :", e.message)).finally(() => applicationsEnCours.delete(ctx.db))
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
// L'orchestrateur n'envoie pas de journaux de conteneurs : seul le déployeur le fait.
const CANAUX = { sentry: ["battement", "erreurs"], posthog: ["evenements"] }
const CANAUX_DEPLOYEUR = { sentry: ["erreurs"], posthog: ["evenements", "journaux"] }
// Un canal d'envoi, tel que la console le montre : jamais une clé, l'échec traduit en clair.
const canalAffiche = (id, c) => ({ envoyes: c.envoyes, echecs: c.echecs, joignable: c.joignable, dernier_ok: c.dernier_ok ?? null, premier_echec: c.premier_echec ?? null, dernier_echec: c.dernier_echec ? { le: c.dernier_echec.le, message: traduireEchec(id, c.dernier_echec.detail) } : null })

export function etatServices(ctx, instance = obs) {
  const etat = instance.etat()
  const sante = lireJson(join(ctx.config.etatDir ?? "/app/etat", "sante.json"))
  const version = versionBoite(ctx)
  const applications = applicationsEtCles(ctx)
  const bloc = blocCourriel(ctx)
  // Le déployeur : a-t-il lu la dernière boîte, et ce qu'il envoie vraiment.
  const deployeur = (id) => {
    const o = sante?.observabilite
    if (!o) return { connu: false }
    const a_jour = version === 0 || sante.boite?.version === version
    const envoi = Object.fromEntries((CANAUX_DEPLOYEUR[id] ?? []).map((c) => [c, o[c] ? canalAffiche(id, o[c]) : null]))
    return { connu: true, a_jour, actif: Boolean(o[id]), envoi, le: sante.le }
  }
  const enRetard = applications.filter((a) => !a.a_jour)
  return {
    version_boite: version,
    applications: {
      total: applications.length,
      a_jour: applications.length - enRetard.length,
      en_retard: enRetard.map((a) => ({ nom: a.nom, environnement: a.environnement, echec: a.echec, en_cours: a.en_cours })),
      // Ce que « Appliquer » redemanderait maintenant ; en cours : une demande pas encore servie.
      a_faire: applicationsEnCours.has(ctx.db) ? 0 : enRetard.filter((a) => !a.en_cours).length,
      en_cours: applicationsEnCours.has(ctx.db) || enRetard.some((a) => a.en_cours),
    },
    services: Object.entries(SERVICES).map(([id, s]) => ({
      id,
      libelle: s.libelle,
      actif: actifService(ctx, id, instance),
      cles: Object.entries(CLES_SERVICES).filter(([, d]) => d.service === id).map(([nom, d]) => {
        const e = entree(ctx, nom)
        const c = coupure(ctx, nom)
        let { valeur, source, illisible } = valeurService(ctx, nom)
        let serveur = Boolean(String(d.serveur(ctx) ?? "").trim())
        let enAttente = false
        // L'envoi d'emails en un bloc : chaque champ tel qu'il sert vraiment.
        if (d.service === "smtp" && nom !== "SMTP_HOST") {
          // Le bloc de la console : un champ qu'elle n'a pas posé y est vide, le serveur n'y est pour rien.
          if (bloc && source !== "console") [valeur, source, serveur] = ["", "aucune", false]
          // Le bloc du serveur : ce que la console a posé attend que le serveur d'envoi y soit posé aussi.
          else if (!bloc && source === "console") enAttente = true
        }
        const horsUE = valeur ? (() => {
          try {
            return d.valider(valeur).horsUE
          } catch {
            return null
          }
        })() : null
        return {
          nom, libelle: d.libelle, secret: d.secret, source, illisible: Boolean(illisible), hors_ue: horsUE, en_attente: enAttente,
          // La fin d'une clé longue (…ab12), jamais celle d'un mot de passe (apercu: false).
          console: e ? { fin: d.secret && d.apercu !== false ? e.fin ?? null : null, le: e.le, par: e.par } : null,
          coupe: c ? { le: c.le, par: c.par } : null,
          serveur,
          // Une valeur publique (la région) se montre ; une valeur secrète, jamais.
          valeur: d.secret ? null : valeur,
          destinataires: d.destinataires,
        }
      }),
      envoi: Object.fromEntries((CANAUX[id] ?? []).map((c) => [c, canalAffiche(id, etat[c])])),
      deployeur: id === "slack" ? null : deployeur(id),
      ...(id === "slack" ? { connecte: Boolean(ctx.slackConnecte?.()) } : {}),
      // L'envoi d'emails est complet quand ce qui sert a un serveur d'envoi et un expéditeur.
      ...(id === "smtp" ? { complet: (({ hote, expediteur }) => Boolean(hote && expediteur))(bloc ?? courrielDuServeur()) } : {}),
      test: lireTest(ctx, id),
    })),
  }
}
