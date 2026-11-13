// L'envoi d'emails, la passerelle des applications et Slack réglés dans la console (services.mjs) :
// formats, bloc d'envoi jamais mêlé au serveur, Slack jamais dans la boîte, relance de Slack,
// tests traduits en clair. Aucun appel réseau.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { blocCourriel, contenuBoite, couperService, essaiCourriel, etatServices, poserService, testerService, traduireEchecSmtp, validerAdmins, validerCanal, validerExpediteur, validerHoteSmtp, validerJetonApp, validerJetonBot } from "../src/services.mjs"
import { courrielConfigure, envoiDisponible } from "../src/courriel.mjs"

const regler = () => ({ sentry: false, posthog: false })
// De faux jetons, assemblés ici pour qu'aucun jeton n'apparaisse tel quel dans le dépôt (public).
const BOT = ["xoxb", "0000000000", "0000000000", "jetonfacticejetonfacticex"].join("-")
const APP = ["xapp", "1", "A0000000000", "0000000000", "jetonfacticejetonfactice00"].join("-")
const instance = { actif: { sentry: false, posthog: false }, etat: () => ({ battement: {}, erreurs: {}, evenements: {}, journaux: {} }) }

function ctxDe() {
  const dossier = mkdtempSync(join(tmpdir(), "usine-lot3-"))
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)")
  db.exec("CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, projet_id INTEGER, tache_id INTEGER, type TEXT NOT NULL, message TEXT NOT NULL, le TEXT NOT NULL DEFAULT (datetime('now')))")
  db.exec("CREATE TABLE projets (id INTEGER PRIMARY KEY, slug TEXT, nom TEXT)")
  const ctx = { db, config: { secrets: { worker: "jeton-de-test-du-serveur-de-travaux", slackBot: "", slackApp: "" }, slack: { canal: "", admins: [] }, serveur: { slackCanal: "", slackAdmins: "" }, etatDir: join(dossier, "etat"), boiteDir: join(dossier, "boite") } }
  return { ctx, fin: () => rmSync(dossier, { recursive: true, force: true }) }
}

