// Le portier : la page de connexion devant chaque application publiée par l'usine.
// Caddy lui demande, pour chaque requête, si la personne a le droit d'entrer
// (forward_auth sur /_portier/verifier). Les applications elles-mêmes ne sont
// pas modifiées : même si leur code oublie de se protéger, elles le sont.
//
//   /_portier/verifier      (Caddy)  200 si la session est valide pour cette application, sinon redirection
//   /_portier/connexion     la page de connexion, servie sur l'adresse même de l'application
//   /_portier/invitation    choisir son mot de passe à partir d'un lien d'invitation
//   /_portier/deconnexion   fermer la session
//   /_portier/qui           (interne) qui est connecté, pour le tableau de bord
//   /_portier/api/…         (interne, jeton) comptes, clés d'API et applications, gérés depuis Slack
//
// Un programme (et non une personne) s'authentifie par une clé d'API :
// « Authorization: Bearer usk_… », valable pour les applications choisies.
//
// Une session est un cookie signé (HMAC), propre à une adresse : se connecter à
// une application n'ouvre pas les autres. Aucune dépendance.
import { createServer } from "node:http"
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { readFileSync, mkdirSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"

const secret = (nom) => {
  try {
    return readFileSync(`/run/secrets/${nom}`, "utf8").trim()
  } catch {
    return process.env[nom.toUpperCase()] ?? ""
  }
}
const CLE = secret("portier_secret")
const JETON_API = secret("portier_api_token")
if (CLE.length < 32 || JETON_API.length < 32) throw new Error("portier_secret et portier_api_token sont requis (secrets.sh).")
const BASE = process.env.DOMAINE_BASE ?? "localhost"
const DUREE_SESSION = 7 * 24 * 3600 // secondes

const DONNEES = process.env.DATA_DIR ?? "/app/data"
mkdirSync(DONNEES, { recursive: true })
const db = new DatabaseSync(`${DONNEES}/portier.db`)
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS utilisateurs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE, nom TEXT,
    hash TEXT, role TEXT NOT NULL DEFAULT 'membre',  -- admin : tout, dont le tableau de bord et les emails capturés
    applis TEXT NOT NULL DEFAULT '[]',               -- ["*"] ou des noms d'applications (slug)
    actif INTEGER NOT NULL DEFAULT 1, version INTEGER NOT NULL DEFAULT 1, cree_le TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS invitations (jeton TEXT PRIMARY KEY, utilisateur_id INTEGER NOT NULL, expire INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS applis (slug TEXT PRIMARY KEY, nom TEXT, liens TEXT NOT NULL DEFAULT '[]');
  CREATE TABLE IF NOT EXISTS evenements (le TEXT NOT NULL DEFAULT (datetime('now')), email TEXT, evenement TEXT NOT NULL, ip TEXT);
  -- Les clés d'API : seule leur empreinte est gardée ; une clé révoquée reste en base (actif = 0).
  CREATE TABLE IF NOT EXISTS cles (
    id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT NOT NULL, empreinte TEXT NOT NULL UNIQUE, debut TEXT NOT NULL,
    applis TEXT NOT NULL DEFAULT '[]', actif INTEGER NOT NULL DEFAULT 1, cree_par TEXT,
    cree_le TEXT NOT NULL DEFAULT (datetime('now')), utilisee_le TEXT
  );
`)
const noter = (email, evenement, ip) => db.prepare("INSERT INTO evenements (email, evenement, ip) VALUES (?, ?, ?)").run(email, evenement, ip)

// --- Mots de passe et sessions ---------------------------------------------------
const hacher = (mdp) => {
  const sel = randomBytes(16)
  return `scrypt$${sel.toString("hex")}$${scryptSync(mdp, sel, 64).toString("hex")}`
}
const verifierMdp = (mdp, hash) => {
  const [, sel, attendu] = String(hash ?? "").split("$")
  if (!sel || !attendu) return false
  const calcule = scryptSync(mdp, Buffer.from(sel, "hex"), 64)
  return timingSafeEqual(calcule, Buffer.from(attendu, "hex"))
}
const signer = (texte) => createHmac("sha256", CLE).update(texte).digest("base64url")
const egal = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

// Session : id.version.hôte.expiration.signature — la version change si l'accès est retiré.
function creerSession(u, hote) {
  const corps = `${u.id}.${u.version}.${Buffer.from(hote).toString("base64url")}.${Math.floor(Date.now() / 1000) + DUREE_SESSION}`
  return `${corps}.${signer(corps)}`
}
function lireSession(req, hote) {
  const cookie = Object.fromEntries(String(req.headers.cookie ?? "").split(/;\s*/).filter(Boolean).map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]))
  const valeur = cookie.usine_session
  if (!valeur) return null
  const parties = valeur.split(".")
  if (parties.length !== 5) return null
  const [id, version, h, exp, sig] = parties
  if (!egal(sig, signer(`${id}.${version}.${h}.${exp}`))) return null
  if (Number(exp) < Date.now() / 1000 || Buffer.from(h, "base64url").toString() !== hote) return null
  const u = db.prepare("SELECT * FROM utilisateurs WHERE id = ? AND actif = 1").get(Number(id))
  return u && String(u.version) === version ? u : null
}

// L'application derrière une adresse : <slug>.apercu.<base>, <slug>.<base>, ou une adresse de l'usine.
function application(hote) {
  if (hote === `mails.apercu.${BASE}`) return { slug: "mails", admin: true, nom: "Emails capturés" }
  if (hote === `usine-tableau.${BASE}` || hote === `console.${BASE}`) return { slug: "tableau", admin: true, nom: "Console de l'usine" }
  if (hote === `connexion.${BASE}`) return { slug: "portail", admin: false, nom: "Mes applications" }
  const m = hote.match(new RegExp(`^([a-z0-9-]+)(\\.apercu)?\\.${BASE.replace(/[.]/g, "\\.")}$`))
  const slug = m?.[1] ?? db.prepare("SELECT slug FROM applis WHERE liens LIKE ?").get(`%://${hote}"%`)?.slug ?? null
  const a = slug ? db.prepare("SELECT * FROM applis WHERE slug = ?").get(slug) : null
  return { slug, admin: false, nom: a?.nom ?? slug ?? hote }
}
const autorise = (u, appli) => {
  if (!u || !appli.slug) return false
  if (u.role === "admin") return true
  if (appli.admin) return false
  if (appli.slug === "portail") return true
  const applis = JSON.parse(u.applis)
  return applis.includes("*") || applis.includes(appli.slug)
}

// --- Clés d'API ----------------------------------------------------------------------
const empreinteCle = (cle) => createHmac("sha256", CLE).update(`cle:${cle}`).digest("hex")
// La clé présentée (Authorization: Bearer usk_…), ou null si la requête n'en porte pas.
function clePresentee(req) {
  const [type, valeur] = String(req.headers.authorization ?? "").split(" ")
  return type === "Bearer" && /^usk_[A-Za-z0-9_-]{20,80}$/.test(valeur ?? "") ? valeur : null
}
// Une clé ne donne jamais accès aux adresses d'administration ni au portail.
function cleAutorisee(cle, appli) {
  const c = db.prepare("SELECT * FROM cles WHERE empreinte = ? AND actif = 1").get(empreinteCle(cle))
  if (!c || !appli.slug || appli.admin || appli.slug === "portail") return null
  const applis = JSON.parse(c.applis)
  return applis.includes("*") || applis.includes(appli.slug) ? c : null
}

// --- Limitation des tentatives ------------------------------------------------------
const echecs = new Map() // clé -> [horodatages]
function tropDEchecs(cle) {
  const maintenant = Date.now()
  const liste = (echecs.get(cle) ?? []).filter((t) => maintenant - t < 15 * 60_000)
  echecs.set(cle, liste)
  return liste.length >= 5
}
const echec = (cle) => echecs.set(cle, [...(echecs.get(cle) ?? []), Date.now()])

// --- Pages ------------------------------------------------------------------------
const echapper = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
// Un chemin de retour sûr : relatif à l'application, jamais vers un autre site.
const retourSur = (r) => (typeof r === "string" && r.startsWith("/") && !r.startsWith("//") && !r.startsWith("/\\") && !r.startsWith("/_portier/") ? r : "/")

function page(titre, contenu, { appli } = {}) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${echapper(titre)}</title>
<style>
:root { color-scheme: light dark; --fond: #f4f5f7; --carte: #fff; --texte: #111827; --doux: #6b7280; --trait: #e5e7eb; --accent: #1f2937; --accent-texte: #fff; --erreur: #b91c1c; --erreur-fond: #fef2f2 }
@media (prefers-color-scheme: dark) { :root { --fond: #0b0f14; --carte: #141a22; --texte: #e5e7eb; --doux: #9ca3af; --trait: #273041; --accent: #e5e7eb; --accent-texte: #0b0f14; --erreur: #fca5a5; --erreur-fond: #2a1416 } }
* { box-sizing: border-box } body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--fond); color: var(--texte); font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 16px }
main { width: 100%; max-width: 380px } .carte { background: var(--carte); border: 1px solid var(--trait); border-radius: 14px; padding: 28px 24px }
.marque { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--doux); margin-bottom: 18px } h1 { font-size: 20px; margin: 0 0 4px } .sous { color: var(--doux); margin: 0 0 22px; font-size: 15px }
label { display: block; font-size: 14px; font-weight: 550; margin: 14px 0 6px } input { width: 100%; padding: 11px 12px; border: 1px solid var(--trait); border-radius: 9px; background: transparent; color: inherit; font: inherit }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent } button { width: 100%; margin-top: 20px; padding: 12px; border: 0; border-radius: 9px; background: var(--accent); color: var(--accent-texte); font: inherit; font-weight: 600; cursor: pointer }
.erreur { background: var(--erreur-fond); color: var(--erreur); border-radius: 9px; padding: 10px 12px; font-size: 14px; margin-bottom: 4px } .pied { text-align: center; color: var(--doux); font-size: 13px; margin-top: 16px }
ul { list-style: none; padding: 0; margin: 0 } li a { display: block; padding: 12px 14px; border: 1px solid var(--trait); border-radius: 9px; margin-top: 10px; color: inherit; text-decoration: none } li a:hover { border-color: var(--doux) } li small { color: var(--doux) }
a { color: inherit }
</style></head><body><main><div class="carte"><div class="marque">Usine logicielle${appli ? ` · ${echapper(appli)}` : ""}</div>${contenu}</div></main></body></html>`
}
const envoyerHtml = (res, statut, html, entetes = {}) => {
  res.writeHead(statut, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", ...entetes })
  res.end(html)
}
const envoyerJson = (res, statut, corps) => {
  res.writeHead(statut, { "content-type": "application/json", "cache-control": "no-store" })
  res.end(JSON.stringify(corps))
}
const rediriger = (res, ou, entetes = {}) => {
  res.writeHead(302, { location: ou, "cache-control": "no-store", ...entetes })
  res.end()
}
const cookieSession = (valeur, maxAge) => `usine_session=${valeur}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`

function formConnexion({ retour, erreur, email = "", appli }) {
  return page(`Connexion · ${appli.nom}`, `
