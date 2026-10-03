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
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const env = process.env
const DEPOT_ETAT = env.DEPOT_ETAT // proprietaire/usine-etat
const JETON = env.GITHUB_TOKEN
const ETAT = env.ETAT_DIR ?? "/etat"
const CADDY = env.CADDY_DIR ?? "/caddy"
const SRV = env.SRV_DIR ?? "/srv"
const RESEAU = env.RESEAU ?? "usine"
const MEMOIRE = env.MEMOIRE_PRODUIT ?? "384m"
const HTTPS = env.HTTPS !== "0"
// Des résolveurs de secours pour les produits aussi (coupures DNS de l'hébergeur).
const DNS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"].flatMap((d) => ["--dns", d])
if (!DEPOT_ETAT || !JETON) throw new Error("DEPOT_ETAT et GITHUB_TOKEN sont requis.")

const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const horodatage = () => new Date().toISOString()
const log = (...a) => console.log(horodatage(), ...a)

// Le jeton passe par la configuration git de l'environnement : jamais dans les
// arguments (visibles dans ps) ni dans .git/config.
const envGit = {
  ...env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${JETON}`).toString("base64")}`,
}

// Une commande, sans shell (les valeurs ne sont jamais interprétées).
function lancer(cmd, args, { cwd, git = false, minutes = 15 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: git ? envGit : env })
    let sortie = ""
    const garder = (d) => (sortie = (sortie + d).slice(-20_000))
    p.stdout.on("data", garder)
    p.stderr.on("data", garder)
    const minuterie = setTimeout(() => p.kill("SIGKILL"), minutes * 60_000)
    p.on("close", (code) => {
      clearTimeout(minuterie)
      resolve({ code, sortie: sortie.replaceAll(JETON, "***") })
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

async function synchroniserEtat() {
  const dossier = join(SRV, "etat")
  if (!existsSync(join(dossier, ".git"))) await ok("git", ["clone", "-q", `https://github.com/${DEPOT_ETAT}.git`, dossier], { git: true })
  else {
    await ok("git", ["fetch", "-q", "origin"], { cwd: dossier, git: true })
    await ok("git", ["reset", "-q", "--hard", "origin/HEAD"], { cwd: dossier })
  }
  const souhaits = []
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
    && ["apercu", "production"].includes(s.environnement) && [undefined, "demo", "vide"].includes(s.donnees) && [undefined, "captures", "reels"].includes(s.emails) && /^[a-z0-9.-]+$/.test(s.hote ?? "") && (!s.hote_mails || /^[a-z0-9.-]+$/.test(s.hote_mails))
}

const VARIABLES = ["DEMO", "DEMO_VITESSE_HORLOGE", "PUBLIC_URL", "LLM_MODELE", "EMAIL_DESTINATAIRES_AUTORISES"]
function variables(s) {
  const v = { PORT: "3000", DATA_DIR: "/app/data" }
  for (const k of VARIABLES) if (s.env?.[k] !== undefined) v[k] = String(s.env[k])
  if ((s.services ?? []).includes("mailpit")) Object.assign(v, { SMTP_HOST: "mailpit", SMTP_PORT: "1025" })
  // Emails réels : le service d'envoi vient du .env du serveur, jamais du dépôt d'état.
  if (s.emails === "reels") {
    if (!env.SMTP_HOST) throw new Error("emails réels demandés mais SMTP_HOST n'est pas configuré")
    for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "SMTP_SECURE", "EMAIL_EXPEDITEUR"]) if (env[k]) v[k] = env[k]
  }
  if (env.AI_GATEWAY_API_KEY) v.AI_GATEWAY_API_KEY = env.AI_GATEWAY_API_KEY
  return Object.entries(v).flatMap(([k, val]) => ["-e", `${k}=${val}`])
}

async function sante(conteneur, secondes = 90) {
  const limite = Date.now() + secondes * 1000
  while (Date.now() < limite) {
    try {
      const res = await fetch(`http://${conteneur}:3000/api/health`, { signal: AbortSignal.timeout(5_000) })
      if (res.ok) return true
    } catch {}
    await pause(3_000)
  }
  return false
}

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
  return image
}

async function demarrer(nom, image, volume, s) {
  await lancer("docker", ["rm", "-f", nom])
  await ok("docker", ["run", "-d", "--name", nom, "--network", RESEAU, "--restart", "unless-stopped", ...DNS, "--memory", MEMOIRE, "--label", "usine.produit=" + s.produit, "-v", `${volume}:/app/data`, ...variables(s), image])
}

async function deployerApercu(s) {
  const image = await construire(s)
  const nom = `usine-apercu-${s.produit}`
  await demarrer(nom, image, `usine-apercu-${s.produit}-data`, s)
  if (!(await sante(nom))) {
    const journal = (await lancer("docker", ["logs", "--tail", "40", nom])).sortie
    throw new Error(`l'aperçu ne répond pas à /api/health :\n${journal}`)
  }
  return { conteneur: nom }
}

