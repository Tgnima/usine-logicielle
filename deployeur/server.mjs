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
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"

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
// Les chemins d'une application joignables sans connexion : santé, pages publiques,
// suivi des emails et désinscription (un destinataire n'a pas de compte).
const CHEMINS_PUBLICS = ["/api/health", "/public/*", "/t/*", "/desinscription/*"]
const ETAT = env.ETAT_DIR ?? "/etat"
const CADDY = env.CADDY_DIR ?? "/caddy"
const SRV = env.SRV_DIR ?? "/srv"
const RESEAU = env.RESEAU ?? "usine"
const MEMOIRE = env.MEMOIRE_PRODUIT ?? "384m"
const HTTPS = env.HTTPS !== "0"
// Des résolveurs de secours pour les produits aussi (coupures DNS de l'hébergeur).
const DNS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"].flatMap((d) => ["--dns", d])
// Le dossier de l'usine sur le serveur, monté au même chemin (mise à jour de l'usine).
const USINE_DIR = env.USINE_DIR ?? ""
const DEPOT_USINE = env.DEPOT_USINE ?? ""
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

let demandeMiseAJour = null
async function synchroniserEtat() {
  const dossier = join(SRV, "etat")
  if (!existsSync(join(dossier, ".git"))) await ok("git", ["clone", "-q", `https://github.com/${DEPOT_ETAT}.git`, dossier], { git: true })
  else {
    await ok("git", ["fetch", "-q", "origin"], { cwd: dossier, git: true })
    await ok("git", ["reset", "-q", "--hard", "origin/HEAD"], { cwd: dossier })
  }
  const souhaits = []
  try {
    demandeMiseAJour = JSON.parse(readFileSync(join(dossier, "usine", "mise-a-jour.json"), "utf8"))
  } catch {
    demandeMiseAJour = null
  }
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
    && ["apercu", "production"].includes(s.environnement) && [undefined, "protege", "public"].includes(s.acces) && [undefined, "demo", "vide"].includes(s.donnees) && [undefined, "captures", "reels"].includes(s.emails) && /^[a-z0-9.-]+$/.test(s.hote ?? "") && (!s.hote_mails || /^[a-z0-9.-]+$/.test(s.hote_mails))
}