<h1>Connexion</h1><p class="sous">pour accéder à ${echapper(appli.nom)}</p>
${erreur ? `<div class="erreur" role="alert">${echapper(erreur)}</div>` : ""}
<form method="post" action="/_portier/connexion">
  <input type="hidden" name="retour" value="${echapper(retour)}">
  <label for="email">Adresse email</label><input id="email" name="email" type="email" autocomplete="username" required value="${echapper(email)}" autofocus>
  <label for="mdp">Mot de passe</label><input id="mdp" name="mot_de_passe" type="password" autocomplete="current-password" required>
  <button type="submit">Se connecter</button>
</form>
<p class="pied">Pas encore d'accès ? Demande une invitation à l'équipe.</p>`, { appli: appli.nom })
}

function formInvitation({ jeton, erreur, email }) {
  return page("Choisir un mot de passe", `
<h1>Bienvenue</h1><p class="sous">Choisis le mot de passe de <strong>${echapper(email)}</strong>.</p>
${erreur ? `<div class="erreur" role="alert">${echapper(erreur)}</div>` : ""}
<form method="post" action="/_portier/invitation">
  <input type="hidden" name="jeton" value="${echapper(jeton)}">
  <label for="mdp">Mot de passe (12 caractères au moins)</label><input id="mdp" name="mot_de_passe" type="password" autocomplete="new-password" minlength="12" required autofocus>
  <label for="mdp2">Le même, une seconde fois</label><input id="mdp2" name="confirmation" type="password" autocomplete="new-password" minlength="12" required>
  <button type="submit">Enregistrer et entrer</button>