async function deployerProduction(s, precedent) {
  const image = await construire(s)
  // Une base par mode : passer de la démo à la vraie utilisation ne mélange rien (l'autre base est gardée).
  const volume = `usine-prod-${s.produit}${s.donnees === "vide" ? "-reel" : ""}-data`
  // Sauvegarde du volume avant toute bascule (s'il existe déjà).
  if ((await lancer("docker", ["volume", "inspect", volume])).code === 0) {
    const archive = `${s.produit}-${horodatage().replace(/[:.]/g, "-")}.tgz`
    await ok("docker", ["run", "--rm", "--user", "root", "-v", `${volume}:/d:ro`, "-v", "usine-sauvegardes:/s", "--entrypoint", "tar", image, "czf", `/s/${archive}`, "-C", "/d", "."])
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
  return { conteneur: nom, couleur, ancien: precedent?.conteneur && precedent.conteneur !== nom ? precedent.conteneur : null }
}

// --- Caddy ----------------------------------------------------------------------
async function regenererCaddy(statut) {
  const site = (hote) => (HTTPS ? hote : `http://${hote}`)
  const blocs = []
  const mails = new Set()
  for (const s of Object.values(statut)) {
    if (!s.conteneur || !s.hote) continue
    blocs.push(`${site(s.hote)} {\n\tencode zstd gzip\n\treverse_proxy ${s.conteneur}:3000\n}`)
    if (s.hote_mails) mails.add(s.hote_mails)
  }
  for (const h of mails) blocs.push(`${site(h)} {\n\treverse_proxy mailpit:8025\n}`)
  // Le tableau de bord des coûts de l'usine (protégé par mot de passe par l'orchestrateur).
  if (env.TABLEAU_HOTE && /^[a-z0-9.-]+$/.test(env.TABLEAU_HOTE)) blocs.push(`${site(env.TABLEAU_HOTE)} {\n\treverse_proxy orchestrateur:8091\n}`)
  const global = env.CADDY_EMAIL ? `{\n\temail ${env.CADDY_EMAIL}\n}\n\n` : ""
  const contenu = `# Généré par le déployeur de l'usine logicielle : ne pas modifier à la main.\n${global}${blocs.length ? blocs.join("\n\n") : ":80 {\n\trespond \"Usine logicielle : aucun produit déployé pour l'instant.\" 200\n}"}\n`
  const fichier = join(CADDY, "Caddyfile")
  if (existsSync(fichier) && readFileSync(fichier, "utf8") === contenu) return
  writeFileSync(fichier, contenu)
  const r = await lancer("docker", ["exec", "usine-caddy", "caddy", "reload", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"])
  log(r.code === 0 ? "Caddy rechargé." : `Rechargement de Caddy impossible : ${r.sortie.slice(-500)}`)
}

// --- La boucle ----------------------------------------------------------------
async function tour() {
  const souhaits = await synchroniserEtat()
  const statut = lireStatut()
  for (const s of souhaits) {
    if (!valide(s)) {
      log(`État refusé (champs invalides) : ${JSON.stringify(s).slice(0, 200)}`)
      continue
    }
    const cle = `${s.environnement}/${s.produit}`
    const actuel = statut[cle]
    if (actuel?.sha === s.sha && actuel?.demande_le === s.demande_le) continue
    log(`Déploiement ${cle} @ ${s.sha.slice(0, 7)}…`)
    statut[cle] = { ...actuel, etat: "en_cours", sha_demande: s.sha, demande_le: s.demande_le, le: horodatage() }
    ecrireStatut(statut)
    try {
      const r = s.environnement === "apercu" ? await deployerApercu(s) : await deployerProduction(s, actuel?.conteneur ? actuel : null)
      statut[cle] = { etat: "ok", sha: s.sha, demande_le: s.demande_le, hote: s.hote, hote_mails: s.hote_mails ?? null, conteneur: r.conteneur, couleur: r.couleur ?? null, le: horodatage() }
      ecrireStatut(statut)
      await regenererCaddy(statut)
      if (r.ancien) {
        await pause(5_000) // laisser Caddy basculer avant d'arrêter l'ancienne couleur
        await lancer("docker", ["rm", "-f", r.ancien])
      }
      log(`${cle} en ligne (${r.conteneur}).`)
    } catch (error) {
      log(`${cle} en échec : ${error.message.split("\n")[0]}`)
      // L'ancienne version (si elle existe) reste servie : on garde son conteneur dans le statut.
      statut[cle] = { ...(actuel?.conteneur ? { hote: actuel.hote, hote_mails: actuel.hote_mails, conteneur: actuel.conteneur, couleur: actuel.couleur } : {}), etat: "echec", sha: s.sha, demande_le: s.demande_le, message: error.message.slice(0, 2000), le: horodatage() }
      ecrireStatut(statut)
    }
  }
  await regenererCaddy(statut)
}

// Les journaux récents de chaque produit en ligne, sur le volume partagé : quand
// une correction est demandée, l'analyste enquête sur ce qui s'est vraiment passé.
async function publierJournaux() {
  const dossier = join(ETAT, "journaux")
  mkdirSync(dossier, { recursive: true })
  for (const [cle, s] of Object.entries(lireStatut())) {
    if (!s.conteneur) continue
    const r = await lancer("docker", ["logs", "--tail", "200", "--timestamps", s.conteneur])
    if (r.code !== 0) continue
    const texte = r.sortie.split("\n").filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).join("\n")
    writeFileSync(join(dossier, `${cle.replace("/", "-")}.log`), texte)
  }
}

mkdirSync(ETAT, { recursive: true })
mkdirSync(join(SRV, "produits"), { recursive: true })
log(`Déployeur prêt : tire ${DEPOT_ETAT} toutes les 20 s.`)
for (let n = 0; ; n++) {
  await tour().catch((e) => log(`Tour en échec : ${e.message.split("\n")[0]}`))
  if (n % 3 === 0) await publierJournaux().catch((e) => log(`Journaux : ${e.message}`))
  await pause(20_000)
}
