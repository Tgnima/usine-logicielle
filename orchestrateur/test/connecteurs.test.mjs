// Les connecteurs : catalogue, clés chiffrées jamais renvoyées, rôles, et ce que reçoivent les IA.
import { test } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { CATALOGUE, ajouterConnecteur, configClaude, effacerCleConnecteur, envConnecteurs, listerConnecteurs, optionsClaude, optionsCodex, outilsClaude, poserCleConnecteur, reglerConnecteur, retirerConnecteur, scriptTest } from "../src/connecteurs.mjs"
import { scriptClaude, scriptCodex } from "../src/moteurs.mjs"

const ctxDe = () => {
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)")
  db.exec("CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, projet_id INTEGER, tache_id INTEGER, type TEXT NOT NULL, message TEXT NOT NULL, le TEXT NOT NULL DEFAULT (datetime('now')))")
  return { db, config: { secrets: { worker: "jeton-de-test-du-serveur-de-travaux" }, secours: {}, autonomie: {} } }
}
const STRIPE = "sk_test_ceci-est-une-fausse-cle-WXYZ"
const code = (f) => {
  try {
    f()
  } catch (e) {
    return e.code
  }
  return null
}

test("le catalogue s'affiche sans clé ni configuration technique", () => {
  const ctx = ctxDe()
  const { connecteurs } = listerConnecteurs(ctx)
  assert.equal(connecteurs.length, CATALOGUE.length)
  assert.ok(connecteurs.every((c) => !("serveur" in c) && !c.actif))
  assert.deepEqual(connecteurs.find((c) => c.id === "stripe").cle, { libelle: "Clé de test Stripe", aide: CATALOGUE.find((c) => c.id === "stripe").cle.aide })
})

test("activer : une clé d'abord, au moins un rôle, des rôles connus seulement", () => {
  const ctx = ctxDe()
  assert.equal(code(() => reglerConnecteur(ctx, "stripe", { actif: true, roles: ["construction"] }, "a")), 409)
  assert.equal(code(() => reglerConnecteur(ctx, "documentation", { actif: true, roles: [] }, "a")), 400)
  assert.equal(code(() => reglerConnecteur(ctx, "inconnu", { actif: true, roles: ["plan"] }, "a")), 404)
  reglerConnecteur(ctx, "documentation", { actif: true, roles: ["plan", "pirate", "plan"] }, "a")
  assert.deepEqual(listerConnecteurs(ctx).connecteurs.find((c) => c.id === "documentation").roles, ["plan"])
  reglerConnecteur(ctx, "documentation", { actif: false }, "a")
  assert.equal(listerConnecteurs(ctx).connecteurs.find((c) => c.id === "documentation").actif, false)
})

test("une clé : chiffrée, jamais renvoyée, et Stripe n'accepte qu'une clé de test", () => {
  const ctx = ctxDe()
  assert.equal(code(() => poserCleConnecteur(ctx, "stripe", "sk_live_une-vraie-cle-de-production", "a")), 400)
  assert.equal(code(() => poserCleConnecteur(ctx, "stripe", 'sk_test_"; rm -rf /', "a")), 400)
  assert.equal(code(() => poserCleConnecteur(ctx, "documentation", STRIPE, "a")), 400)
  poserCleConnecteur(ctx, "stripe", STRIPE, "a")
  const base = JSON.stringify(ctx.db.prepare("SELECT * FROM reglages").all())
  assert.ok(!base.includes("fausse-cle"))
  const vue = JSON.stringify(listerConnecteurs(ctx))
  assert.ok(!vue.includes("fausse-cle"))
  assert.equal(listerConnecteurs(ctx).connecteurs.find((c) => c.id === "stripe").cle_fin, "WXYZ")
  // Retirer la clé désactive le connecteur.
  reglerConnecteur(ctx, "stripe", { actif: true, roles: ["construction"] }, "a")
  effacerCleConnecteur(ctx, "stripe", "a")
  assert.equal(listerConnecteurs(ctx).connecteurs.find((c) => c.id === "stripe").actif, false)
})

