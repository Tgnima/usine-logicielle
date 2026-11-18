// L'IA des applications réglée dans la console (services.mjs) : le serveur de modèles (un GPU, API
// compatible OpenAI) à côté de la passerelle. Formats, boîte (jamais l'orchestrateur), coupure de
// toute l'IA, test traduit en clair sans jamais l'adresse. Aucun appel réseau.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { contenuBoite, couperService, etatServices, poserService, reprendreService, testerService, testerServeurModeles, validerNomModele, validerUrlModeles } from "../src/services.mjs"

const regler = () => ({ sentry: false, posthog: false })
const instance = { actif: { sentry: false, posthog: false }, etat: () => ({ battement: {}, erreurs: {}, evenements: {}, journaux: {} }) }
const URL_MODELES = "https://modeles.exemple.test/v1"

function ctxDe() {
  const dossier = mkdtempSync(join(tmpdir(), "usine-ia-"))
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)")
  db.exec("CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, projet_id INTEGER, tache_id INTEGER, type TEXT NOT NULL, message TEXT NOT NULL, le TEXT NOT NULL DEFAULT (datetime('now')))")
  db.exec("CREATE TABLE projets (id INTEGER PRIMARY KEY, slug TEXT, nom TEXT)")
  const ctx = { db, config: { secrets: { worker: "jeton-de-test-du-serveur-de-travaux", slackBot: "", slackApp: "" }, slack: { canal: "", admins: [] }, serveur: { slackCanal: "", slackAdmins: "" }, etatDir: join(dossier, "etat"), boiteDir: join(dossier, "boite") } }
  return { ctx, fin: () => rmSync(dossier, { recursive: true, force: true }) }
}
const reponse = (corps, status = 200) => async () => new Response(corps === null ? null : JSON.stringify(corps), { status })

