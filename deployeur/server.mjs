// Le déployeur : le seul composant qui touche Docker. Il TIRE l'état souhaité
// depuis le dépôt d'état (toutes les 20 s) et l'applique : rien ne lui est
// poussé, aucun accès entrant, aucune clé SSH.
//
//   apercus/<slug>.json    -> conteneur usine-apercu-<slug>, remplacé à chaque lot
//   production/<slug>.json -> blue/green : usine-prod-<slug>-blue|green, sauvegarde
//                             du volume avant la bascule, l'ancien reste si le nouveau échoue
//
// Puis il régénère le Caddyfile (HTTPS automatique) et écrit /etat/statut.json,
// que l'orchestrateur lit pour savoir où en est chaque déploiement.
//
// Le pilotage (phase 2) :
//   - /etat/sante.json : disque, mémoire, charge, conteneurs, place de chaque produit ;
//   - un environnement absent de l'état souhaité est retiré (conteneurs, images, adresse ;
//     les données de production sont gardées) ;
//   - l'entretien : vieilles images, cache de construction, sauvegardes de plus de 30 jours ;
//   - la mise à jour de l'usine elle-même (usine/mise-a-jour.json), par un conteneur d'aide.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHEMINS_PUBLICS, cheminsDeclares, domainesValides, hotesValides, sousReseau } from "./chemins.mjs"
import { attendreSante, decisionDeploiement, REPRISES_MAX, scriptVerifierSecrets } from "./deploiement.mjs"
import { blocSmtp, lireBoite, valeurBoite } from "./boite.mjs"
import { jetonsMiseAJour, origineJeton } from "./jetons.mjs"
import { lignesNouvelles, proprietesDeploiement, suivreEtats } from "./observation.mjs"
import { DEPLOIEMENT_BLOQUE_MS, FORMAT_INSPECT, cleDuConteneur, conteneurActif, inspectIncomplet, jugerProduit, lireInspect, noterRedemarrages, versionDeLImage } from "./sonde.mjs"
import { creerObservabilite } from "../commun/observabilite.mjs"

const env = process.env
// Les secrets arrivent en fichiers (/run/secrets, voir secrets.sh), jamais par l'environnement.
const secret = (nom) => {
  try {
    return readFileSync(`/run/secrets/${nom}`, "utf8").trim()
  } catch {
    return env[nom.toUpperCase()] ?? ""
  }
}
const DEPOT_ETAT = env.DEPOT_ETAT // proprietaire/usine-etat
const JETON = secret("deploy_token") || secret("github_token")
const BASE = env.DOMAINE_BASE ?? ""
const PORTIER = "portier:8080"
const ETAT = env.ETAT_DIR ?? "/etat"
const CADDY = env.CADDY_DIR ?? "/caddy"
const SRV = env.SRV_DIR ?? "/srv"
// L'ancien réseau commun à tous les produits : ils le quittent pour un réseau chacun (reseauProduit).
const RESEAU = env.RESEAU ?? "usine"
const PLAGE_RESEAUX = env.RESEAUX_PRODUITS ?? "10.231.0.0/16"
// Ce conteneur (pour joindre les réseaux des produits et contrôler leur santé).
const MOI = (() => {
  try {
    return readFileSync("/etc/hostname", "utf8").trim()
  } catch {
    return env.HOSTNAME ?? ""
  }
})()
// L'image du déployeur : elle seule manipule les sauvegardes (jamais l'image d'un produit).
const IMAGE_OUTILS = "usine-logicielle-deployeur"
const MEMOIRE = env.MEMOIRE_PRODUIT ?? "384m"
const HTTPS = env.HTTPS !== "0"
// Des résolveurs de secours pour les produits aussi (coupures DNS de l'hébergeur).
const DNS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"].flatMap((d) => ["--dns", d])
// Le dossier de l'usine sur le serveur, monté au même chemin (mise à jour de l'usine).
const USINE_DIR = env.USINE_DIR ?? ""
const DEPOT_USINE = env.DEPOT_USINE ?? ""
// Sans jeton ni dépôt d'état (usine neuve, GitHub pas encore connecté dans la console) :
// le déployeur attend ; il reprend dès que l'orchestrateur dépose le jeton de l'application.

const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const horodatage = () => new Date().toISOString()
const log = (...a) => console.log(horodatage(), ...a)

// L'observabilité (commun/observabilite.mjs) : l'état de chaque produit, ses déploiements et ses
// journaux vers PostHog, un incident Sentry quand un produit tombe en panne, et les exceptions
// non attrapées du déployeur. Un seul DSN et un seul jeton pour tous les produits : chaque envoi
// porte le produit en étiquette. Sans clé, rien ne part ; un envoi ne bloque jamais un déploiement.
const obs = creerObservabilite({
  sentryDsn: secret("sentry_dsn"),
  posthogJeton: secret("posthog_token"),
  posthogHote: env.POSTHOG_HOTE || "eu.i.posthog.com",
  service: "usine-deployeur",
  environnement: env.USINE_ENVIRONNEMENT || "production",
  version: () => miseAJour.version,
  signaler: (texte) => log(texte),
})
obs.brancherProcessus()

// La boîte (boite.mjs) : les clés posées dans la console passent avant celles du serveur. Relue à
// chaque bilan de santé (30 s) et avant chaque déploiement : une clé collée dans la console sert
// ici en 30 s au plus, sans redémarrage.
const BOITE = env.BOITE_DIR ?? "/boite"
let boite = null
function appliquerBoite() {
  boite = lireBoite(BOITE)
  obs.reconfigurer({
    sentryDsn: valeurBoite(boite, "SENTRY_DSN", secret("sentry_dsn")),
    posthogJeton: valeurBoite(boite, "POSTHOG_TOKEN", secret("posthog_token")),
    posthogHote: valeurBoite(boite, "POSTHOG_HOTE", "") || env.POSTHOG_HOTE || "eu.i.posthog.com",
  })
}

// Le jeton passe par la configuration git de l'environnement : jamais dans les
// arguments (visibles dans ps) ni dans .git/config.
// Avec l'application GitHub de l'usine, l'orchestrateur dépose un jeton de courte durée
// (/jetons/github.json) pour l'état et les produits. La mise à jour de l'usine elle-même
// (DEPOT_USINE) l'essaie aussi en premier, puis le jeton du serveur, puis sans jeton (jetons.mjs).
function lireJetons() {
  try {
    return JSON.parse(readFileSync(join(env.JETONS_DIR ?? "/jetons", "github.json"), "utf8"))
  } catch {
    return {}
  }
}
// Le jeton de la console, s'il est encore valable deux minutes (sinon null).
function jetonConsole() {
  const j = lireJetons()
  return j.jeton && j.expire - Date.now() > 2 * 60_000 ? j.jeton : null
}
const jetonForge = () => jetonConsole() ?? JETON
// Le dépôt d'état : celui du compte GitHub connecté dans la console, sinon celui du contrat.
const depotEtat = () => lireJetons().depot_etat || DEPOT_ETAT
const envGit = (jeton = jetonForge()) => ({
  ...env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${jeton}`).toString("base64")}`,
})

