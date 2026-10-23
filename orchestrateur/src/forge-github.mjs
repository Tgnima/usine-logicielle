// « Se connecter avec GitHub » depuis la console : une application GitHub propre à cette usine,
// créée en un clic (flux « manifeste » de GitHub), installée sur le compte ou l'organisation de
// la personne. Plus de jeton personnel à copier.
//
//   1. La console envoie le manifeste à GitHub ; la personne choisit le nom et valide.
//   2. GitHub revient sur /api/github/manifeste?code=… : l'usine reçoit l'identifiant et la
//      clé privée de l'application (gardés chiffrés dans le coffre, fournisseurs.mjs).
//   3. La personne installe l'application (sur « tous les dépôts » : l'usine en crée) ; GitHub
//      revient sur /api/github/installe avec l'installation et une autorisation de l'utilisateur.
//
// Ensuite l'usine n'utilise que des jetons qui expirent :
//   - le jeton d'installation (1 h, limité aux dépôts autorisés) pour tout le travail courant ;
//   - le jeton de l'utilisateur (8 h, renouvelé) seulement pour créer un dépôt sur un compte
//     personnel (GitHub ne le permet pas avec un jeton d'installation).
// Le jeton est aussi déposé pour le déployeur (volume « jetons », lecture seule chez lui).
// Sans application GitHub, le jeton du serveur (github_token) sert, comme avant.
import { createSign, randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync, renameSync } from "node:fs"
import { join } from "node:path"
import { ecrireReglage, lireReglage } from "./couts.mjs"
import { noter } from "./db.mjs"
import { chiffrer, dechiffrer } from "./fournisseurs.mjs"

const API = "https://api.github.com"
const erreur = (code, message) => Object.assign(new Error(message), { code })
const entetes = (jeton) => ({ accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "usine-logicielle", ...(jeton ? { authorization: `Bearer ${jeton}` } : {}) })

// --- Ce qui est gardé : l'application (en clair, sauf ses secrets) et ses secrets (chiffrés) ---
export function lireApp(ctx) {
  try {
    return JSON.parse(lireReglage(ctx.db, "github_app", "null"))
  } catch {
    return null
  }
}
const ecrireApp = (ctx, app) => ecrireReglage(ctx.db, "github_app", JSON.stringify(app))
const lireSecret = (ctx, nom) => {
  try {
    const e = JSON.parse(lireReglage(ctx.db, `github_app_${nom}`, "null"))
    return e ? dechiffrer(ctx, e) : null
  } catch {
    return null
  }
}
const ecrireSecret = (ctx, nom, valeur) => ecrireReglage(ctx.db, `github_app_${nom}`, JSON.stringify(chiffrer(ctx, valeur)))

// --- 1. Le manifeste -------------------------------------------------------------------------
const etatsAttendus = new Map() // state → { qui, le } : la réponse de GitHub doit venir de cette demande
export function demarrerConnexion(ctx, { organisation, console: adresse }, qui) {
  const org = String(organisation ?? "").trim()
  if (org && !/^[a-z0-9](?:[a-z0-9-]{0,38})$/i.test(org)) throw erreur(400, "Nom d'organisation GitHub invalide.")
  const state = randomBytes(24).toString("hex")
  etatsAttendus.set(state, { qui, le: Date.now() })
  const base = ctx.config.domaine?.base ?? "usine"
  const manifeste = {
    name: `Usine ${base}`.slice(0, 34),
    url: adresse,
    redirect_url: `${adresse}/api/github/manifeste`,
    setup_url: `${adresse}/api/github/installe`,
    callback_urls: [`${adresse}/api/github/installe`],
    request_oauth_on_install: true,
    setup_on_update: true,
    public: false,
    hook_attributes: { url: `${adresse}/api/github/evenements`, active: false },
    default_permissions: { administration: "write", contents: "write", issues: "write", pull_requests: "write", metadata: "read", workflows: "write" },
    default_events: [],
  }
  const cible = org ? `https://github.com/organizations/${org}/settings/apps/new` : "https://github.com/settings/apps/new"
  return { ok: true, action: `${cible}?state=${state}`, manifeste: JSON.stringify(manifeste) }
}

function verifierState(state) {
  const e = etatsAttendus.get(String(state ?? ""))
  etatsAttendus.delete(String(state ?? ""))
  if (!e || Date.now() - e.le > 3_600_000) throw erreur(400, "Réponse de GitHub inattendue ou expirée : relance « Connecter GitHub » depuis la console.")
  return e
}

