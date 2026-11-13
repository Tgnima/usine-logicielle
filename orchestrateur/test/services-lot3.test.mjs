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
import { fileDeRelance } from "../src/slack.mjs"

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
    // Sans expéditeur, aucun email ne part : le test le dit, même si la connexion passe.
    const sansExpediteur = await testerService(ctx, "smtp", { verifier: async () => {} })
    assert.equal(sansExpediteur.ok, false)
    assert.match(sansExpediteur.message, /manque l'expéditeur/)
    poserService(ctx, "EMAIL_EXPEDITEUR", "usine@exemple.fr", "admin@exemple.fr", {}, regler)
    const sansIdentifiant = await testerService(ctx, "smtp", { verifier: async () => {} })
    assert.equal(sansIdentifiant.ok, true)
    assert.match(sansIdentifiant.message, /sans identifiant/, "aucun identifiant ne sert : le test ne prétend pas l'avoir vérifié")
    poserService(ctx, "SMTP_USER", "compte@exemple.fr", "admin@exemple.fr", {}, regler)
    assert.match((await testerService(ctx, "smtp", { verifier: async () => {} })).message, /chiffrée et les identifiants/)
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

// Les réglages du serveur (.env et secrets), le temps d'un test.
function avecServeur(env, corps) {
  const avant = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  const remettre = () => {
    for (const [k, v] of Object.entries(avant)) if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    const r = corps()
    if (r?.then) return r.finally(remettre)
    remettre()
    return r
  } catch (e) {
    remettre()
    throw e
  }
}
const SERVEUR_SMTP = { SMTP_HOST: "smtp.serveur.exemple", SMTP_PORT: "465", SMTP_SECURE: "1", EMAIL_EXPEDITEUR: "usine@serveur.exemple", SMTP_USER: "compte-du-serveur", SMTP_PASS: "mot-de-passe-du-serveur" }
const cleDe = (e, nom) => e.services.find((s) => s.id === "smtp").cles.find((c) => c.nom === nom)

test("emails : le serveur d'envoi vient de la console, les autres champs montrent ce qui sert vraiment", () => avecServeur(SERVEUR_SMTP, () => {
  const { ctx, fin } = ctxDe()
  try {
    poserService(ctx, "SMTP_HOST", "smtp.console.exemple", "admin@exemple.fr", {}, regler)
    const e = etatServices(ctx, instance)
    // Le bloc de la console sert : port, sécurité, expéditeur et identifiants du serveur ne servent plus.
    for (const nom of ["SMTP_PORT", "SMTP_SECURE", "EMAIL_EXPEDITEUR", "SMTP_USER", "SMTP_PASS"]) {
      const c = cleDe(e, nom)
      assert.equal(c.source, "aucune", nom)
      assert.equal(c.serveur, false, `${nom} ne se présente plus comme « posée sur le serveur »`)
      if (!c.secret) assert.equal(c.valeur, "", nom)
    }
    assert.equal(e.services.find((s) => s.id === "smtp").complet, false, "sans expéditeur, l'envoi n'est pas complet")
    // Ce qu'on adopte depuis la console sert tel quel.
    poserService(ctx, "EMAIL_EXPEDITEUR", "usine@console.exemple", "admin@exemple.fr", {}, regler)
    assert.equal(cleDe(etatServices(ctx, instance), "EMAIL_EXPEDITEUR").valeur, "usine@console.exemple")
    assert.equal(etatServices(ctx, instance).services.find((s) => s.id === "smtp").complet, true)
  } finally {
    fin()
  }
}))

test("emails : une clé posée dans la console alors que le serveur d'envoi vient du serveur ne se dit pas en service", () => avecServeur(SERVEUR_SMTP, () => {
  const { ctx, fin } = ctxDe()
  try {
    const r = poserService(ctx, "SMTP_PASS", "bon-mot-de-passe", "admin@exemple.fr", {}, regler)
    assert.match(r.message, /ne sert pas encore/)
    assert.doesNotMatch(r.message, /dès maintenant/)
    const c = cleDe(etatServices(ctx, instance), "SMTP_PASS")
    assert.equal(c.en_attente, true)
    assert.equal(blocCourriel(ctx), null, "le serveur sert toujours, en bloc")
    // Le serveur d'envoi posé ici : la console prend la main, et le dit pour ce qui manque.
    const hote = poserService(ctx, "SMTP_HOST", "smtp.console.exemple", "admin@exemple.fr", {}, regler)
    // Le mot de passe vient d'être posé ici ; l'expéditeur et l'identifiant du serveur ne servent plus.
    assert.match(hote.message, /Il manque encore ici l'expéditeur et l'identifiant \(ceux du serveur ne servent plus\)/)
    assert.equal(cleDe(etatServices(ctx, instance), "SMTP_PASS").en_attente, false)
  } finally {
    fin()
  }
}))

test("emails : le mot de passe n'est jamais gardé en partie, ni affiché", () => {
  const { ctx, fin } = ctxDe()
  try {
    poserService(ctx, "SMTP_PASS", "Lyon-Rhone", "admin@exemple.fr", {}, regler)
    const brut = ctx.db.prepare("SELECT valeur FROM reglages WHERE cle = 'service_SMTP_PASS'").get().valeur
    assert.ok(!brut.includes("hone") && !brut.includes("Lyon") && !("fin" in JSON.parse(brut)), brut)
    assert.equal(cleDe(etatServices(ctx, instance), "SMTP_PASS").console.fin, null)
    // Une entrée d'avant (avec sa fin en clair) ne la montre plus non plus.
    ctx.db.prepare("UPDATE reglages SET valeur = ? WHERE cle = 'service_SMTP_PASS'").run(JSON.stringify({ ...JSON.parse(brut), fin: "hone" }))
    assert.equal(cleDe(etatServices(ctx, instance), "SMTP_PASS").console.fin, null)
  } finally {
    fin()
  }
})

test("Slack : chaque pose dit ce qui se passe vraiment (canal, administrateurs, jeton qui manque)", () => {
  const { ctx, fin } = ctxDe()
  try {
    ctx.relancerSlack = async () => {}
    assert.equal(poserService(ctx, "SLACK_CANAL", "C0123456789", "admin@exemple.fr", {}, regler).message, "Canal enregistré : pris en compte dès le prochain message.")
    assert.match(poserService(ctx, "ADMIN_USER_IDS", "U0123456789", "admin@exemple.fr", {}, regler).message, /^Administrateurs enregistrés : pris en compte/)
    assert.match(poserService(ctx, "SLACK_BOT_TOKEN", BOT, "admin@exemple.fr", {}, regler).message, /Il manque encore le jeton de l'application/)
    assert.match(poserService(ctx, "SLACK_APP_TOKEN", APP, "admin@exemple.fr", {}, regler).message, /la connexion à Slack se rouvre/)
  } finally {
    fin()
  }
})

test("Slack : des relances rapprochées passent en file ; la dernière l'emporte, aucune connexion orpheline", async () => {
  // Une fausse connexion : démarrer dure 30 ms, arrêter ferme celle qui est tenue (comme arreterSlack).
  const ouvertes = new Set()
  let tenue = null
  let enMemeTemps = 0
  let max = 0
  const ctx = { config: { secrets: { slackBot: "bot-1", slackApp: "app-1" } } }
  const demarrer = async (c) => {
    enMemeTemps++
    max = Math.max(max, enMemeTemps)
    const cnx = `${c.config.secrets.slackBot}+${c.config.secrets.slackApp}`
    await new Promise((r) => setTimeout(r, 30))
    ouvertes.add(cnx)
    tenue = cnx
    enMemeTemps--
  }
  const arreter = async () => {
    if (tenue) ouvertes.delete(tenue)
    tenue = null
  }
  const journal = console.log
  console.log = () => {}
  try {
    const relancer = fileDeRelance(ctx, { demarrer, arreter })
    const a = relancer()
    ctx.config.secrets.slackBot = "bot-2"
    const b = relancer()
    ctx.config.secrets.slackApp = "app-2"
    const c = relancer()
    await Promise.all([a, b, c])
    assert.equal(max, 1, "une seule relance à la fois")
    assert.deepEqual([...ouvertes], ["bot-2+app-2"], "une seule connexion, avec les derniers jetons")
    // Débrancher pendant un démarrage : la coupure passe après, et ferme tout.
    const d = relancer()
    ctx.config.secrets.slackBot = ""
    const e = relancer()
    await Promise.all([d, e])
    assert.deepEqual([...ouvertes], [], "débranché : plus aucune connexion")
  } finally {
    console.log = journal
  }
})