// Une commande, sans shell (les valeurs ne sont jamais interprétées).
// git : true (jeton de la forge) ; { jeton } impose un jeton précis (null : sans jeton).
function lancer(cmd, args, { cwd, git = false, minutes = 15, max = 20_000 } = {}) {
  return new Promise((resolve) => {
    const jeton = typeof git === "object" && git !== null ? git.jeton : git ? jetonForge() : null
    const p = spawn(cmd, args, { cwd, env: jeton ? envGit(jeton) : env })
    let sortie = ""
    const garder = (d) => (sortie = (sortie + d).slice(-max))
    p.stdout.on("data", garder)
    p.stderr.on("data", garder)
    const minuterie = setTimeout(() => p.kill("SIGKILL"), minutes * 60_000)
    p.on("close", (code) => {
      clearTimeout(minuterie)
      // Les jetons sont masqués ; un jeton vide (serveur sans jeton) ne masque rien.
      resolve({ code, sortie: [jeton, JETON].filter(Boolean).reduce((s, j) => s.replaceAll(j, "***"), sortie) })
    })
    p.on("error", (e) => resolve({ code: -1, sortie: e.message }))
  })
}
async function ok(cmd, args, options) {
  const r = await lancer(cmd, args, options)
  if (r.code !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} : ${r.sortie.slice(-1500)}`)
  return r.sortie
}

// --- L'état -------------------------------------------------------------------
const FICHIER_STATUT = join(ETAT, "statut.json")
const lireStatut = () => {
  try {
    return JSON.parse(readFileSync(FICHIER_STATUT, "utf8"))
  } catch {
    return {}
  }
}
function ecrireStatut(statut) {
  writeFileSync(`${FICHIER_STATUT}.tmp`, JSON.stringify(statut, null, 2))
  renameSync(`${FICHIER_STATUT}.tmp`, FICHIER_STATUT)
}

let demandeMiseAJour = null
let domaines = {} // produit -> adresses personnalisées (servies comme sa production)
async function synchroniserEtat() {
  const dossier = join(SRV, "etat")
  const depot = depotEtat()
  if (!depot || !jetonForge()) return // GitHub pas encore connecté
  // 2 à 3 minutes au plus : quand le réseau de l'hébergeur coupe, git attendrait 15 min par tour.
  if (!existsSync(join(dossier, ".git"))) await ok("git", ["clone", "-q", `https://github.com/${depot}.git`, dossier], { git: true, minutes: 3 })
  else {
    // Le compte GitHub a changé (connexion depuis la console) : on suit le nouveau dépôt d'état.
    await ok("git", ["remote", "set-url", "origin", `https://github.com/${depot}.git`], { cwd: dossier })
    await ok("git", ["fetch", "-q", "origin"], { cwd: dossier, git: true, minutes: 2 })
    await ok("git", ["reset", "-q", "--hard", "origin/HEAD"], { cwd: dossier })
  }
  const souhaits = []
  try {
    demandeMiseAJour = JSON.parse(readFileSync(join(dossier, "usine", "mise-a-jour.json"), "utf8"))
  } catch {
    demandeMiseAJour = null
  }
  const dossierDomaines = join(dossier, "domaines")
  const fichiersDomaines = []
  if (existsSync(dossierDomaines)) {
    for (const f of readdirSync(dossierDomaines).filter((x) => x.endsWith(".json"))) {
      try {
        fichiersDomaines.push(JSON.parse(readFileSync(join(dossierDomaines, f), "utf8")))
      } catch (e) {
        log(`État illisible domaines/${f} : ${e.message}`)
      }
    }
  }
  domaines = domainesValides(fichiersDomaines, BASE)
  for (const environnement of ["apercus", "production"]) {
    const d = join(dossier, environnement)
    if (!existsSync(d)) continue
    for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
      try {
        souhaits.push(JSON.parse(readFileSync(join(d, f), "utf8")))
      } catch (e) {
        log(`État illisible ${environnement}/${f} : ${e.message}`)
      }
    }
  }
  return souhaits
}

// Ce qui vient du dépôt d'état est contrôlé avant d'atteindre Docker.
function valide(s) {
  return /^[a-z0-9-]{3,24}$/.test(s.produit ?? "") && /^[0-9a-f]{40}$/.test(s.sha ?? "") && /^[\w.-]+\/[\w.-]+$/.test(s.depot ?? "")
    && ["apercu", "production"].includes(s.environnement) && [undefined, "protege", "public"].includes(s.acces) && [undefined, "demo", "vide"].includes(s.donnees) && [undefined, "captures", "reels"].includes(s.emails) && hotesValides(s, /^[a-z0-9.-]+$/.test(BASE) ? BASE : "")
}

const VARIABLES = ["DEMO", "DEMO_VITESSE_HORLOGE", "PUBLIC_URL", "LLM_MODELE", "EMAIL_DESTINATAIRES_AUTORISES"]
function variables(s) {
  const v = { PORT: "3000", DATA_DIR: "/app/data" }
  for (const k of VARIABLES) if (s.env?.[k] !== undefined) v[k] = String(s.env[k])
  if ((s.services ?? []).includes("mailpit")) Object.assign(v, { SMTP_HOST: "mailpit", SMTP_PORT: "1025" })
  // Emails réels : le service d'envoi de la console (boîte) ou du serveur, jamais du dépôt d'état.
  if (s.emails === "reels") {
    const smtp = blocSmtp(boite, { SMTP_HOST: env.SMTP_HOST ?? "", SMTP_PORT: env.SMTP_PORT ?? "", SMTP_SECURE: env.SMTP_SECURE ?? "", EMAIL_EXPEDITEUR: env.EMAIL_EXPEDITEUR ?? "", SMTP_USER: secret("smtp_user"), SMTP_PASS: secret("smtp_pass") })
    if (!smtp.SMTP_HOST) throw new Error("emails réels demandés mais aucun service d'envoi n'est branché (console ou serveur)")
    // SMTP_SECURE : « 1 » pour TLS direct ; la console écrit « 0 » pour STARTTLS, qui n'est pas transmis.
    for (const [k, val] of Object.entries(smtp)) if (val && !(k === "SMTP_SECURE" && val !== "1")) v[k] = val
  }
  // La passerelle IA : la clé dédiée aux applications (console) d'abord, sinon la clé commune du serveur.
  const passerelle = valeurBoite(boite, "AI_GATEWAY_API_KEY_APPLIS", secret("ai_gateway_api_key"))
  if (passerelle) v.AI_GATEWAY_API_KEY = passerelle
  // L'observabilité du produit (server/observabilite.js de la brique) : le même DSN et le même jeton
  // pour tous, des clés d'envoi seulement ; le produit et son environnement l'étiquettent.
  Object.assign(v, { USINE_PRODUIT: s.produit, USINE_ENVIRONNEMENT: s.environnement, USINE_VERSION: s.sha.slice(0, 12) })
  // La boîte d'abord (clés de la console ; une clé vide coupe l'envoi), puis le serveur.
  const dsn = valeurBoite(boite, "SENTRY_DSN", secret("sentry_dsn"))
  const jeton = valeurBoite(boite, "POSTHOG_TOKEN", secret("posthog_token"))
  const hotePosthog = valeurBoite(boite, "POSTHOG_HOTE", "") || env.POSTHOG_HOTE
  if (dsn) v.SENTRY_DSN = dsn
  if (jeton) v.POSTHOG_TOKEN = jeton
  if (hotePosthog) v.POSTHOG_HOTE = hotePosthog
  return v
}
// Un fichier d'environnement privé, effacé dès que le conteneur est créé : les secrets (SMTP, clé
// de la passerelle) n'apparaissent jamais dans les arguments d'un processus (ps).
async function avecFichierEnv(v, f) {
  const dossier = mkdtempSync(join(tmpdir(), "usine-env-"))
  const fichier = join(dossier, "env")
  try {
    writeFileSync(fichier, Object.entries(v).map(([k, val]) => `${k}=${String(val).replace(/[\r\n]/g, "")}`).join("\n") + "\n", { mode: 0o600 })
    return await f(fichier)
  } finally {
    rmSync(dossier, { recursive: true, force: true })
  }
}