// --- 2. GitHub renvoie l'application créée ------------------------------------------------------
export async function recevoirManifeste(ctx, { code, state }) {
  const { qui } = verifierState(state)
  const r = await fetch(`${API}/app-manifests/${encodeURIComponent(String(code ?? ""))}/conversions`, { method: "POST", headers: entetes(), signal: AbortSignal.timeout(20_000) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw erreur(502, `GitHub n'a pas confirmé l'application (${r.status} ${j.message ?? ""}).`)
  ecrireSecret(ctx, "cle_privee", j.pem)
  ecrireSecret(ctx, "secret_client", j.client_secret)
  ecrireApp(ctx, { id: j.id, slug: j.slug, client_id: j.client_id, proprietaire: j.owner?.login, type: j.owner?.type, cree_par: qui, le: new Date().toISOString() })
  noter(ctx.db, { projet: null, type: "reglage", message: `Application GitHub « ${j.slug} » créée pour ${j.owner?.login} par ${qui}` })
  // L'étape suivante : l'installer (tous les dépôts : l'usine en crée de nouveaux).
  return `https://github.com/apps/${j.slug}/installations/new`
}

// --- 3. L'application est installée -----------------------------------------------------------------
export async function recevoirInstallation(ctx, { installation_id, code }, qui) {
  const app = lireApp(ctx)
  if (!app) throw erreur(409, "Aucune application GitHub en attente : relance « Connecter GitHub ».")
  const id = Number(installation_id)
  if (!Number.isInteger(id) || id <= 0) throw erreur(400, "Installation GitHub absente de la réponse.")
  // L'installation doit appartenir à NOTRE application (pas une installation quelconque).
  const r = await fetch(`${API}/app/installations/${id}`, { headers: entetes(jwtApp(ctx, app)), signal: AbortSignal.timeout(20_000) })
  const inst = await r.json().catch(() => ({}))
  if (!r.ok) throw erreur(400, `Cette installation n'appartient pas à l'application de l'usine (${r.status}).`)
  if (code) await echangerCodeUtilisateur(ctx, app, code)
  ecrireApp(ctx, { ...app, installation: id, compte: inst.account?.login, type: inst.account?.type, tous_depots: inst.repository_selection === "all", installe_par: qui, installe_le: new Date().toISOString() })
  jetonInstallation = null
  await rafraichir(ctx)
  ctx.appliquerForge?.()
  // Le dépôt d'état sur ce compte (le déployeur le suit dès qu'il voit le nouveau jeton).
  const { preparerDepotEtat } = await import("./github.mjs")
  await preparerDepotEtat(ctx.config).catch((e) => console.error("Dépôt d'état :", e.message))
  noter(ctx.db, { projet: null, type: "reglage", message: `GitHub connecté au compte ${inst.account?.login} par ${qui}${inst.repository_selection === "all" ? "" : " (accès limité à certains dépôts : l'usine ne pourra pas créer de dépôt)"}` })
}

// --- Les jetons ------------------------------------------------------------------------------------
const b64url = (b) => Buffer.from(b).toString("base64url")
export function jwtApp(ctx, app = lireApp(ctx)) {
  const pem = lireSecret(ctx, "cle_privee")
  if (!app || !pem) throw erreur(409, "Application GitHub incomplète : reconnecte GitHub.")
  const maintenant = Math.floor(Date.now() / 1000)
  const corps = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iat: maintenant - 60, exp: maintenant + 540, iss: String(app.client_id ?? app.id) }))}`
  return `${corps}.${createSign("RSA-SHA256").update(corps).sign(pem, "base64url")}`
}

let jetonInstallation = null // { jeton, expire }
async function nouveauJetonInstallation(ctx, app) {
  const r = await fetch(`${API}/app/installations/${app.installation}/access_tokens`, { method: "POST", headers: entetes(jwtApp(ctx, app)), signal: AbortSignal.timeout(20_000) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`jeton d'installation GitHub refusé (${r.status} ${j.message ?? ""})`)
  return { jeton: j.token, expire: new Date(j.expires_at).getTime() }
}

async function echangerCodeUtilisateur(ctx, app, code) {
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: app.client_id, client_secret: lireSecret(ctx, "secret_client"), code }),
    signal: AbortSignal.timeout(20_000),
  })
  const j = await r.json().catch(() => ({}))
  if (!j.access_token) throw erreur(502, `GitHub n'a pas donné l'autorisation de l'utilisateur (${j.error_description ?? j.error ?? r.status}).`)
  garderJetonUtilisateur(ctx, j)
}
function garderJetonUtilisateur(ctx, j) {
  ecrireSecret(ctx, "jeton_utilisateur", JSON.stringify({ jeton: j.access_token, expire: Date.now() + Number(j.expires_in ?? 28_800) * 1000, renouvellement: j.refresh_token ?? null }))
}