const VARIABLES = ["DEMO", "DEMO_VITESSE_HORLOGE", "PUBLIC_URL", "LLM_MODELE", "EMAIL_DESTINATAIRES_AUTORISES"]
function variables(s) {
  const v = { PORT: "3000", DATA_DIR: "/app/data" }
  for (const k of VARIABLES) if (s.env?.[k] !== undefined) v[k] = String(s.env[k])
  if ((s.services ?? []).includes("mailpit")) Object.assign(v, { SMTP_HOST: "mailpit", SMTP_PORT: "1025" })
  // Emails réels : le service d'envoi vient du .env du serveur, jamais du dépôt d'état.
  if (s.emails === "reels") {
    if (!env.SMTP_HOST) throw new Error("emails réels demandés mais SMTP_HOST n'est pas configuré")
    for (const k of ["SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "EMAIL_EXPEDITEUR"]) if (env[k]) v[k] = env[k]
    if (secret("smtp_user")) v.SMTP_USER = secret("smtp_user")
    if (secret("smtp_pass")) v.SMTP_PASS = secret("smtp_pass")
  }
  if (secret("ai_gateway_api_key")) v.AI_GATEWAY_API_KEY = secret("ai_gateway_api_key")
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
// Un site Caddy. Protégé (par défaut) : le portier vérifie chaque requête, sauf
// les chemins publics ; l'en-tête d'identité ne peut pas venir du visiteur.
function blocSite(hote, cible, { protege = true, publics = CHEMINS_PUBLICS } = {}) {
  const site = HTTPS ? hote : `http://${hote}`
  const entetes = `\theader {\n\t\tStrict-Transport-Security "max-age=31536000"\n\t\tX-Content-Type-Options "nosniff"\n\t\tReferrer-Policy "strict-origin-when-cross-origin"\n\t\tX-Frame-Options "SAMEORIGIN"\n\t\t-Server\n\t}\n`
  if (!protege) return `${site} {\n\tencode zstd gzip\n${entetes}\treverse_proxy ${cible}\n}`
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
  for (const s of Object.values(statut)) {
    if (!s.conteneur || !s.hote) continue
    // Un aperçu est toujours protégé ; une production l'est sauf choix explicite « public ».
    blocs.push(blocSite(s.hote, `${s.conteneur}:3000`, { protege: s.acces !== "public" || s.hote.includes(".apercu.") }))
    if (s.hote_mails) mails.add(s.hote_mails)
  }
  // Les adresses de l'usine elle-même : réservées aux administrateurs (le portier le vérifie).
  for (const h of mails) blocs.push(blocSite(h, "mailpit:8025", { publics: [] }))
  if (env.TABLEAU_HOTE && /^[a-z0-9.-]+$/.test(env.TABLEAU_HOTE)) blocs.push(blocSite(env.TABLEAU_HOTE, "orchestrateur:8091", { publics: [] }))
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
      statut[cle] = { etat: "ok", sha: s.sha, demande_le: s.demande_le, hote: s.hote, hote_mails: s.hote_mails ?? null, acces: s.acces ?? "protege", conteneur: r.conteneur, couleur: r.couleur ?? null, le: horodatage() }
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
      await lancer("docker", ["run", "--rm", "--user", "root", "--entrypoint", "tar", "-v", `${volume}:/d:ro`, "-v", "usine-sauvegardes:/s", "usine-logicielle-deployeur", "czf", `/s/${produit}-apercu-${horodatage().replace(/[:.]/g, "-")}.tgz`, "-C", "/d", "."])
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
  }
  log(`${cle} retiré.`)
}

// --- La santé du serveur et des conteneurs ---------------------------------------------
const FICHIER_SANTE = join(ETAT, "sante.json")
let placeProduits = {}
let dernierEntretien = null
let miseAJour = { disponible: 0, commits: [], version: null, verifie_le: null, en_cours: null, derniere: null }

async function mesurerPlace() {
  // La place de chaque produit : ses images et ses volumes (docker system df -v).
  const r = await lancer("docker", ["system", "df", "-v", "--format", "{{json .}}"], { minutes: 3 })
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
  const df = (await lancer("df", ["-B1", "--output=size,used,avail", "/"])).sortie.trim().split("\n").pop().trim().split(/\s+/).map(Number)
  const mem = Object.fromEntries(readFileSync("/proc/meminfo", "utf8").split("\n").filter(Boolean).map((l) => [l.split(":")[0], Number(l.split(":")[1].trim().split(" ")[0]) * 1024]))
  const conteneurs = (await lancer("docker", ["ps", "-a", "--format", "{{json .}}"])).sortie.split("\n").filter(Boolean).flatMap((l) => {
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
  }
  writeFileSync(`${FICHIER_SANTE}.tmp`, JSON.stringify(sante, null, 2))
  renameSync(`${FICHIER_SANTE}.tmp`, FICHIER_SANTE)
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
  await lancer("docker", ["run", "--rm", "--user", "root", "--entrypoint", "find", "-v", "usine-sauvegardes:/s", "usine-logicielle-deployeur", "/s", "-name", "*.tgz", "-mtime", "+30", "-delete"])
  const apres = Number((await lancer("df", ["-B1", "--output=used", "/"])).sortie.trim().split("\n").pop())
  dernierEntretien = { le: horodatage(), images_supprimees: images, libere_mo: Math.max(0, Math.round((avant - apres) / 1e6)) }
  log(`Entretien : ${images} image(s) supprimée(s), ${dernierEntretien.libere_mo} Mo libérés.`)
}

// --- La mise à jour de l'usine ----------------------------------------------------------
// Vérifier : le dépôt de l'usine (monté au même chemin) est comparé à GitHub.
async function verifierMiseAJour() {
  if (!USINE_DIR || !DEPOT_USINE || !existsSync(join(USINE_DIR, ".git"))) return
  const git = (args, options = {}) => lancer("git", ["-c", `safe.directory=${USINE_DIR}`, "-C", USINE_DIR, ...args], options)
  const f = await git(["fetch", "-q", `https://github.com/${DEPOT_USINE}.git`, "main:refs/remotes/github/main"], { git: true })
  if (f.code !== 0) return
  await lancer("chown", ["-R", "1000:1000", join(USINE_DIR, ".git")])
  const commits = (await git(["log", "--format=%h %s", "HEAD..refs/remotes/github/main"])).sortie.split("\n").filter(Boolean)
  miseAJour = { ...miseAJour, disponible: commits.length, commits: commits.slice(0, 15), version: (await git(["rev-parse", "--short", "HEAD"])).sortie.trim(), verifie_le: horodatage() }
}

// Appliquer : un conteneur d'aide (il survit au redémarrage du déployeur) remet le dépôt
// à jour, reconstruit et relance l'usine. Les données et les secrets ne bougent pas.
async function appliquerMiseAJour(demande) {
  if (!USINE_DIR || !existsSync(join(USINE_DIR, ".git"))) return log("Mise à jour impossible : USINE_DIR n'est pas monté.")
  log(`Mise à jour de l'usine demandée par ${demande.par ?? "?"}…`)
  miseAJour = { ...miseAJour, en_cours: demande.demande_le }
  await ecrireSante()
  const gidDocker = (await lancer("stat", ["-c", "%g", "/var/run/docker.sock"])).sortie.trim()
  await lancer("docker", ["rm", "-f", "usine-mise-a-jour"])
  const script = [
    "set -e",
    `git -c safe.directory=${USINE_DIR} reset -q --hard refs/remotes/github/main`,
    "docker compose build --pull 2>&1 | tail -5",
    "docker compose up -d --remove-orphans 2>&1 | tail -10",
  ].join(" && ")
  const r = await lancer("docker", ["run", "-d", "--name", "usine-mise-a-jour", "--user", `1000:${gidDocker}`, "-e", "HOME=/tmp",
    "-v", "/var/run/docker.sock:/var/run/docker.sock", "-v", `${USINE_DIR}:${USINE_DIR}`, "-w", USINE_DIR,
    "--entrypoint", "sh", "usine-logicielle-deployeur", "-c", script])
  if (r.code !== 0) log(`Mise à jour : lancement impossible : ${r.sortie.slice(-300)}`)
  // Le déployeur sera lui-même recréé ; la suite (statut) est écrite au redémarrage.
  writeFileSync(join(ETAT, "mise-a-jour.json"), JSON.stringify({ demande_le: demande.demande_le, par: demande.par, lancee_le: horodatage() }))
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

// Les produits déjà déployés quittent le réseau de l'usine pour celui des produits.
async function isolerProduits() {
  for (const s of Object.values(lireStatut())) {
    if (!s.conteneur) continue
    const reseaux = (await lancer("docker", ["inspect", "-f", "{{json .NetworkSettings.Networks}}", s.conteneur])).sortie
    if (!reseaux.includes(`"${RESEAU}"`)) await lancer("docker", ["network", "connect", RESEAU, s.conteneur])
    if (RESEAU !== "usine" && reseaux.includes('"usine"')) {
      await lancer("docker", ["network", "disconnect", "usine", s.conteneur])
      log(`${s.conteneur} isolé sur le réseau ${RESEAU}.`)
    }
  }
}

mkdirSync(ETAT, { recursive: true })
mkdirSync(join(SRV, "produits"), { recursive: true })
await isolerProduits().catch((e) => log(`Isolement des produits : ${e.message}`))
log(`Déployeur prêt : tire ${DEPOT_ETAT} toutes les 20 s.`)
// Une mise à jour vient d'être appliquée : on note sa fin (l'orchestrateur l'annonce).
try {
  const m = JSON.parse(readFileSync(join(ETAT, "mise-a-jour.json"), "utf8"))
  miseAJour = { ...miseAJour, derniere: { ...m, terminee_le: horodatage() }, en_cours: null }
} catch {}
let derniereDemande = miseAJour.derniere?.demande_le ?? null
for (let n = 0; ; n++) {
  await tour().catch((e) => log(`Tour en échec : ${e.message.split("\n")[0]}`))
  if (n % 3 === 0) await publierJournaux().catch((e) => log(`Journaux : ${e.message}`))
  if (n % 9 === 0) await mesurerPlace().catch((e) => log(`Place : ${e.message}`))
  if (n % 30 === 0) await verifierMiseAJour().catch((e) => log(`Vérification de mise à jour : ${e.message}`))
  if (n % 1080 === 540) await entretenir().catch((e) => log(`Entretien : ${e.message}`))
  await ecrireSante().catch((e) => log(`Santé : ${e.message}`))
  if (demandeMiseAJour?.demande_le && demandeMiseAJour.demande_le !== derniereDemande) {
    derniereDemande = demandeMiseAJour.demande_le
    await verifierMiseAJour().catch(() => {})
    await appliquerMiseAJour(demandeMiseAJour).catch((e) => log(`Mise à jour : ${e.message}`))
  }
  await pause(20_000)
}