// --- Un réseau par produit -----------------------------------------------------------
// Un produit ne joint jamais un autre produit (ni ne lui envoie un faux X-Usine-Utilisateur en
// contournant le portier) : chacun a son réseau, où ne sont branchés que Caddy, le déployeur et,
// s'il capture ses emails, Mailpit.
const reseauProduit = (produit) => `usine-p-${produit}`
async function mailpit() {
  const r = await lancer("docker", ["ps", "-q", "--filter", "label=com.docker.compose.project=usine-logicielle", "--filter", "label=com.docker.compose.service=mailpit"])
  return r.sortie.trim().split("\n")[0] || null
}
async function brancher(reseau, conteneur, alias = null) {
  if (!conteneur) return
  const r = await lancer("docker", ["network", "connect", ...(alias ? ["--alias", alias] : []), reseau, conteneur])
  if (r.code !== 0 && !/already exists|already attached/i.test(r.sortie)) log(`Réseau ${reseau} : ${conteneur} non branché : ${r.sortie.trim().slice(-200)}`)
}
async function preparerReseau(produit, { avecMailpit = false } = {}) {
  const reseau = reseauProduit(produit)
  if ((await lancer("docker", ["network", "inspect", reseau])).code !== 0) {
    let cree = false
    for (let essai = 0; essai < 8 && !cree; essai++) {
      cree = (await lancer("docker", ["network", "create", "--label", `usine.produit=${produit}`, "--subnet", sousReseau(produit, essai, PLAGE_RESEAUX), reseau])).code === 0
    }
    // Plus de place dans la plage : le réseau commun, comme avant (signalé).
    if (!cree) {
      log(`Réseau ${reseau} impossible à créer : ${produit} reste sur le réseau commun ${RESEAU}.`)
      return RESEAU
    }
  }
  await brancher(reseau, "usine-caddy")
  await brancher(reseau, MOI)
  if (avecMailpit) await brancher(reseau, await mailpit(), "mailpit")
  return reseau
}
async function supprimerReseau(produit) {
  const reseau = reseauProduit(produit)
  if ((await lancer("docker", ["network", "inspect", reseau])).code !== 0) return
  for (const c of ["usine-caddy", MOI, await mailpit()]) if (c) await lancer("docker", ["network", "disconnect", "-f", reseau, c])
  await lancer("docker", ["network", "rm", reseau])
}

// Sans suivre de redirection (attendreSante, deploiement.mjs).
const sante = (conteneur, secondes = 90) => attendreSante(`http://${conteneur}:3000/api/health`, { secondes })

async function construire(s) {
  const dossier = join(SRV, "produits", s.produit)
  if (!existsSync(join(dossier, ".git"))) {
    mkdirSync(dossier, { recursive: true })
    await ok("git", ["init", "-q"], { cwd: dossier })
    await ok("git", ["remote", "add", "origin", `https://github.com/${s.depot}.git`], { cwd: dossier })
  }
  await ok("git", ["fetch", "-q", "--depth", "1", "origin", s.sha], { cwd: dossier, git: true })
  await ok("git", ["checkout", "-q", "-f", s.sha], { cwd: dossier })
  await ok("git", ["clean", "-q", "-fdx"], { cwd: dossier })
  const image = `usine-produit-${s.produit}:${s.sha.slice(0, 12)}`
  await ok("docker", ["build", "-q", "-t", image, "."], { cwd: dossier, minutes: 20 })
  // Les chemins que le produit déclare publics (usine.json), à cette version précise.
  const fichier = join(dossier, "usine.json")
  const { chemins, refuses } = cheminsDeclares(existsSync(fichier) ? readFileSync(fichier, "utf8") : "")
  if (refuses.length) log(`${s.produit} : chemins publics refusés (trop larges ou invalides) : ${refuses.join(", ")}`)
  return { image, publics: chemins }
}

// Un produit tourne sans les privilèges dont il n'a pas besoin : pas de paquets réseau bruts
// (usurpation sur le réseau), pas de fichiers spéciaux, pas d'élévation (setuid), processus limités.
const DURCI = ["--cap-drop", "NET_RAW", "--cap-drop", "MKNOD", "--cap-drop", "AUDIT_WRITE", "--cap-drop", "SETFCAP", "--cap-drop", "SYS_CHROOT", "--security-opt", "no-new-privileges", "--pids-limit", "512"]
async function demarrer(nom, image, volume, s) {
  const reseau = await preparerReseau(s.produit, { avecMailpit: (s.services ?? []).includes("mailpit") })
  await lancer("docker", ["rm", "-f", nom])
  await avecFichierEnv(variables(s), (fichier) => ok("docker", ["run", "-d", "--name", nom, "--network", reseau, "--restart", "unless-stopped", ...DNS, ...DURCI, "--memory", MEMOIRE, "--label", "usine.produit=" + s.produit, "-v", `${volume}:/app/data`, "--env-file", fichier, image]))
}

async function deployerApercu(s) {
  const { image, publics } = await construire(s)
  const nom = `usine-apercu-${s.produit}`
  await demarrer(nom, image, `usine-apercu-${s.produit}-data`, s)
  if (!(await sante(nom))) {
    const journal = (await lancer("docker", ["logs", "--tail", "40", nom])).sortie
    throw new Error(`l'aperçu ne répond pas à /api/health :\n${journal}`)
  }
  return { conteneur: nom, publics }
}

async function deployerProduction(s, precedent) {
  const { image, publics } = await construire(s)
  // Une base par mode : passer de la démo à la vraie utilisation ne mélange rien (l'autre base est gardée).
  const volume = `usine-prod-${s.produit}${s.donnees === "vide" ? "-reel" : ""}-data`
  // Sauvegarde du volume avant toute bascule (s'il existe déjà).
  if ((await lancer("docker", ["volume", "inspect", volume])).code === 0) {
    const archive = `${s.produit}-${horodatage().replace(/[:.]/g, "-")}.tgz`
    // Avec l'image du déployeur : celle du produit (son code) verrait, en root, les sauvegardes de tous.
    await ok("docker", ["run", "--rm", "--user", "root", "--network", "none", "-v", `${volume}:/d:ro`, "-v", "usine-sauvegardes:/s", "--entrypoint", "tar", IMAGE_OUTILS, "czf", `/s/${archive}`, "-C", "/d", "."])
    log(`Sauvegarde ${archive}`)
  }
  const couleur = precedent?.couleur === "blue" ? "green" : "blue"
  const nom = `usine-prod-${s.produit}-${couleur}`
  await demarrer(nom, image, volume, s)
  if (!(await sante(nom))) {
    const journal = (await lancer("docker", ["logs", "--tail", "40", nom])).sortie
    await lancer("docker", ["rm", "-f", nom])
    throw new Error(`la nouvelle version (${couleur}) ne répond pas ; l'ancienne reste en ligne :\n${journal}`)
  }
  return { conteneur: nom, couleur, publics, ancien: precedent?.conteneur && precedent.conteneur !== nom ? precedent.conteneur : null }
}

