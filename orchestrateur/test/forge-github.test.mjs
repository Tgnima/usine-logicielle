// « Se connecter avec GitHub » : manifeste, réponse de GitHub vérifiée, jetons qui expirent.
import { test } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { createVerify, generateKeyPairSync } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { brancherForge, demarrerConnexion, etatForge, jwtApp, lireApp, oublierForge, recevoirInstallation, recevoirManifeste } from "../src/forge-github.mjs"
import { creerDepot } from "../src/github.mjs"

const ctxDe = () => {
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)")
  db.exec("CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, projet_id INTEGER, tache_id INTEGER, type TEXT NOT NULL, message TEXT NOT NULL, le TEXT NOT NULL DEFAULT (datetime('now')))")
  return { db, config: { secrets: { worker: "jeton-worker-de-test", github: "jeton-serveur" }, github: { proprietaire: "contrat", depot_etat: "usine-etat" }, domaine: { base: "exemple.fr" }, jetonsDir: mkdtempSync(join(tmpdir(), "jetons-")) } }
}
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })

// Un faux GitHub : chaque test dit ce qu'il répond.
const reponses = []
globalThis.fetch = async (url, init = {}) => {
  const r = reponses.find((x) => String(url).includes(x.motif) && (!x.methode || x.methode === (init.method ?? "GET")))
  if (!r) throw new Error(`appel inattendu : ${init.method ?? "GET"} ${url}`)
  r.vu = init
  return { ok: r.statut < 400, status: r.statut, json: async () => r.corps }
}
const repondre = (motif, corps, statut = 200, methode) => {
  const r = { motif, corps, statut, methode }
  reponses.unshift(r)
  return r
}

async function connecter(ctx) {
  const { action } = demarrerConnexion(ctx, { console: "https://console.exemple.fr" }, "admin@exemple.fr")
  const state = new URL(action).searchParams.get("state")
  repondre("/app-manifests/CODE/conversions", { id: 42, slug: "usine-exemple", client_id: "Iv1.abc", client_secret: "secret-client", pem: privateKey, owner: { login: "marie", type: "User" } }, 201, "POST")
  const installer = await recevoirManifeste(ctx, { code: "CODE", state })
  repondre("/app/installations/7", { account: { login: "marie", type: "User" }, repository_selection: "all" })
  repondre("/login/oauth/access_token", { access_token: "ghu_utilisateur", expires_in: 28800, refresh_token: "ghr_renouvellement" }, 200, "POST")
  repondre("/app/installations/7/access_tokens", { token: "ghs_installation", expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201, "POST")
  repondre("/repos/marie/usine-etat", {}, 200)
  await recevoirInstallation(ctx, { installation_id: "7", code: "code-utilisateur" }, "admin@exemple.fr")
  return installer
}

test("le manifeste demande les seuls droits utiles et part avec un state à usage unique", () => {
  const ctx = ctxDe()
  const r = demarrerConnexion(ctx, { organisation: "mon-org", console: "https://console.exemple.fr" }, "a")
  assert.match(r.action, /^https:\/\/github\.com\/organizations\/mon-org\/settings\/apps\/new\?state=[0-9a-f]{48}$/)
  const m = JSON.parse(r.manifeste)
  assert.equal(m.public, false)
  assert.equal(m.hook_attributes.active, false)
  assert.equal(m.redirect_url, "https://console.exemple.fr/api/github/manifeste")
  assert.deepEqual(Object.keys(m.default_permissions).sort(), ["administration", "contents", "issues", "metadata", "pull_requests", "workflows"])
  assert.throws(() => demarrerConnexion(ctx, { organisation: "../etc", console: "x" }, "a"), /invalide/)
})

test("une réponse de GitHub sans le bon state est refusée", async () => {
  const ctx = ctxDe()
  await assert.rejects(recevoirManifeste(ctx, { code: "CODE", state: "faux" }), /inattendue/)
})

test("connexion complète : secrets chiffrés, jeton d'installation partout, déployeur servi", async () => {
  const ctx = ctxDe()
  await brancherForge(ctx)
  assert.equal(ctx.config.secrets.github, "jeton-serveur") // avant : le jeton du serveur
  const installer = await connecter(ctx)
  assert.equal(installer, "https://github.com/apps/usine-exemple/installations/new")
  // La clé privée et les jetons ne sont jamais en clair dans la base.
  const tout = JSON.stringify(ctx.db.prepare("SELECT valeur FROM reglages").all())
  assert.ok(!tout.includes("BEGIN RSA") && !tout.includes("secret-client") && !tout.includes("ghr_renouvellement"))
  assert.equal(ctx.config.secrets.github, "ghs_installation")
  assert.equal(ctx.config.github.proprietaire, "marie")
  const e = etatForge(ctx)
  assert.equal(e.mode, "application")
  assert.equal(e.tous_depots, true)
  // Le déployeur reçoit le jeton et le dépôt d'état du compte connecté.
  const { readFileSync } = await import("node:fs")
  const depose = JSON.parse(readFileSync(join(ctx.config.jetonsDir, "github.json"), "utf8"))
  assert.equal(depose.jeton, "ghs_installation")
  assert.equal(depose.depot_etat, "marie/usine-etat")
})

test("le JWT de l'application est signé avec sa clé privée et expire vite", async () => {
  const ctx = ctxDe()
  await connecter(ctx)
  const [entete, corps, signature] = jwtApp(ctx).split(".")
  assert.ok(createVerify("RSA-SHA256").update(`${entete}.${corps}`).verify(publicKey, signature, "base64url"))
  const c = JSON.parse(Buffer.from(corps, "base64url").toString())
  assert.ok(c.exp - c.iat <= 600)
  assert.equal(c.iss, "Iv1.abc")
})

test("sur un compte personnel, un dépôt se crée avec le jeton de l'utilisateur", async () => {
  const ctx = ctxDe()
  await brancherForge(ctx)
  await connecter(ctx)
  repondre("/repos/marie/nouveau-produit", { message: "Not Found" }, 404)
  const creation = repondre("/user/repos", { full_name: "marie/nouveau-produit" }, 201, "POST")
  await creerDepot(ctx.config, "nouveau-produit", "un produit")
  assert.equal(creation.vu.headers.authorization, "Bearer ghu_utilisateur")
})

test("déconnecter rend la main au jeton du serveur et au compte du contrat", async () => {
  const ctx = ctxDe()
  await brancherForge(ctx)
  await connecter(ctx)
  oublierForge(ctx, "a")
  assert.equal(lireApp(ctx), null)
  assert.equal(ctx.config.secrets.github, "jeton-serveur")
  assert.equal(ctx.config.github.proprietaire, "contrat")
})