test("formats : adresse du serveur de modèles et nom du modèle", () => {
  assert.equal(validerUrlModeles(" https://modeles.exemple.test/v1/ ").valeur, URL_MODELES)
  assert.equal(validerUrlModeles("https://modeles.exemple.test/v1/chat/completions").valeur, URL_MODELES, "ramenée à sa base")
  assert.equal(validerUrlModeles("http://10.0.0.5:8080/v1").valeur, "http://10.0.0.5:8080/v1", "http permis sur un réseau privé")
  assert.throws(() => validerUrlModeles("modeles.exemple.test/v1"), /adresse complète/)
  assert.throws(() => validerUrlModeles("ftp://modeles.exemple.test"), /https:\/\//)
  assert.throws(() => validerUrlModeles("https://moi:secret@modeles.exemple.test/v1"), /Pas d'identifiant/)
  assert.throws(() => validerUrlModeles("https://modeles.exemple.test/v1?cle=x"), /sans « \? »/)
  assert.equal(validerNomModele("qwen3.5-9b").valeur, "qwen3.5-9b")
  assert.equal(validerNomModele("Qwen/Qwen3.5-9B:Q4_K_M").valeur, "Qwen/Qwen3.5-9B:Q4_K_M")
  assert.throws(() => validerNomModele("qwen 9b"), /sans espace/)
})

test("le serveur de modèles va aux applications seulement, et « Retirer l'IA » le retire aussi", () => {
  const { ctx, fin } = ctxDe()
  try {
    const messages = [
      poserService(ctx, "LLM_URL_APPLIS", URL_MODELES, "admin@exemple.fr", {}, regler),
      poserService(ctx, "LLM_CLE_APPLIS", "cle-du-serveur-de-modeles", "admin@exemple.fr", {}, regler),
      poserService(ctx, "LLM_NOM_APPLIS", "qwen3.5-9b", "admin@exemple.fr", {}, regler),
    ].map((r) => r.message)
    assert.match(messages[0], /enregistrée : les applications la recevront/)
    assert.match(messages[2], /enregistré : les applications le recevront/)
    const cles = contenuBoite(ctx).cles
    assert.equal(cles.LLM_URL_APPLIS, URL_MODELES)
    assert.equal(cles.LLM_CLE_APPLIS, "cle-du-serveur-de-modeles")
    assert.equal(cles.LLM_NOM_APPLIS, "qwen3.5-9b")
    // La console le montre branché ; la clé n'apparaît jamais dans l'état (secrète), l'adresse oui (pas secrète).
    const etat = () => etatServices(ctx, instance).services.find((s) => s.id === "passerelle")
    assert.equal(etat().actif, true)
    assert.ok(!JSON.stringify(etat()).includes("cle-du-serveur-de-modeles"))
    // Couper : la clé de passerelle part vide dans la boîte (le déployeur retire alors toute l'IA), la console le montre.
    couperService(ctx, "passerelle", "admin@exemple.fr", regler)
    assert.equal(contenuBoite(ctx).cles.AI_GATEWAY_API_KEY_APPLIS, "")
    assert.equal(etat().actif, false)
    reprendreService(ctx, "passerelle", "admin@exemple.fr", regler)
    assert.equal(etat().actif, true)
    // L'adresse du serveur ne finit jamais dans le journal.
    const journal = ctx.db.prepare("SELECT message FROM journal").all().map((l) => l.message).join("\n")
    assert.ok(!journal.includes("modeles.exemple.test"))
  } finally {
    fin()
  }
})

test("tester le serveur de modèles : liste des modèles, clé refusée, modèle absent, http, injoignable", async () => {
  const appels = []
  const avec = (corps, status) => async (url, o) => (appels.push({ url, auth: o.headers.authorization ?? null }), reponse(corps, status)())
  const ok = await testerServeurModeles(avec({ data: [{ id: "qwen3.5-9b" }, { id: "whisper" }] }), URL_MODELES, "cle", "qwen3.5-9b", 1000)
  assert.equal(ok.ok, true)
  assert.match(ok.message, /répond \(modèle qwen3\.5-9b\)/)
  assert.deepEqual(appels[0], { url: `${URL_MODELES}/models`, auth: "Bearer cle" })
  assert.match((await testerServeurModeles(avec({ data: [{ id: "qwen3.5-9b" }] }), URL_MODELES, "", "", 1000)).message, /modèles : qwen3\.5-9b/)
  assert.match((await testerServeurModeles(avec(null, 401), URL_MODELES, "cle", "", 1000)).message, /refuse cette clé/)
  assert.match((await testerServeurModeles(avec(null, 401), URL_MODELES, "", "", 1000)).message, /demande une clé/)
  const absent = await testerServeurModeles(avec({ data: [{ id: "llama" }] }), URL_MODELES, "", "qwen3.5-9b", 1000)
  assert.equal(absent.ok, false)
  assert.match(absent.message, /ne propose pas « qwen3\.5-9b » \(il propose : llama\)/)
  assert.match((await testerServeurModeles(avec({ pas: "openai" }), URL_MODELES, "", "", 1000)).message, /pas une API compatible OpenAI/)
  assert.match((await testerServeurModeles(avec({ data: [{ id: "m" }] }), "http://10.0.0.5:8080/v1", "", "", 1000)).message, /en http, les échanges ne sont pas chiffrés/)
  const lent = await testerServeurModeles(async () => { throw Object.assign(new Error("délai"), { name: "TimeoutError" }) }, URL_MODELES, "", "", 1000)
  assert.match(lent.message, /ne répond pas depuis le serveur de l'usine/)
  const coupe = await testerServeurModeles(async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }) }, URL_MODELES, "", "", 1000)
  assert.match(coupe.message, /injoignable.*ENOTFOUND/)
  for (const r of [ok, absent, lent, coupe]) assert.ok(!r.message.includes("modeles.exemple.test"), "jamais l'adresse dans le message")
})

test("le test de la carte essaie le serveur de modèles puis la passerelle, et les dit tous les deux", async () => {
  const { ctx, fin } = ctxDe()
  try {
    assert.match((await testerService(ctx, "passerelle", { fetch: reponse(null) })).message, /Ni serveur de modèles ni clé dédiée/)
    poserService(ctx, "LLM_URL_APPLIS", URL_MODELES, "admin@exemple.fr", {}, regler)
    poserService(ctx, "AI_GATEWAY_API_KEY_APPLIS", "vck_cle-de-test-des-applications-0123", "admin@exemple.fr", {}, regler)
    const envoyer = async (url) => (url.includes("modeles.exemple.test") ? new Response(JSON.stringify({ data: [{ id: "qwen3.5-9b" }] }), { status: 200 }) : new Response(null, { status: 401 }))
    const r = await testerService(ctx, "passerelle", { fetch: envoyer })
    assert.equal(r.ok, false, "la passerelle refuse sa clé")
    assert.match(r.message, /Le serveur de modèles répond.*La passerelle refuse cette clé/)
  } finally {
    fin()
  }
})