// --- Caddy ----------------------------------------------------------------------
// Un site Caddy. Protégé (par défaut) : le portier vérifie chaque requête, sauf
// les chemins publics ; l'en-tête d'identité ne peut pas venir du visiteur.
function blocSite(hote, cible, { protege = true, publics = CHEMINS_PUBLICS } = {}) {
  const site = HTTPS ? hote : `http://${hote}`
  const entetes = `\theader {\n\t\tStrict-Transport-Security "max-age=31536000"\n\t\tX-Content-Type-Options "nosniff"\n\t\tReferrer-Policy "strict-origin-when-cross-origin"\n\t\tX-Frame-Options "SAMEORIGIN"\n\t\t-Server\n\t}\n`
  if (!protege) return `${site} {\n\tencode zstd gzip\n${entetes}\trequest_header -X-Usine-Utilisateur\n\treverse_proxy ${cible}\n}`
  return `${site} {
\tencode zstd gzip
${entetes}\trequest_header -X-Usine-Utilisateur
\thandle /_portier/api/* {
\t\trespond 404
\t}
\thandle /_portier/* {
\t\treverse_proxy ${PORTIER}
\t}
${publics.length ? `\t@public path ${publics.join(" ")}\n\thandle @public {\n\t\treverse_proxy ${cible}\n\t}\n` : ""}\thandle {
\t\tforward_auth ${PORTIER} {
\t\t\turi /_portier/verifier
\t\t\tcopy_headers X-Usine-Utilisateur
\t\t}
\t\treverse_proxy ${cible}
\t}
}`
}

async function regenererCaddy(statut) {
  const blocs = []
  const mails = new Set()
  for (const [cle, s] of Object.entries(statut)) {
    if (!s.conteneur || !s.hote) continue
    // Un aperçu est toujours protégé ; une production l'est sauf choix explicite « public ».
    const reglages = { protege: s.acces !== "public" || s.hote.includes(".apercu."), publics: [...CHEMINS_PUBLICS, ...(s.chemins_publics ?? [])] }
    blocs.push(blocSite(s.hote, `${s.conteneur}:3000`, reglages))
    // Les domaines personnalisés d'une production : mêmes réglages, même conteneur.
    const [environnement, produit] = cle.split("/")
    if (environnement === "production") for (const h of domaines[produit] ?? []) blocs.push(blocSite(h, `${s.conteneur}:3000`, reglages))
    if (s.hote_mails) mails.add(s.hote_mails)
  }
  // Les adresses de l'usine elle-même : réservées aux administrateurs (le portier le vérifie).
  for (const h of mails) blocs.push(blocSite(h, "mailpit:8025", { publics: [] }))
  if (env.TABLEAU_HOTE && /^[a-z0-9.-]+$/.test(env.TABLEAU_HOTE)) blocs.push(blocSite(env.TABLEAU_HOTE, "orchestrateur:8091", { publics: [] }))
  // La console de l'usine (administrateurs ; le portier le vérifie).
  if (/^[a-z0-9.-]+$/.test(BASE) && env.TABLEAU_HOTE !== `console.${BASE}`) blocs.push(blocSite(`console.${BASE}`, "orchestrateur:8091", { publics: [] }))
  // Le portail : connexion, invitations, et la liste « Mes applications ».
  if (/^[a-z0-9.-]+$/.test(BASE)) blocs.push(`${HTTPS ? "" : "http://"}connexion.${BASE} {\n\theader -Server\n\thandle /_portier/api/* {\n\t\trespond 404\n\t}\n\treverse_proxy ${PORTIER}\n}`)
  const global = env.CADDY_EMAIL ? `{\n\temail ${env.CADDY_EMAIL}\n}\n\n` : ""
  const contenu = `# Généré par le déployeur de l'usine logicielle : ne pas modifier à la main.\n${global}${blocs.length ? blocs.join("\n\n") : ":80 {\n\trespond \"Usine logicielle : aucun produit déployé pour l'instant.\" 200\n}"}\n`
  const fichier = join(CADDY, "Caddyfile")
  if (existsSync(fichier) && readFileSync(fichier, "utf8") === contenu) return
  writeFileSync(fichier, contenu)
  const r = await lancer("docker", ["exec", "usine-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"])
  log(r.code === 0 ? "Caddy rechargé." : `Rechargement de Caddy impossible : ${r.sortie.slice(-500)}`)
}

// --- La boucle ----------------------------------------------------------------
// L'ancienne version d'un produit, gardée dans le statut quand la nouvelle échoue : elle reste servie.
const versionServie = (actuel) => (actuel?.conteneur ? { hote: actuel.hote, hote_mails: actuel.hote_mails, conteneur: actuel.conteneur, couleur: actuel.couleur } : {})

async function tour() {
  const souhaits = await synchroniserEtat()
  appliquerBoite()
  const statut = lireStatut()
  for (const s of souhaits) {
    if (!valide(s)) {
      log(`État refusé (champs invalides) : ${JSON.stringify(s).slice(0, 200)}`)
      continue
    }
    const cle = `${s.environnement}/${s.produit}`
    const actuel = statut[cle]
    const decision = decisionDeploiement(actuel, s)
    if (!decision) continue
    if (decision === "abandonner") {
      log(`${cle} : déploiement interrompu ${REPRISES_MAX + 1} fois, abandonné.`)
      // La couleur qu'il démarrait en production n'est pas servie : elle est retirée.
      const demarree = `usine-prod-${s.produit}-${actuel.couleur === "blue" ? "green" : "blue"}`
      if (s.environnement === "production" && demarree !== actuel.conteneur) await lancer("docker", ["rm", "-f", demarree])
      statut[cle] = { ...versionServie(actuel), etat: "echec", sha: s.sha, demande_le: s.demande_le, message: `déploiement interrompu ${REPRISES_MAX + 1} fois (le déployeur a redémarré pendant le déploiement) : abandonné. Une nouvelle demande le relancera.`, le: horodatage() }
      ecrireStatut(statut)
      obs.evenement("deploiement", proprietesDeploiement(s, "abandonne", { reprise: true }), { distinctId: `produit:${s.produit}` })
      continue
    }
    const debut = Date.now()
    log(decision === "reprendre" ? `Reprise du déploiement interrompu ${cle} @ ${s.sha.slice(0, 7)}…` : `Déploiement ${cle} @ ${s.sha.slice(0, 7)}…`)
    statut[cle] = { ...actuel, etat: "en_cours", sha_demande: s.sha, demande_le: s.demande_le, reprises: decision === "reprendre" ? (actuel.reprises ?? 0) + 1 : 0, le: horodatage() }
    ecrireStatut(statut)
    try {
      const r = s.environnement === "apercu" ? await deployerApercu(s) : await deployerProduction(s, actuel?.conteneur ? actuel : null)
      // boite : la version des clés de la console reçue par ce conteneur (jamais une empreinte des valeurs).
      statut[cle] = { etat: "ok", sha: s.sha, demande_le: s.demande_le, hote: s.hote, hote_mails: s.hote_mails ?? null, acces: s.acces ?? "protege", chemins_publics: r.publics ?? [], conteneur: r.conteneur, couleur: r.couleur ?? null, boite: boite?.version ?? null, le: horodatage() }
      ecrireStatut(statut)
      await regenererCaddy(statut)
      if (r.ancien) {
        await pause(5_000) // laisser Caddy basculer avant d'arrêter l'ancienne couleur
        await lancer("docker", ["rm", "-f", r.ancien])
      }
      log(`${cle} en ligne (${r.conteneur}).`)
      obs.evenement("deploiement", proprietesDeploiement(s, "ok", { debut, reprise: decision === "reprendre", couleur: r.couleur ?? null }), { distinctId: `produit:${s.produit}` })
    } catch (error) {
      log(`${cle} en échec : ${error.message.split("\n")[0]}`)
      // L'ancienne version (si elle existe) reste servie : on garde son conteneur dans le statut.
      statut[cle] = { ...versionServie(actuel), etat: "echec", sha: s.sha, demande_le: s.demande_le, message: error.message.slice(0, 2000), le: horodatage() }
      ecrireStatut(statut)
      obs.evenement("deploiement", proprietesDeploiement(s, "echec", { debut, reprise: decision === "reprendre", erreur: error }), { distinctId: `produit:${s.produit}` })
    }
  }
  await retirerAbsents(souhaits, statut)
  await regenererCaddy(statut)
}

