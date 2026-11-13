// Sentry et PostHog réglés dans la console (services.mjs) : formats, coffre, coupure, retour à la
// valeur du serveur, tests sans dépense, et jamais une clé dans les travaux des agents.
// Aucun appel réseau : les tests fournissent leurs faux envois.
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { envFournisseurs } from "../src/fournisseurs.mjs"
import { appliquerServices, couperService, etatServices, poserService, retirerService, testerService, traduireEchec, validerDsn, validerHotePosthog, validerJetonPosthog, valeurService } from "../src/services.mjs"

const DSN = "https://0123456789abcdef0123456789abcdef@o4500000000000001.ingest.de.sentry.io/4500000000000002"
const DSN_US = "https://0123456789abcdef0123456789abcdef@o4500000000000001.ingest.us.sentry.io/4500000000000002"
const DSN_SERVEUR = "https://fedcba9876543210fedcba9876543210@o4500000000000009.ingest.de.sentry.io/4500000000000009"
const JETON = "phc_jetondetestjetondetest1234WXYZ"

const ctxDe = (secrets = {}) => {
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)")
  db.exec("CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, projet_id INTEGER, tache_id INTEGER, type TEXT NOT NULL, message TEXT NOT NULL, le TEXT NOT NULL DEFAULT (datetime('now')))")
  return { db, config: { secrets: { worker: "jeton-de-test-du-serveur-de-travaux", ...secrets } } }
}
// Un faux réglage de l'observabilité : garde ce qu'on lui applique.
const faux = () => {
  const appels = []
  const f = (cles) => (appels.push(cles), { sentry: true, posthog: true })
  f.appels = appels
  return f
}
// La valeur du serveur (secrets.sh), le temps d'un test.
function avecServeur(env, corps) {
  const avant = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]))
  Object.assign(process.env, env)
  try {
    return corps()
  } finally {
    for (const [k, v] of Object.entries(avant)) if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
}