</form>`)
}

function portail(u) {
  const applis = db.prepare("SELECT * FROM applis ORDER BY nom").all().filter((a) => autorise(u, { slug: a.slug, admin: false }))
  const liens = applis.flatMap((a) => JSON.parse(a.liens).map((l) => ({ nom: a.nom, ...l })))
  const admin = u.role === "admin" ? [{ nom: "Console de l'usine", libelle: "projets, décisions, santé, coûts", url: `https://console.${BASE}` }, { nom: "Emails capturés", libelle: "démo", url: `https://mails.apercu.${BASE}` }] : []
  return page("Mes applications", `
<h1>Mes applications</h1><p class="sous">Connecté en tant que ${echapper(u.email)}</p>
<ul>${[...liens, ...admin].map((l) => `<li><a href="${echapper(l.url)}">${echapper(l.nom)}<br><small>${echapper(l.libelle ?? "")}</small></a></li>`).join("") || "<li><small>Aucune application pour l'instant.</small></li>"}</ul>
<p class="pied"><a href="/_portier/deconnexion">Se déconnecter</a></p>`)
}

const lireCorps = async (req, max = 20_000) => {
  let corps = ""
  for await (const morceau of req) {
    corps += morceau
    if (corps.length > max) throw new Error("trop long")
  }
  return corps
}
const formulaire = async (req) => Object.fromEntries(new URLSearchParams(await lireCorps(req)))