// --- Retirer ce qui n'est plus souhaité ---------------------------------------------
// Garde-fous : une absence doit être vue 3 tours de suite, 2 retraits au plus par tour,
// et rien du tout si l'état souhaité paraît vide alors que des produits tournent.
const absences = new Map()
async function retirerAbsents(souhaits, statut) {
  const voulus = new Set(souhaits.filter(valide).map((s) => `${s.environnement}/${s.produit}`))
  const enPlace = Object.keys(statut)
  if (voulus.size === 0 && enPlace.length > 0) return
  let retraits = 0
  for (const cle of enPlace) {
    if (voulus.has(cle)) {
      absences.delete(cle)
      continue
    }
    absences.set(cle, (absences.get(cle) ?? 0) + 1)
    if (absences.get(cle) < 3 || retraits >= 2) continue
    retraits += 1
    absences.delete(cle)
    await retirer(cle, statut[cle]).catch((e) => log(`Retrait de ${cle} : ${e.message}`))
    delete statut[cle]
    ecrireStatut(statut)
  }
}

async function retirer(cle, s) {
  const [environnement, produit] = cle.split("/")
  if (!/^[a-z0-9-]{3,24}$/.test(produit ?? "")) return
  log(`Retrait de ${cle}…`)
  if (environnement === "apercu") {
    // Les données d'un aperçu sont fictives ; elles sont quand même sauvegardées avant.
    const volume = `usine-apercu-${produit}-data`
    if ((await lancer("docker", ["volume", "inspect", volume])).code === 0) {
      await lancer("docker", ["run", "--rm", "--user", "root", "--entrypoint", "tar", "-v", `${volume}:/d:ro`, "-v", "usine-sauvegardes:/s", IMAGE_OUTILS, "czf", `/s/${produit}-apercu-${horodatage().replace(/[:.]/g, "-")}.tgz`, "-C", "/d", "."])
    }
    await lancer("docker", ["rm", "-f", `usine-apercu-${produit}`])
    await lancer("docker", ["volume", "rm", volume])
  } else {
    // Production : les conteneurs s'arrêtent, les données restent (« supprimer_des_donnees : jamais »).
    for (const couleur of ["blue", "green"]) await lancer("docker", ["rm", "-f", `usine-prod-${produit}-${couleur}`])
  }
  // Plus aucun environnement pour ce produit : ses images et ses sources partent aussi.
  const restant = Object.keys(lireStatut()).some((k) => k !== cle && k.endsWith(`/${produit}`))
  if (!restant) {
    const images = (await lancer("docker", ["image", "ls", "-q", `usine-produit-${produit}`])).sortie.split("\n").filter(Boolean)
    if (images.length) await lancer("docker", ["image", "rm", "-f", ...new Set(images)])
    await lancer("rm", ["-rf", join(SRV, "produits", produit)])
    await supprimerReseau(produit)
  }
  log(`${cle} retiré.`)
}

// --- La santé du serveur et des conteneurs ---------------------------------------------
// Ce que le déployeur envoie vraiment à Sentry et PostHog (la console l'affiche) : jamais une clé.
function resumeObservabilite() {
  const e = obs.etat()
  const canal = (c) => ({ envoyes: e[c].envoyes, echecs: e[c].echecs, joignable: e[c].joignable, dernier_ok: e[c].dernier_ok, dernier_echec: e[c].dernier_echec })
  return { sentry: e.sentry, posthog: e.posthog, erreurs: canal("erreurs"), evenements: canal("evenements"), journaux: canal("journaux") }
}
const FICHIER_SANTE = join(ETAT, "sante.json")
let placeProduits = {}
let dernierEntretien = null
let miseAJour = { disponible: 0, commits: [], version: null, verifie_le: null, en_cours: null, derniere: null }

async function mesurerPlace() {
  // La place de chaque produit : ses images et ses volumes (docker system df -v).
  const r = await lancer("docker", ["system", "df", "-v", "--format", "{{json .}}"], { minutes: 3, max: 20_000_000 })
  if (r.code !== 0) return
  let d
  try {
    d = JSON.parse(r.sortie)
  } catch {
    return
  }
  const octets = (t) => {
    const m = String(t ?? "").match(/^([\d.]+)\s*([kKMGT]?)B/)
    return m ? Number(m[1]) * { "": 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2]] : 0
  }
  const place = {}
  const ajouter = (produit, cle, n) => {
    place[produit] ??= { images_mo: 0, volumes_mo: 0 }
    place[produit][cle] += Math.round(n / 1e6)
  }
  for (const i of d.Images ?? []) {
    const m = String(i.Repository ?? "").match(/^usine-produit-([a-z0-9-]+)$/)
    if (m) ajouter(m[1], "images_mo", octets(i.UniqueSize ?? i.Size))
  }
  for (const v of d.Volumes ?? []) {
    const m = String(v.Name ?? "").match(/^usine-(?:apercu|prod)-([a-z0-9-]+?)(?:-reel)?-data$/)
    if (m) ajouter(m[1], "volumes_mo", octets(v.Size))
  }
  placeProduits = place
}

async function ecrireSante() {
  const df = (await lancer("df", ["-B1", "--output=size,used,avail", "/"], { minutes: 1 })).sortie.trim().split("\n").pop().trim().split(/\s+/).map(Number)
  const mem = Object.fromEntries(readFileSync("/proc/meminfo", "utf8").split("\n").filter(Boolean).map((l) => [l.split(":")[0], Number(l.split(":")[1].trim().split(" ")[0]) * 1024]))
  // Docker trop lent ou injoignable : la liste est inconnue (null), pas vide.
  // Une liste vide ferait croire à la console que tous les conteneurs ont disparu.
  const ps = await lancer("docker", ["ps", "-a", "--format", "{{json .}}"], { minutes: 1 })
  const conteneurs = ps.code !== 0 ? null : ps.sortie.split("\n").filter(Boolean).flatMap((l) => {
    try {
      const c = JSON.parse(l)
      return [{ nom: c.Names, etat: c.State, statut: c.Status, image: c.Image }]
    } catch {
      return []
    }
  }).filter((c) => /^usine-/.test(c.nom))
  const sante = {
    le: horodatage(),
    disque: { total_go: +(df[0] / 1e9).toFixed(1), utilise_go: +(df[1] / 1e9).toFixed(1), libre_go: +(df[2] / 1e9).toFixed(1), pct: Math.round((df[1] / df[0]) * 100) },
    memoire: { total_mo: Math.round(mem.MemTotal / 1e6), dispo_mo: Math.round(mem.MemAvailable / 1e6), swap_utilise_mo: Math.round((mem.SwapTotal - mem.SwapFree) / 1e6) },
    charge: readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).map(Number),
    conteneurs,
    produits: placeProduits,
    entretien: dernierEntretien,
    mise_a_jour: miseAJour,
    boucle_le: boucleLe, // la fin du dernier tour de déploiement : un tour bloqué se voit
    applications: etatApplications, // la sonde des produits (sonderProduits), produit par produit
    boite: boite ? { version: boite.version, le: boite.le } : null,
    observabilite: resumeObservabilite(),
  }
  writeFileSync(`${FICHIER_SANTE}.tmp`, JSON.stringify(sante, null, 2))
  renameSync(`${FICHIER_SANTE}.tmp`, FICHIER_SANTE)
}