test("les IA reçoivent les connecteurs de leur rôle ; la clé passe par une variable, jamais par le script", () => {
  const ctx = ctxDe()
  poserCleConnecteur(ctx, "stripe", STRIPE, "a")
  reglerConnecteur(ctx, "stripe", { actif: true, roles: ["construction", "verification"] }, "a")
  reglerConnecteur(ctx, "documentation", { actif: true, roles: ["plan", "construction"] }, "a")
  assert.equal(configClaude(ctx, "verification").mcpServers.documentation, undefined)
  const c = configClaude(ctx, "construction").mcpServers
  assert.deepEqual(c.documentation, { type: "http", url: "https://mcp.context7.com/mcp" })
  assert.deepEqual(c.stripe.env, { STRIPE_SECRET_KEY: "${CONNECTEUR_STRIPE}" })
  assert.deepEqual(outilsClaude(ctx, "plan"), ["mcp__documentation"])
  assert.deepEqual(envConnecteurs(ctx), { CONNECTEUR_STRIPE: STRIPE })

  const claude = scriptClaude(ctx, { args: "-p", modele: "m", sortie: "/tmp/s", role: "construction" })
  assert.match(claude, /--mcp-config '\/tmp\/sorties\/mcp-construction\.json' --strict-mcp-config/)
  assert.ok(!claude.includes("fausse-cle"))
  assert.ok(!scriptClaude(ctx, { args: "-p", modele: "m", sortie: "/tmp/s" }).includes("mcp-config"))

  const codex = optionsCodex(ctx, "verification")
  assert.match(codex, /mcp_servers\.stripe\.command="npx"/)
  assert.ok(codex.includes(`mcp_servers.stripe.env={STRIPE_SECRET_KEY=\\"$CONNECTEUR_STRIPE\\"}`))
  assert.ok(!codex.includes("fausse-cle"))
  // Les options des connecteurs passent avant celles du travail (dont « - », la consigne).
  assert.match(scriptCodex(ctx, { args: "--json -", journal: "/tmp/j", role: "verification" }), /mcp_servers\.stripe[^\n]*--json -/)
  assert.equal(optionsClaude(ctx, null).args, "")
})

test("un connecteur de l'équipe : https seulement, retirable ; un connecteur du catalogue ne se retire pas", () => {
  const ctx = ctxDe()
  assert.equal(code(() => ajouterConnecteur(ctx, { nom: "Base", adresse: "http://outil.exemple.test/mcp" }, "a")), 400)
  assert.equal(code(() => ajouterConnecteur(ctx, { nom: "Base", adresse: "https://moi:secret@outil.exemple.test/mcp" }, "a")), 400)
  assert.equal(code(() => ajouterConnecteur(ctx, { nom: "B", adresse: "https://outil.exemple.test/mcp" }, "a")), 400)
  const r = ajouterConnecteur(ctx, { nom: "Base clients", adresse: "https://outil.exemple.test/mcp", cle: "jeton-interne-1234" }, "a")
  assert.equal(r.id, "perso-1")
  reglerConnecteur(ctx, "perso-1", { actif: true, roles: ["construction"] }, "a")
  assert.deepEqual(configClaude(ctx, "construction").mcpServers["perso-1"], { type: "http", url: "https://outil.exemple.test/mcp", headers: { Authorization: "Bearer ${CONNECTEUR_PERSO_1}" } })
  assert.match(optionsCodex(ctx, "construction"), /bearer_token_env_var="CONNECTEUR_PERSO_1"/)
  assert.equal(code(() => retirerConnecteur(ctx, "documentation", "a")), 409)
  retirerConnecteur(ctx, "perso-1", "a")
  assert.equal(listerConnecteurs(ctx).connecteurs.length, CATALOGUE.length)
  assert.deepEqual(envConnecteurs(ctx), {})
})

test("le test ouvre une session MCP, sans écrire la clé dans le script", () => {
  const stripe = CATALOGUE.find((c) => c.id === "stripe")
  const s = scriptTest(stripe)
  assert.match(s, /STRIPE_SECRET_KEY="\$CONNECTEUR_STRIPE" timeout 150 'npx' '-y' '@stripe\/mcp@latest'/)
  assert.match(s, /"method":"initialize"/)
  assert.match(scriptTest(CATALOGUE.find((c) => c.id === "documentation")), /curl -s -m 30 -X POST/)
})