// --- Serveur ------------------------------------------------------------------------
createServer(async (req, res) => {
  const url = new URL(req.url, "http://portier")
  const ip = String(req.headers["x-forwarded-for"] ?? req.socket.remoteAddress ?? "").split(",")[0].trim()
  // L'adresse de l'application : donnée par Caddy (X-Forwarded-Host), sinon Host.
  const hote = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(":")[0].toLowerCase()
  const appli = application(hote)
  try {
    // 1. La vérification demandée par Caddy pour chaque requête vers une application.
    if (url.pathname === "/_portier/verifier") {
      // Un programme : sa clé d'API, sans repli sur la page de connexion.
      const cle = clePresentee(req)
      if (cle) {
        if (tropDEchecs(`cle:${ip}`)) return envoyerJson(res, 429, { erreur: "trop d'essais" })
        const c = cleAutorisee(cle, appli)
        if (!c) {
          echec(`cle:${ip}`)
          noter(null, `clé d'API refusée pour ${appli.slug ?? hote}`, ip)
          return envoyerJson(res, 401, { erreur: "clé d'API invalide pour cette application" })
        }
        db.prepare("UPDATE cles SET utilisee_le = datetime('now') WHERE id = ?").run(c.id)
        res.writeHead(200, { "x-usine-utilisateur": `cle:${c.nom}` })
        return res.end()
      }
      const u = lireSession(req, hote)
      if (autorise(u, appli)) {
        res.writeHead(200, { "x-usine-utilisateur": u.email })
        return res.end()
      }
      const demande = String(req.headers["x-forwarded-uri"] ?? "/")
      if (u) return envoyerHtml(res, 403, page("Accès refusé", `<h1>Accès refusé</h1><p class="sous">${echapper(u.email)} n'a pas accès à ${echapper(appli.nom)}.</p><p class="pied"><a href="/_portier/deconnexion">Changer de compte</a></p>`, { appli: appli.nom }))
      // Une requête d'API (fetch) reçoit un 401, une page reçoit la connexion.
      if (demande.startsWith("/api/")) return envoyerJson(res, 401, { erreur: "connexion requise" })
      return rediriger(res, `/_portier/connexion?retour=${encodeURIComponent(retourSur(demande))}`)
    }

    // 2. Connexion.
    if (url.pathname === "/_portier/connexion" && req.method === "GET") {
      const u = lireSession(req, hote)
      if (u && appli.slug === "portail") return envoyerHtml(res, 200, portail(u))
      return envoyerHtml(res, 200, formConnexion({ retour: retourSur(url.searchParams.get("retour")), appli }))
    }
    if (url.pathname === "/_portier/connexion" && req.method === "POST") {
      // Un formulaire envoyé depuis un autre site est refusé.
      if (req.headers.origin && req.headers.origin !== `https://${hote}`) return envoyerHtml(res, 403, page("Refusé", "<h1>Requête refusée</h1>"))
      const f = await formulaire(req)
      const email = String(f.email ?? "").trim().toLowerCase()
      const retour = retourSur(f.retour)
      if (tropDEchecs(`ip:${ip}`) || tropDEchecs(`email:${email}`)) {
        noter(email, "connexion bloquée (trop d'essais)", ip)
        return envoyerHtml(res, 429, formConnexion({ retour, email, appli, erreur: "Trop d'essais. Réessaie dans 15 minutes." }))
      }
      const u = db.prepare("SELECT * FROM utilisateurs WHERE email = ? AND actif = 1").get(email)
      if (!u || !u.hash || !verifierMdp(String(f.mot_de_passe ?? ""), u.hash)) {
        echec(`ip:${ip}`)
        echec(`email:${email}`)
        noter(email, "échec de connexion", ip)
        return envoyerHtml(res, 401, formConnexion({ retour, email, appli, erreur: "Email ou mot de passe incorrect." }))
      }
      noter(email, `connexion à ${appli.slug ?? hote}`, ip)
      return rediriger(res, appli.slug === "portail" ? "/_portier/connexion" : retour, { "set-cookie": cookieSession(creerSession(u, hote), DUREE_SESSION) })
    }
    if (url.pathname === "/_portier/deconnexion") return rediriger(res, "/_portier/connexion", { "set-cookie": cookieSession("", 0) })

    // 3. Invitation : la personne choisit son mot de passe.
    if (url.pathname === "/_portier/invitation") {
      const jeton = req.method === "POST" ? null : url.searchParams.get("jeton")
      const f = req.method === "POST" ? await formulaire(req) : {}
      const j = String(jeton ?? f.jeton ?? "")
      const inv = db.prepare("SELECT i.*, u.email FROM invitations i JOIN utilisateurs u ON u.id = i.utilisateur_id WHERE i.jeton = ?").get(createHmac("sha256", CLE).update(j).digest("hex"))
      if (!inv || inv.expire < Date.now()) return envoyerHtml(res, 410, page("Lien expiré", "<h1>Lien expiré</h1><p class=\"sous\">Ce lien d'invitation n'est plus valable. Demande-en un nouveau à l'équipe.</p>"))
      if (req.method !== "POST") return envoyerHtml(res, 200, formInvitation({ jeton: j, email: inv.email }))
      const mdp = String(f.mot_de_passe ?? "")
      if (mdp.length < 12) return envoyerHtml(res, 400, formInvitation({ jeton: j, email: inv.email, erreur: "12 caractères au moins." }))
      if (mdp !== f.confirmation) return envoyerHtml(res, 400, formInvitation({ jeton: j, email: inv.email, erreur: "Les deux mots de passe sont différents." }))
      db.prepare("UPDATE utilisateurs SET hash = ?, version = version + 1 WHERE id = ?").run(hacher(mdp), inv.utilisateur_id)
      db.prepare("DELETE FROM invitations WHERE utilisateur_id = ?").run(inv.utilisateur_id)
      noter(inv.email, "mot de passe choisi", ip)
      const u = db.prepare("SELECT * FROM utilisateurs WHERE id = ?").get(inv.utilisateur_id)
      return rediriger(res, "/_portier/connexion", { "set-cookie": cookieSession(creerSession(u, hote), DUREE_SESSION) })
    }

    // 4. Qui est connecté (pour le tableau de bord : il revérifie lui-même).
    if (url.pathname === "/_portier/qui") {
      const u = lireSession(req, hote)
      return envoyerJson(res, u ? 200 : 401, u ? { email: u.email, role: u.role, autorise: autorise(u, appli) } : { erreur: "non connecté" })
    }

    // 5. L'API d'administration (orchestrateur, Slack). Jamais publiée par Caddy.
    if (url.pathname.startsWith("/_portier/api/")) {
      const [type, valeur] = String(req.headers.authorization ?? "").split(" ")
      if (type !== "Bearer" || !egal(String(valeur ?? ""), JETON_API)) return envoyerJson(res, 401, { erreur: "jeton invalide" })
      const corps = ["POST", "PUT", "PATCH"].includes(req.method) ? JSON.parse((await lireCorps(req, 200_000)) || "{}") : {}
      const [, , , ressource, id, action] = url.pathname.split("/") // /_portier/api/<ressource>/<id>/<action>
      const invitation = (uid) => {
        const j = randomBytes(24).toString("base64url")
        db.prepare("DELETE FROM invitations WHERE utilisateur_id = ?").run(uid)
        db.prepare("INSERT INTO invitations (jeton, utilisateur_id, expire) VALUES (?, ?, ?)").run(createHmac("sha256", CLE).update(j).digest("hex"), uid, Date.now() + 72 * 3600_000)
        return `https://connexion.${BASE}/_portier/invitation?jeton=${j}`
      }
      if (ressource === "utilisateurs" && req.method === "GET") return envoyerJson(res, 200, db.prepare("SELECT id, email, nom, role, applis, actif, hash IS NOT NULL AS active, cree_le FROM utilisateurs ORDER BY email").all().map((u) => ({ ...u, applis: JSON.parse(u.applis) })))
      if (ressource === "utilisateurs" && req.method === "POST" && !id) {
        const email = String(corps.email ?? "").trim().toLowerCase()
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return envoyerJson(res, 400, { erreur: "email invalide" })
        const existant = db.prepare("SELECT id FROM utilisateurs WHERE email = ?").get(email)
        const role = corps.role === "admin" ? "admin" : "membre"
        const applis = JSON.stringify(Array.isArray(corps.applis) ? corps.applis.map(String) : [])
        const uid = existant?.id ?? Number(db.prepare("INSERT INTO utilisateurs (email, nom, role, applis) VALUES (?, ?, ?, ?)").run(email, corps.nom ?? null, role, applis).lastInsertRowid)
        if (existant) db.prepare("UPDATE utilisateurs SET role = ?, applis = ?, actif = 1, version = version + 1 WHERE id = ?").run(role, applis, uid)
        noter(email, `invité (${role}) par ${corps.par ?? "?"}`, "api")
        return envoyerJson(res, 201, { id: uid, lien: invitation(uid) })
      }
      if (ressource === "utilisateurs" && id && action === "invitation" && req.method === "POST") return envoyerJson(res, 200, { lien: invitation(Number(id)) })
      if (ressource === "utilisateurs" && id && req.method === "PATCH") {
        const u = db.prepare("SELECT * FROM utilisateurs WHERE id = ?").get(Number(id))
        if (!u) return envoyerJson(res, 404, { erreur: "inconnu" })
        db.prepare("UPDATE utilisateurs SET role = ?, applis = ?, actif = ?, version = version + 1 WHERE id = ?").run(corps.role ?? u.role, corps.applis ? JSON.stringify(corps.applis) : u.applis, corps.actif === undefined ? u.actif : corps.actif ? 1 : 0, u.id)
        return envoyerJson(res, 200, { ok: true })
      }
      if (ressource === "utilisateurs" && id && req.method === "DELETE") {
        db.prepare("DELETE FROM invitations WHERE utilisateur_id = ?").run(Number(id))
        db.prepare("DELETE FROM utilisateurs WHERE id = ?").run(Number(id))
        return envoyerJson(res, 200, { ok: true })
      }
      // Les applications connues (nom, liens), synchronisées par l'orchestrateur.
      if (ressource === "applis" && req.method === "PUT") {
        db.exec("BEGIN")
        db.exec("DELETE FROM applis")
        const ins = db.prepare("INSERT INTO applis (slug, nom, liens) VALUES (?, ?, ?)")
        for (const a of corps.applis ?? []) if (/^[a-z0-9-]{1,40}$/.test(a.slug)) ins.run(a.slug, String(a.nom ?? a.slug), JSON.stringify(a.liens ?? []))
        db.exec("COMMIT")
        return envoyerJson(res, 200, { ok: true })
      }
      // Les clés d'API : la clé n'est montrée qu'une fois, à sa création.
      if (ressource === "cles" && req.method === "GET") return envoyerJson(res, 200, db.prepare("SELECT id, nom, debut, applis, actif, cree_par, cree_le, utilisee_le FROM cles ORDER BY actif DESC, cree_le DESC").all().map((c) => ({ ...c, applis: JSON.parse(c.applis) })))
      if (ressource === "cles" && req.method === "POST" && !id) {
        // Le nom part dans un en-tête HTTP : caractères latins seulement.
        const nom = String(corps.nom ?? "").replace(/[^\x20-\x7e\u00a0-\u00ff]/g, "").trim().slice(0, 60)
        const applis = Array.isArray(corps.applis) ? corps.applis.map(String).filter((a) => a === "*" || /^[a-z0-9-]{1,40}$/.test(a)) : []
        if (!nom || !applis.length) return envoyerJson(res, 400, { erreur: "un nom et au moins une application" })
        const cle = `usk_${randomBytes(30).toString("base64url")}`
        const r = db.prepare("INSERT INTO cles (nom, empreinte, debut, applis, cree_par) VALUES (?, ?, ?, ?, ?)").run(nom, empreinteCle(cle), cle.slice(0, 10), JSON.stringify(applis), corps.par ?? null)
        noter(corps.par ?? null, `clé d'API « ${nom} » créée (${applis.join(", ")})`, "api")
        return envoyerJson(res, 201, { id: Number(r.lastInsertRowid), cle })
      }
      if (ressource === "cles" && id && req.method === "DELETE") {
        db.prepare("UPDATE cles SET actif = 0 WHERE id = ?").run(Number(id))
        noter(null, `clé d'API ${id} révoquée`, "api")
        return envoyerJson(res, 200, { ok: true })
      }
      if (ressource === "evenements") return envoyerJson(res, 200, db.prepare("SELECT * FROM evenements ORDER BY le DESC LIMIT 100").all())
      return envoyerJson(res, 404, { erreur: "route inconnue" })
    }

    // 6. L'adresse du portail elle-même : la liste de ses applications.
    if (appli.slug === "portail") {
      const u = lireSession(req, hote)
      return u ? envoyerHtml(res, 200, portail(u)) : rediriger(res, "/_portier/connexion")
    }
    envoyerHtml(res, 404, page("Introuvable", "<h1>Introuvable</h1>"))
  } catch (error) {
    console.error("Portier :", error)
    envoyerHtml(res, 500, page("Erreur", "<h1>Une erreur est survenue</h1><p class=\"sous\">Réessaie dans un instant.</p>"))
  }
}).listen(Number(process.env.PORT ?? 8080), "0.0.0.0", () => console.log(`Portier prêt (domaine ${BASE}).`))