// Le bilan de santé a son propre rythme (30 s), hors de la boucle des déploiements : un tour
// bloqué (réseau coupé, git qui attend) ne doit pas figer la console sur un vieux bilan.
let santeEnCours = false
let boucleLe = null
async function bilanSante() {
  if (santeEnCours) return
  santeEnCours = true
  try {
    appliquerBoite()
    await ecrireSante()
  } catch (e) {
    log(`Santé : ${e.message}`)
  } finally {
    santeEnCours = false
  }
}

// --- La sonde des produits (chaque minute) ------------------------------------------------
// L'état réel de chaque application, aperçus et productions : état Docker, santé, redémarrages
// (un produit qui plante en boucle paraît « running » entre deux redémarrages), réponse de
// /api/health et version qui tourne. Le jugement est dans sonde.mjs ; l'orchestrateur en fait
// une ligne de santé par produit, et une alerte quand l'état change. Lecture seule : la sonde
// ne redémarre rien, et elle a son propre rythme, hors de la boucle des déploiements.
let etatApplications = null
const redemarrages = new Map()
const enBoucle = new Set()
let sondeEnCours = false

// /api/health, sans suivre de redirection (une réponse 3xx d'un produit ne doit pas faire
// appeler par le déployeur une autre adresse de ses réseaux). Une absence de réponse est
// revérifiée une fois, 2 s plus tard, avant d'être retenue.
async function sonderSante(conteneur) {
  for (let essai = 0; ; essai++) {
    const debut = Date.now()
    try {
      const res = await fetch(`http://${conteneur}:3000/api/health`, { signal: AbortSignal.timeout(10_000), redirect: "manual" })
      await res.body?.cancel().catch(() => {})
      return { code: res.status, ms: Date.now() - debut }
    } catch {
      if (essai >= 1) return { code: null, ms: Date.now() - debut }
      await pause(2_000)
    }
  }
}

async function sonderProduits() {
  if (sondeEnCours) return
  sondeEnCours = true
  try {
    // statut.json d'abord : un déploiement qui se termine pendant la sonde est vu comme « en cours », pas comme une panne.
    const statut = lireStatut()
    const inconnu = () => (etatApplications = { le: horodatage(), produits: null })
    const ps = await lancer("docker", ["ps", "-a", "--format", "{{.Names}}"], { minutes: 1 })
    // Docker injoignable : l'état des produits est inconnu, pas « tous absents ».
    if (ps.code !== 0) return inconnu()
    const noms = ps.sortie.split("\n").map((n) => n.trim()).filter((n) => cleDuConteneur(n))
    const inspect = noms.length ? await lancer("docker", ["inspect", "--format", FORMAT_INSPECT, ...noms], { minutes: 1 }) : { code: 0, sortie: "" }
    const conteneurs = lireInspect(inspect.sortie)
    // Un conteneur parti entre les deux commandes est nommé dans l'erreur d'inspect ; un inspect coupé ou sans démon ne dit rien : relevé sans valeur.
    if (inspect.code !== 0 && inspectIncomplet(noms, conteneurs, inspect.sortie)) return inconnu()
    const http = Object.fromEntries(await Promise.all(conteneurs.filter((c) => c.etat === "running").map(async (c) => [c.nom, await sonderSante(c.nom)])))
    const t = Date.now()
    const age = (s) => (s.le ? t - new Date(s.le).getTime() : 0)
    // Le serveur construit : un déploiement en cours, ou la reconstruction de l'usine elle-même.
    const construction = Boolean(miseAJour.en_cours) || Object.values(statut).some((s) => s.etat === "en_cours" && age(s) <= DEPLOIEMENT_BLOQUE_MS)
    const produits = {}
    for (const cle of new Set([...conteneurs.map((c) => cleDuConteneur(c.nom)), ...Object.keys(statut)])) {
      const s = statut[cle] ?? {}
      const environnement = cle.split("/")[0]
      const choisi = conteneurActif(conteneurs.filter((x) => cleDuConteneur(x.nom) === cle), s.conteneur)
      // Pendant un déploiement : le conteneur qu'il démarre (premier déploiement, ou aperçu recréé sous le même nom après le début du déploiement).
      const demarre = choisi ? new Date(choisi.demarre_le).getTime() : NaN
      const nouveau = Boolean(choisi) && s.etat === "en_cours" && (!s.conteneur || (environnement === "apercu" && demarre > new Date(s.le).getTime()))
      const c = choisi ? { ...choisi, nouveau, demarre_apres_demande: Boolean(s.demande_le) && demarre > new Date(s.demande_le).getTime() } : null
      const recents = c ? noterRedemarrages(redemarrages, c.nom, c.redemarrages, t) : 0
      const jugement = jugerProduit({ environnement, attendu: Boolean(s.conteneur), deploiement: s.etat ?? null, depuis_ms: age(s), conteneur: c, http: c ? http[c.nom] ?? null : null, recents, en_boucle: enBoucle.has(cle), construction })
      if (jugement?.boucle) enBoucle.add(cle)
      else enBoucle.delete(cle)
      if (!jugement) continue
      const { boucle, ...j } = jugement
      produits[cle] = {
        ...j,
        conteneur: c?.nom ?? s.conteneur ?? null,
        version: versionDeLImage(c?.image) ?? (s.sha ? s.sha.slice(0, 12) : null),
        deploiement: s.etat ?? null,
        docker: c ? { etat: c.etat, sante: c.sante, redemarrages: c.redemarrages, redemarrages_30_min: recents, demarre_le: c.demarre_le, code_sortie: c.code_sortie, oom: c.oom } : null,
        http: c ? http[c.nom] ?? null : null,
      }
    }
    for (const nom of redemarrages.keys()) if (!conteneurs.some((c) => c.nom === nom)) redemarrages.delete(nom)
    for (const cle of enBoucle) if (!produits[cle]) enBoucle.delete(cle)
    etatApplications = { le: horodatage(), produits }
    observerProduits(produits)
  } catch (e) {
    log(`Sonde des produits : ${e.message}`)
  } finally {
    sondeEnCours = false
  }
  // Publié tout de suite : l'orchestrateur ne lit pas deux fois la même mesure comme deux constats.
  await bilanSante()
}