test("formats Sentry : la clé d'envoi passe ; un jeton de lecture, une adresse quelconque ou http sont refusés", () => {
  assert.deepEqual(validerDsn(` ${DSN} `), { valeur: DSN, horsUE: false })
  assert.throws(() => validerDsn("sntrys_eyJpYXQiOjE3MDAwMDAwMDB9_abcdef"), /jeton de lecture/)
  assert.throws(() => validerDsn("sntryu_0123456789abcdef"), /jeton de lecture/)
  assert.throws(() => validerDsn("https://sentry.io/organizations/exemple/"), /pas une clé d'envoi Sentry/)
  assert.throws(() => validerDsn(DSN.replace("https://", "http://")), /https:\/\//)
  assert.equal(validerDsn(DSN_US).horsUE, true)
})

test("formats PostHog : le jeton de projet passe ; une clé personnelle est refusée ; la région", () => {
  assert.deepEqual(validerJetonPosthog(JETON), { valeur: JETON, horsUE: false })
  assert.throws(() => validerJetonPosthog("phx_0123456789abcdefghijklmnop"), /clé personnelle/)
  assert.throws(() => validerJetonPosthog("0123456789abcdefghijklmnop"), /commence par phc_/)
  assert.deepEqual(validerHotePosthog("eu.i.posthog.com"), { valeur: "eu.i.posthog.com", horsUE: false })
  assert.equal(validerHotePosthog("us.i.posthog.com").horsUE, true)
  assert.equal(validerHotePosthog("https://ph.exemple.fr/").valeur, "ph.exemple.fr")
  assert.throws(() => validerHotePosthog("pas une adresse"), /Région PostHog/)
})

test("une clé posée est chiffrée, jamais renvoyée, et sert tout de suite à l'usine", () => {
  const ctx = ctxDe()
  const regler = faux()
  const r = poserService(ctx, "SENTRY_DSN", DSN, "admin@exemple.fr", {}, regler)
  assert.equal(r.ok, true)
  assert.match(r.message, /dès maintenant/)
  const brut = ctx.db.prepare("SELECT valeur FROM reglages WHERE cle = 'service_SENTRY_DSN'").get().valeur
  assert.ok(!brut.includes("0123456789abcdef") && !brut.includes("ingest"), "la base ne garde pas la clé en clair")
  assert.equal(regler.appels.at(-1).sentryDsn, DSN)
  const e = etatServices(ctx, { actif: { sentry: true, posthog: false }, etat: () => ({ battement: {}, erreurs: {}, evenements: {}, journaux: {} }) })
  assert.ok(!JSON.stringify(e).includes("0123456789abcdef"), "l'état affiché ne contient pas la clé")
  const c = e.services.find((s) => s.id === "sentry").cles[0]
  assert.equal(c.source, "console")
  assert.equal(c.console.fin, "0002")
  assert.equal(c.console.par, "admin@exemple.fr")
  assert.match(ctx.db.prepare("SELECT message FROM journal").get().message, /posée dans la console par admin@exemple.fr/)
})

test("hors d'Europe : refusé sans confirmation, gardé avec", () => {
  const ctx = ctxDe()
  assert.throws(() => poserService(ctx, "SENTRY_DSN", DSN_US, "admin@exemple.fr", {}, faux()), (e) => e.code === 409 && e.horsUE === true)
  assert.equal(valeurService(ctx, "SENTRY_DSN").source, "aucune")
  poserService(ctx, "SENTRY_DSN", DSN_US, "admin@exemple.fr", { confirme: true }, faux())
  assert.equal(valeurService(ctx, "SENTRY_DSN").valeur, DSN_US)
  assert.match(ctx.db.prepare("SELECT message FROM journal ORDER BY id DESC").get().message, /hors d'Europe, confirmé/)
})

test("couper l'envoi l'emporte sur le serveur ; retirer rend la main au serveur", () => avecServeur({ SENTRY_DSN: DSN_SERVEUR }, () => {
  const ctx = ctxDe()
  const regler = faux()
  assert.deepEqual(valeurService(ctx, "SENTRY_DSN"), { valeur: DSN_SERVEUR, source: "serveur", illisible: false })
  couperService(ctx, "sentry", "admin@exemple.fr", regler)
  assert.deepEqual(valeurService(ctx, "SENTRY_DSN"), { valeur: "", source: "coupe" })
  assert.equal(regler.appels.at(-1).sentryDsn, "")
  const r = retirerService(ctx, "SENTRY_DSN", "admin@exemple.fr", regler)
  assert.match(r.message, /valeur du serveur reprend/)
  assert.equal(regler.appels.at(-1).sentryDsn, DSN_SERVEUR)
}))

test("la région PostHog : celle du serveur, sinon l'Europe ; elle se montre (ce n'est pas un secret)", () => {
  const ctx = ctxDe()
  const regler = faux()
  assert.equal(valeurService(ctx, "POSTHOG_HOTE").valeur, process.env.POSTHOG_HOTE || "eu.i.posthog.com")
  poserService(ctx, "POSTHOG_HOTE", "https://ph.exemple.fr", "admin@exemple.fr", {}, regler)
  assert.equal(regler.appels.at(-1).posthogHote, "ph.exemple.fr")
  const e = etatServices(ctx, { actif: { sentry: false, posthog: false }, etat: () => ({ battement: {}, erreurs: {}, evenements: {}, journaux: {} }) })
  assert.equal(e.services.find((s) => s.id === "posthog").cles.find((c) => c.nom === "POSTHOG_HOTE").valeur, "ph.exemple.fr")
})

test("les clés des services ne partent jamais dans les travaux des agents (registre à part)", () => {
  const ctx = ctxDe()
  poserService(ctx, "SENTRY_DSN", DSN, "admin@exemple.fr", {}, faux())
  poserService(ctx, "POSTHOG_TOKEN", JETON, "admin@exemple.fr", {}, faux())
  for (const moteur of [null, "claude-code", "codex"]) {
    const env = JSON.stringify(envFournisseurs(ctx, moteur))
    assert.ok(!env.includes("0123456789abcdef") && !env.includes(JETON) && !env.includes("SENTRY") && !env.includes("POSTHOG"), env)
  }
})

test("coffre verrouillé : une clé de la console illisible laisse servir celle du serveur", () => avecServeur({ SENTRY_DSN: DSN_SERVEUR }, () => {
  const scelle = ctxDe({ coffreMaitre: "cle-maitresse-axmaril-de-test-0123456789abcdef" })
  poserService(scelle, "SENTRY_DSN", DSN, "admin@exemple.fr", {}, faux())
  const sansAxmaril = { db: scelle.db, config: { secrets: { worker: "jeton-de-test-du-serveur-de-travaux" } } }
  const v = valeurService(sansAxmaril, "SENTRY_DSN")
  assert.deepEqual(v, { valeur: DSN_SERVEUR, source: "serveur", illisible: true })
  const regler = faux()
  const ecrire = console.error
  console.error = () => {}
  try {
    appliquerServices(sansAxmaril, regler)
  } finally {
    console.error = ecrire
  }
  assert.equal(regler.appels.at(-1).sentryDsn, DSN_SERVEUR)
}))

test("tester Sentry : le battement habituel, et un refus traduit en clair", async () => {
  const ctx = ctxDe()
  const instance = (etat) => ({ actif: { sentry: true, posthog: false }, battement: async () => etat.joignable, etat: () => ({ battement: etat }) })
  assert.equal((await testerService(ctx, "sentry", { instance: instance({ joignable: true }) })).ok, true)
  const refus = await testerService(ctx, "sentry", { instance: instance({ joignable: false, dernier_echec: { detail: "HTTP 403" } }) })
  assert.equal(refus.ok, false)
  assert.match(refus.message, /refuse cette clé/)
  assert.match(etatServices(ctx, { actif: { sentry: true, posthog: false }, etat: () => ({ battement: {}, erreurs: {}, evenements: {}, journaux: {} }) }).services[0].test.message, /refuse cette clé/)
  const sans = await testerService(ctx, "sentry", { instance: { actif: { sentry: false }, battement: async () => false, etat: () => ({}) } })
  assert.match(sans.message, /colle d'abord/)
})

test("tester PostHog : la lecture des drapeaux, dans la région choisie ; 401 veut dire jeton refusé", async () => {
  const ctx = ctxDe()
  poserService(ctx, "POSTHOG_TOKEN", JETON, "admin@exemple.fr", {}, faux())
  const urls = []
  const repondre = (status) => async (url, o) => (urls.push({ url, corps: JSON.parse(o.body) }), new Response(null, { status }))
  assert.equal((await testerService(ctx, "posthog", { fetch: repondre(200) })).ok, true)
  assert.equal(urls[0].url, `https://${process.env.POSTHOG_HOTE || "eu.i.posthog.com"}/flags/?v=2`)
  assert.equal(urls[0].corps.api_key, JETON)
  const refus = await testerService(ctx, "posthog", { fetch: repondre(401) })
  assert.match(refus.message, /refuse ce jeton/)
  const muet = await testerService(ctx, "posthog", { fetch: async () => { throw Object.assign(new Error("délai"), { name: "TimeoutError" }) } })
  assert.match(muet.message, /ne répond pas/)
})

test("traduireEchec : chaque réponse en une phrase", () => {
  assert.match(traduireEchec("sentry", "pas de réponse en 5000 ms"), /ne répond pas/)
  assert.match(traduireEchec("sentry", "HTTP 429"), /quota atteint/)
  assert.match(traduireEchec("sentry", "HTTP 400"), /copiée incomplète/)
  assert.match(traduireEchec("posthog", "HTTP 503"), /HTTP 503/)
})

test("hors d'Europe : seulement sentry.io hors de sa région UE ; un Sentry de l'entreprise n'est pas classé", () => {
  assert.equal(validerDsn("https://cle@sentry.mon-entreprise.fr/3").horsUE, false)
  assert.equal(validerDsn("https://cle@sentry.mon-entreprise.fr:9000/3").horsUE, false)
  assert.equal(validerDsn("https://cle@o1.ingest.sentry.io/3").horsUE, true)
  assert.equal(validerDsn("https://cle@o1.ingest.us.sentry.io/3").horsUE, true)
  assert.equal(validerDsn("https://cle@o1.ingest.de.sentry.io/3").horsUE, false)
  const ctx = ctxDe()
  poserService(ctx, "SENTRY_DSN", "https://0123456789abcdef@sentry.mon-entreprise.fr/3", "admin@exemple.fr", {}, faux())
  assert.doesNotMatch(ctx.db.prepare("SELECT message FROM journal ORDER BY id DESC").get().message, /hors d'Europe/, "le journal ne note pas un fait faux")
})

test("le dernier test s'efface dès que la clé change (posée, retirée, coupée)", async () => {
  const ctx = ctxDe()
  const dernierTest = () => etatServices(ctx, { actif: { sentry: true, posthog: false }, etat: () => ({ battement: {}, erreurs: {}, evenements: {} }) }).services.find((s) => s.id === "sentry").test
  const instance = { actif: { sentry: true, posthog: false }, battement: async () => true, etat: () => ({ battement: { joignable: true } }) }
  for (const changer of [() => poserService(ctx, "SENTRY_DSN", DSN, "admin@exemple.fr", {}, faux()), () => couperService(ctx, "sentry", "admin@exemple.fr", faux()), () => retirerService(ctx, "SENTRY_DSN", "admin@exemple.fr", faux())]) {
    await testerService(ctx, "sentry", { instance })
    assert.equal(dernierTest().ok, true)
    changer()
    assert.equal(dernierTest(), null, "le verdict d'avant ne dit rien de la nouvelle clé")
  }
})

test("PostHog : l'usine n'envoie pas de journaux de conteneurs, la console n'en parle pas pour elle", () => {
  const ctx = ctxDe()
  const e = etatServices(ctx, { actif: { sentry: false, posthog: true }, etat: () => ({ battement: {}, erreurs: {}, evenements: { envoyes: 2, echecs: 0, joignable: true, dernier_ok: "2026-11-13T12:00:00.000Z" } }) })
  assert.deepEqual(Object.keys(e.services.find((s) => s.id === "posthog").envoi), ["evenements"])
})

test("au démarrage, aucun battement avant que les réglages de la console soient appliqués", () => {
  const source = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")
  const index = source("index.mjs")
  assert.ok(index.indexOf("appliquerServices(ctx)") > 0 && index.indexOf("appliquerServices(ctx)") < index.indexOf("demarrerBattement()"), "le battement part après appliquerServices")
  const demarrer = /export function demarrerObservabilite\(\) \{([\s\S]*?)\n\}/.exec(source("observabilite.mjs"))[1]
  assert.doesNotMatch(demarrer, /battre|battement|setInterval/, "demarrerObservabilite ne bat pas")
})