test("formats : serveur d'envoi, expéditeur, jetons Slack (l'un pris pour l'autre), canal, administrateurs", () => {
  assert.equal(validerHoteSmtp("SMTP.Exemple.fr").valeur, "smtp.exemple.fr")
  assert.throws(() => validerHoteSmtp("https://smtp.exemple.fr:587"), /sans https/)
  assert.equal(validerExpediteur("Usine <usine@exemple.fr>").valeur, "Usine <usine@exemple.fr>")
  assert.throws(() => validerExpediteur("usine@exemple.fr\nBcc: x@exemple.fr"), /Expéditeur/)
  assert.equal(validerJetonBot(BOT).valeur, BOT)
  assert.throws(() => validerJetonBot(APP), /jeton de l'application/)
  assert.throws(() => validerJetonApp(BOT), /jeton du bot/)
  assert.equal(validerCanal("C0123456789").valeur, "C0123456789")
  assert.throws(() => validerCanal("#general"), /identifiant/)
  assert.equal(validerAdmins("U0123456789, U0987654321,U0123456789").valeur, "U0123456789,U0987654321")
  assert.throws(() => validerAdmins("*"), /tout l'espace/)
  assert.throws(() => validerAdmins(""), /Administrateurs/)
})

test("l'envoi d'emails en un bloc : dès que le serveur d'envoi vient de la console, tout en vient", () => {
  const { ctx, fin } = ctxDe()
  try {
    assert.equal(blocCourriel(ctx), null, "rien dans la console : le serveur")
    poserService(ctx, "SMTP_HOST", "smtp.exemple.fr", "admin@exemple.fr", {}, regler)
    poserService(ctx, "SMTP_PORT", "465", "admin@exemple.fr", {}, regler)
    poserService(ctx, "SMTP_SECURE", "1", "admin@exemple.fr", {}, regler)
    poserService(ctx, "EMAIL_EXPEDITEUR", "Usine <usine@exemple.fr>", "admin@exemple.fr", {}, regler)
    poserService(ctx, "SMTP_PASS", "mot-de-passe-de-test", "admin@exemple.fr", {}, regler)
    assert.deepEqual(blocCourriel(ctx), { hote: "smtp.exemple.fr", port: "465", securite: "1", expediteur: "Usine <usine@exemple.fr>", utilisateur: "", motDePasse: "mot-de-passe-de-test" })
    // L'orchestrateur s'en sert aussitôt (invitations, emails réels).
    assert.equal(courrielConfigure(), true)
    assert.equal(envoiDisponible(), true)
    // Le déployeur le reçoit par la boîte, mot de passe compris ; l'état affiché, jamais.
    assert.equal(contenuBoite(ctx).cles.SMTP_PASS, "mot-de-passe-de-test")
    assert.ok(!JSON.stringify(etatServices(ctx, instance)).includes("mot-de-passe-de-test"))
    assert.equal(JSON.parse(readFileSync(join(ctx.config.boiteDir, "deployeur.json"), "utf8")).cles.SMTP_HOST, "smtp.exemple.fr")
    couperService(ctx, "smtp", "admin@exemple.fr", regler)
    assert.equal(envoiDisponible(), false, "coupé : plus d'envoi, même avec le serveur")
  } finally {
    fin()
  }
})

test("Slack : pour l'orchestrateur seul, jamais dans la boîte ; ses jetons relancent la connexion", async () => {
  const { ctx, fin } = ctxDe()
  try {
    let relances = 0
    ctx.relancerSlack = async () => { relances++ }
    poserService(ctx, "SLACK_BOT_TOKEN", BOT, "admin@exemple.fr", {}, regler)
    poserService(ctx, "SLACK_APP_TOKEN", APP, "admin@exemple.fr", {}, regler)
    poserService(ctx, "SLACK_CANAL", "C0123456789", "admin@exemple.fr", {}, regler)
    poserService(ctx, "ADMIN_USER_IDS", "U0123456789", "admin@exemple.fr", {}, regler)
    await new Promise((r) => setImmediate(r))
    assert.equal(relances, 2, "seuls les jetons rouvrent la connexion ; le canal et les administrateurs se lisent à chaque message")
    assert.equal(ctx.config.secrets.slackBot, BOT)
    assert.deepEqual(ctx.config.slack, { canal: "C0123456789", admins: ["U0123456789"] })
    const boite = JSON.stringify(contenuBoite(ctx))
    assert.ok(!boite.includes("xoxb-") && !boite.includes("xapp-") && !boite.includes("SLACK"), boite)
    couperService(ctx, "slack", "admin@exemple.fr", regler)
    await new Promise((r) => setImmediate(r))
    assert.equal(ctx.config.secrets.slackBot, "", "débranché : plus de jeton de bot")
    assert.equal(relances, 3)
  } finally {
    fin()
  }
})

test("tests : l'envoi d'emails vérifié sans rien envoyer ; Slack et la passerelle traduits en clair", async () => {
  const { ctx, fin } = ctxDe()
  try {
    assert.match((await testerService(ctx, "smtp", { verifier: async () => {} })).message, /Aucun serveur d'envoi/)
    poserService(ctx, "SMTP_HOST", "smtp.exemple.fr", "admin@exemple.fr", {}, regler)
    assert.equal((await testerService(ctx, "smtp", { verifier: async () => {} })).ok, true)
    const refus = await testerService(ctx, "smtp", { verifier: async () => { throw Object.assign(new Error("Invalid login"), { code: "EAUTH", responseCode: 535 }) } })
    assert.match(refus.message, /refuse l'identifiant ou le mot de passe/)
    assert.match(traduireEchecSmtp({ code: "ETIMEDOUT", message: "Connection timeout" }), /587 ou 465/)
    assert.match((await essaiCourriel(ctx, "admin@exemple.fr", async () => {})).message, /envoyé à admin@exemple.fr/)

    poserService(ctx, "SLACK_BOT_TOKEN", BOT, "admin@exemple.fr", {}, regler)
    const slack = (corps) => async (url, o) => (assert.equal(o.headers.authorization, `Bearer ${BOT}`), new Response(JSON.stringify(corps), { status: 200 }))
    const ok = await testerService(ctx, "slack", { fetch: slack({ ok: true, team: "Équipe de test" }) })
    assert.match(ok.message, /Équipe de test.*aucun administrateur/)
    assert.match((await testerService(ctx, "slack", { fetch: slack({ ok: false, error: "invalid_auth" }) })).message, /refuse ce jeton de bot/)

    poserService(ctx, "AI_GATEWAY_API_KEY_APPLIS", "vck_cle-de-test-des-applications-0123", "admin@exemple.fr", {}, regler)
    assert.match((await testerService(ctx, "passerelle", { fetch: async () => new Response(null, { status: 401 }) })).message, /refuse cette clé/)
    assert.equal((await testerService(ctx, "passerelle", { fetch: async () => new Response(null, { status: 200 }) })).ok, true)
    // La clé des applications va aux applications seulement (boîte), jamais à l'orchestrateur ni aux agents.
    assert.equal(contenuBoite(ctx).cles.AI_GATEWAY_API_KEY_APPLIS, "vck_cle-de-test-des-applications-0123")
  } finally {
    fin()
  }
})