// L'état de chaque produit vers PostHog (etat_produit : toutes les 5 min, et à chaque changement),
// et un incident Sentry quand son état confirmé devient « panne » (observation.mjs). Un relevé sans
// valeur (Docker injoignable) n'est jamais transmis : il ne dit rien des produits.
const memoireEtats = new Map()
function observerProduits(produits) {
  const { evenements, incidents } = suivreEtats(memoireEtats, produits)
  for (const e of evenements) obs.evenement("etat_produit", e, { distinctId: `produit:${e.produit}` })
  for (const i of incidents) {
    obs.incident(`${i.produit} (${i.environnement}) en panne : ${i.raison}`, {
      environnement: i.environnement,
      etiquettes: { produit: i.produit, version: i.version, deploiement: i.deploiement },
      // Toutes les pannes d'un même produit dans un même sujet Sentry.
      empreinte: ["panne", i.environnement, i.produit],
    })
  }
}

// --- L'entretien (toutes les 6 heures) --------------------------------------------------
async function entretenir() {
  const avant = Number((await lancer("df", ["-B1", "--output=used", "/"])).sortie.trim().split("\n").pop())
  const utilisees = new Set((await lancer("docker", ["ps", "-a", "--format", "{{.Image}}"])).sortie.split("\n").filter(Boolean))
  const produits = new Set((await lancer("docker", ["image", "ls", "--format", "{{.Repository}}"])).sortie.split("\n").filter((r) => /^usine-produit-/.test(r)))
  let images = 0
  for (const depot of produits) {
    // Les plus récentes d'abord ; on garde celles en service et les 2 dernières.
    const liste = (await lancer("docker", ["image", "ls", depot, "--format", "{{.Repository}}:{{.Tag}}"])).sortie.split("\n").filter(Boolean)
    for (const [i, image] of liste.entries()) {
      if (i < 2 || utilisees.has(image)) continue
      if ((await lancer("docker", ["image", "rm", image])).code === 0) images += 1
    }
  }
  await lancer("docker", ["image", "prune", "-f"])
  await lancer("docker", ["builder", "prune", "-f", "--keep-storage", "3GB"], { minutes: 10 })
  await lancer("docker", ["run", "--rm", "--user", "root", "--entrypoint", "find", "-v", "usine-sauvegardes:/s", IMAGE_OUTILS, "/s", "-name", "*.tgz", "-mtime", "+30", "-delete"])
  const apres = Number((await lancer("df", ["-B1", "--output=used", "/"])).sortie.trim().split("\n").pop())
  dernierEntretien = { le: horodatage(), images_supprimees: images, libere_mo: Math.max(0, Math.round((avant - apres) / 1e6)) }
  log(`Entretien : ${images} image(s) supprimée(s), ${dernierEntretien.libere_mo} Mo libérés.`)
}

// --- La mise à jour de l'usine ----------------------------------------------------------
// Vérifier : le dépôt de l'usine (monté au même chemin) est comparé à GitHub.
// Un échec n'est plus muet : il est journalisé (au changement de message) et publié dans le
// bilan de santé (mise_a_jour.erreur), sinon l'usine se croit à jour sans l'être.
async function verifierMiseAJour() {
  if (!USINE_DIR || !DEPOT_USINE || !existsSync(join(USINE_DIR, ".git"))) return
  const git = (args, options = {}) => lancer("git", ["-c", `safe.directory=${USINE_DIR}`, "-C", USINE_DIR, ...args], options)
  // 3 minutes au plus : un fetch bloqué ne doit pas suspendre les vérifications suivantes.
  // La connexion de la console d'abord, puis le jeton du serveur, puis sans jeton (dépôt public).
  const sources = { console: jetonConsole(), serveur: JETON }
  let f
  for (const jeton of jetonsMiseAJour(sources)) {
    f = await git(["fetch", "-q", `https://github.com/${DEPOT_USINE}.git`, "main:refs/remotes/github/main"], { git: { jeton }, minutes: 3 })
    if (f.code === 0) {
      if (miseAJour.source !== origineJeton(jeton, sources)) log(`Mise à jour de l'usine : dépôt lu avec ${origineJeton(jeton, sources)}.`)
      miseAJour = { ...miseAJour, source: origineJeton(jeton, sources) }
      break
    }
  }
  if (f.code !== 0) {
    const message = (f.sortie.trim().split("\n").filter(Boolean).slice(-3).join(" · ") || (f.code === null ? "interrompu au bout de 3 min" : `code ${f.code}`)).slice(0, 400)
    if (miseAJour.erreur?.message !== message) log(`Vérification de mise à jour impossible (git fetch ${DEPOT_USINE}) : ${message}`)
    miseAJour = { ...miseAJour, erreur: { message, depuis: miseAJour.erreur?.depuis ?? horodatage(), le: horodatage() } }
    return
  }
  if (miseAJour.erreur) log(`Vérification de mise à jour rétablie (en échec depuis ${miseAJour.erreur.depuis}).`)
  await lancer("chown", ["-R", "1000:1000", join(USINE_DIR, ".git")])
  const commits = (await git(["log", "--format=%h %s", "HEAD..refs/remotes/github/main"])).sortie.split("\n").filter(Boolean)
  miseAJour = { ...miseAJour, erreur: null, disponible: commits.length, commits: commits.slice(0, 15), version: (await git(["rev-parse", "--short", "HEAD"])).sortie.trim(), verifie_le: horodatage() }
}

// Appliquer : un conteneur d'aide (il survit au redémarrage du déployeur) remet le dépôt
// à jour, reconstruit et relance l'usine. Les données et les secrets ne bougent pas.
async function appliquerMiseAJour(demande) {
  if (!USINE_DIR || !existsSync(join(USINE_DIR, ".git"))) return log("Mise à jour impossible : USINE_DIR n'est pas monté.")
  log(`Mise à jour de l'usine demandée par ${demande.par ?? "?"}…`)
  miseAJour = { ...miseAJour, en_cours: demande.demande_le }
  await bilanSante()
  const gidDocker = (await lancer("stat", ["-c", "%g", "/var/run/docker.sock"])).sortie.trim()
  await lancer("docker", ["rm", "-f", "usine-mise-a-jour"])
  // Toute erreur arrête la mise à jour avant le redémarrage : l'usine continue alors dans sa
  // version actuelle. La construction est réessayée (le réseau de l'hébergeur a des coupures).
  const script = [
    "set -eo pipefail",
    // Les secrets que la nouvelle version attend existent sur le serveur, sinon rien ne change.
    ...scriptVerifierSecrets(USINE_DIR, IMAGE_OUTILS),
    `git -c safe.directory=${USINE_DIR} reset -q --hard refs/remotes/github/main`,
    "for essai in 1 2 3; do if docker compose build --pull > /tmp/construction.log 2>&1; then break; fi; tail -3 /tmp/construction.log; [ $essai = 3 ] && exit 1; sleep 30; done",
    "grep -E 'Built|ERROR' /tmp/construction.log | tail -10 || true",
    "docker compose up -d --remove-orphans",
  ].join("\n")
  const r = await lancer("docker", ["run", "-d", "--name", "usine-mise-a-jour", "--user", `1000:${gidDocker}`, "-e", "HOME=/tmp",
    "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", `${USINE_DIR}:${USINE_DIR}`, "-w", USINE_DIR,
    "--entrypoint", "bash", "usine-logicielle-deployeur", "-c", script])
  if (r.code !== 0) log(`Mise à jour : lancement impossible : ${r.sortie.slice(-300)}`)
  // Le déployeur peut être recréé pendant la mise à jour : la demande est notée sur le volume,
  // et la fin est constatée par suivreMiseAJour() (ici, ou au redémarrage).
  writeFileSync(join(ETAT, "mise-a-jour.json"), JSON.stringify({ demande_le: demande.demande_le, par: demande.par, lancee_le: horodatage() }))
}