// Le jeton de l'utilisateur (création d'un dépôt sur un compte personnel), renouvelé au besoin.
export async function jetonUtilisateur(ctx) {
  const app = lireApp(ctx)
  let u = null
  try {
    u = JSON.parse(lireSecret(ctx, "jeton_utilisateur") ?? "null")
  } catch {}
  if (!app || !u) return null
  if (u.expire - Date.now() > 10 * 60_000) return u.jeton
  if (!u.renouvellement) return null
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ client_id: app.client_id, client_secret: lireSecret(ctx, "secret_client"), grant_type: "refresh_token", refresh_token: u.renouvellement }),
    signal: AbortSignal.timeout(20_000),
  })
  const j = await r.json().catch(() => ({}))
  if (!j.access_token) return null
  garderJetonUtilisateur(ctx, j)
  return j.access_token
}

// Le jeton d'installation est renouvelé bien avant son expiration (1 h) ; déposé pour le déployeur.
export async function rafraichir(ctx) {
  const app = lireApp(ctx)
  if (!app?.installation) return null
  if (!jetonInstallation || jetonInstallation.expire - Date.now() < 20 * 60_000) {
    jetonInstallation = await nouveauJetonInstallation(ctx, app)
    deposerPourDeployeur(ctx, { ...jetonInstallation, depot_etat: app.compte && ctx.config.github.depot_etat ? `${app.compte}/${ctx.config.github.depot_etat}` : null })
  }
  return jetonInstallation.jeton
}

function deposerPourDeployeur(ctx, j) {
  const dossier = ctx.config.jetonsDir ?? "/app/jetons"
  try {
    mkdirSync(dossier, { recursive: true })
    const tmp = join(dossier, ".github.tmp")
    writeFileSync(tmp, JSON.stringify({ jeton: j.jeton, expire: j.expire, depot_etat: j.depot_etat }), { mode: 0o600 })
    renameSync(tmp, join(dossier, "github.json"))
  } catch (e) {
    console.error("Jeton GitHub pour le déployeur :", e.message)
  }
}

// Au démarrage : si une application est installée, c'est elle qui sert partout
// (config.secrets.github devient le jeton d'installation, renouvelé en continu).
export function brancherForge(ctx) {
  const { config } = ctx
  const jetonServeur = config.secrets.github
  const contrat = { proprietaire: config.github.proprietaire }
  config.jetonCreation = () => jetonUtilisateur(ctx)
  const appliquer = () => {
    const app = lireApp(ctx)
    if (app?.installation && app.compte) {
      config.github.proprietaire = app.compte
      config.github.type_proprietaire = app.type
      ctx.forge = { compte: app.compte, type: app.type, app: app.slug }
    } else {
      config.github.proprietaire = contrat.proprietaire
      delete config.github.type_proprietaire
      ctx.forge = null
    }
  }
  ctx.appliquerForge = appliquer
  appliquer()
  Object.defineProperty(config.secrets, "github", {
    configurable: true,
    enumerable: true,
    get: () => (lireApp(ctx)?.installation && jetonInstallation ? jetonInstallation.jeton : jetonServeur),
  })
  const tour = () => rafraichir(ctx).then(appliquer).catch((e) => console.error("GitHub (application) :", e.message))
  return tour().then(() => setInterval(tour, 10 * 60_000).unref())
}

// Ce que la console affiche.
export function etatForge(ctx) {
  const app = lireApp(ctx)
  if (!app) return { mode: "jeton" }
  return { mode: app.installation ? "application" : "a_installer", slug: app.slug, compte: app.compte ?? app.proprietaire, type: app.type, tous_depots: app.tous_depots ?? null, le: app.installe_le ?? app.le, par: app.installe_par ?? app.cree_par, installer: app.installation ? null : `https://github.com/apps/${app.slug}/installations/new`, gerer: app.slug ? `https://github.com/settings/apps/${app.slug}` : null }
}

export function oublierForge(ctx, qui) {
  for (const cle of ["github_app", "github_app_cle_privee", "github_app_secret_client", "github_app_jeton_utilisateur"]) ctx.db.prepare("DELETE FROM reglages WHERE cle = ?").run(cle)
  jetonInstallation = null
  ctx.appliquerForge?.()
  noter(ctx.db, { projet: null, type: "reglage", message: `Application GitHub déconnectée de l'usine par ${qui} (à supprimer aussi sur GitHub)` })
  return { ok: true, message: "GitHub déconnecté de l'usine. Supprime aussi l'application sur GitHub (lien « Gérer sur GitHub »)." }
}