// La fin de la mise à jour : le conteneur d'aide s'est arrêté ? On note le résultat
// (réussite ou échec, avec la cause) et la nouvelle version, tout de suite.
async function suivreMiseAJour() {
  if (!miseAJour.en_cours) return
  const etat = (await lancer("docker", ["inspect", "-f", "{{.State.Status}} {{.State.ExitCode}}", "usine-mise-a-jour"])).sortie.trim()
  const [statut, code] = etat.split(" ")
  if (statut !== "exited") return
  const journal = (await lancer("docker", ["logs", "--tail", "15", "usine-mise-a-jour"])).sortie
  await verifierMiseAJour().catch(() => {})
  let demande = {}
  try {
    demande = JSON.parse(readFileSync(join(ETAT, "mise-a-jour.json"), "utf8"))
  } catch {}
  miseAJour = { ...miseAJour, en_cours: null, derniere: { ...demande, terminee_le: horodatage(), code: Number(code), reussie: code === "0", journal: code === "0" ? "" : journal.slice(-1500), version: miseAJour.version } }
  log(code === "0" ? `Mise à jour terminée (version ${miseAJour.version}).` : `Mise à jour en échec (code ${code}).`)
  // Le résultat est noté : le conteneur d'aide n'a plus de raison d'exister.
  await lancer("docker", ["rm", "-f", "usine-mise-a-jour"])
}

// Les journaux récents de chaque produit en ligne, sur le volume partagé : quand
// une correction est demandée, l'analyste enquête sur ce qui s'est vraiment passé.
// Les lignes nouvelles partent aussi vers PostHog (service.name = le produit, deployment.environment),
// masquées par le module commun. La dernière ligne envoyée de chaque conteneur est notée sur le
// volume : un redémarrage du déployeur ne renvoie pas les mêmes lignes.
async function publierJournaux() {
  const dossier = join(ETAT, "journaux")
  mkdirSync(dossier, { recursive: true })
  const fichierEnvois = join(dossier, ".envoyes-posthog.json")
  let envoyes = null
  if (obs.actif.posthog) {
    try {
      envoyes = JSON.parse(readFileSync(fichierEnvois, "utf8"))
    } catch {
      envoyes = {}
    }
  }
  const suivis = {}
  for (const [cle, s] of Object.entries(lireStatut())) {
    if (!s.conteneur) continue
    if (envoyes?.[s.conteneur]) suivis[s.conteneur] = envoyes[s.conteneur] // gardé si docker logs échoue
    const r = await lancer("docker", ["logs", "--tail", "200", "--timestamps", s.conteneur])
    if (r.code !== 0) continue
    const texte = r.sortie.split("\n").filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).join("\n")
    writeFileSync(join(dossier, `${cle.replace("/", "-")}.log`), texte)
    if (!envoyes) continue
    const [environnement, produit] = cle.split("/")
    const lignes = lignesNouvelles(texte, envoyes[s.conteneur])
    for (const l of lignes) obs.journal(l.texte, { niveau: l.niveau, horodatage: l.horodatage, service: produit, environnement, version: s.sha ? s.sha.slice(0, 12) : null, attributs: { conteneur: s.conteneur } })
    suivis[s.conteneur] = lignes.at(-1)?.horodatage ?? envoyes[s.conteneur] ?? null
  }
  // Seuls les conteneurs encore en service restent notés.
  if (envoyes) writeFileSync(fichierEnvois, JSON.stringify(suivis))
}

// Les produits déjà déployés passent sur leur propre réseau, puis quittent les réseaux communs
// (celui de l'usine, celui des produits). Caddy est branché d'abord : pas de coupure.
async function isolerProduits() {
  for (const [cle, s] of Object.entries(lireStatut())) {
    if (!s.conteneur) continue
    const produit = cle.split("/")[1]
    if (!/^[a-z0-9-]{3,24}$/.test(produit ?? "")) continue
    const reseau = await preparerReseau(produit, { avecMailpit: Boolean(s.hote_mails) })
    if (reseau === RESEAU) continue
    const reseaux = (await lancer("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", s.conteneur])).sortie
    if (!reseaux.includes(`"${reseau}"`)) await brancher(reseau, s.conteneur)
    for (const commun of new Set(["usine", RESEAU])) {
      if (reseaux.includes(`"${commun}"`)) {
        await lancer("docker", ["network", "disconnect", commun, s.conteneur])
        log(`${s.conteneur} isolé sur le réseau ${reseau} (quitte ${commun}).`)
      }
    }
  }
}

mkdirSync(ETAT, { recursive: true })
mkdirSync(join(SRV, "produits"), { recursive: true })
if (existsSync(BOITE) && !lireBoite(BOITE)) {
  for (let i = 0; i < 30 && !lireBoite(BOITE); i++) await pause(2_000)
  log(lireBoite(BOITE) ? "Boîte de la console lue." : "Boîte de la console absente après 60 s : les clés du serveur servent en attendant.")
}
await bilanSante()
setInterval(bilanSante, 30_000)
await isolerProduits().catch((e) => log(`Isolement des produits : ${e.message}`))
// Après l'isolement : le déployeur est branché sur le réseau de chaque produit, il peut les joindre.
// Sans attendre : la première sonde ne retarde pas le premier tour de déploiement (elle ne rejette jamais).
sonderProduits()
setInterval(sonderProduits, 60_000)
log(`Déployeur prêt : tire ${depotEtat() || "(dépôt d'état pas encore connu : GitHub à connecter dans la console)"} toutes les 20 s.`)
// Une mise à jour vient d'être appliquée : on note sa fin (l'orchestrateur l'annonce).
let derniereDemande = null
try {
  const m = JSON.parse(readFileSync(join(ETAT, "mise-a-jour.json"), "utf8"))
  derniereDemande = m.demande_le
  // Le conteneur d'aide existe encore : la mise à jour est peut-être en cours, on la suit.
  if ((await lancer("docker", ["inspect", "usine-mise-a-jour"])).code === 0) miseAJour = { ...miseAJour, en_cours: m.demande_le }
} catch {}
for (let n = 0; ; n++) {
  await tour().catch((e) => log(`Tour en échec : ${e.message.split("\n")[0]}`))
  if (n % 3 === 0) await publierJournaux().catch((e) => log(`Journaux : ${e.message}`))
  if (n % 9 === 0) await mesurerPlace().catch((e) => log(`Place : ${e.message}`))
  if (n % 30 === 0) await verifierMiseAJour().catch((e) => log(`Vérification de mise à jour : ${e.message}`))
  if (n % 1080 === 540) await entretenir().catch((e) => log(`Entretien : ${e.message}`))
  await suivreMiseAJour().catch((e) => log(`Suivi de la mise à jour : ${e.message}`))
  boucleLe = horodatage()
  await bilanSante()
  if (demandeMiseAJour?.demande_le && demandeMiseAJour.demande_le !== derniereDemande) {
    derniereDemande = demandeMiseAJour.demande_le
    await verifierMiseAJour().catch(() => {})
    await appliquerMiseAJour(demandeMiseAJour).catch((e) => log(`Mise à jour : ${e.message}`))
  }
  await pause(20_000)
}
