// L'observabilité du produit (server/observabilite.js) : rien de personnel ne sort, le pouls ne
// porte que des compteurs, et rien ne part sous les tests. Un faux fetch garde les requêtes.
import { test } from "node:test"
import assert from "node:assert/strict"
import { compteursSurs, creerObservabilite, nettoyer } from "../server/observabilite.js"

const ENV = { SENTRY_DSN: "https://clepublique@o1.ingest.de.sentry.io/2", POSTHOG_TOKEN: "phc_jetondetestjetondetest1234", USINE_PRODUIT: "mon-produit", USINE_ENVIRONNEMENT: "apercu", USINE_VERSION: "94f260e5a1b2" }
function fauxFetch() {
  const appels = []
  const f = async (url, o) => (appels.push({ url, ...o }), new Response(null, { status: 200 }))
  f.appels = appels
  return f
}

test("nettoyer : adresses email, téléphones, jetons des liens publics ne sortent pas", () => {
  const t = nettoyer("relance de lea.martin@exemple.fr au 06 12 34 56 78, lien /api/public/r/k3Jx9QmZ2vT8pL4wR7nY1aB6")
  assert.equal(t, "relance de [email] au [téléphone], lien /api/public/r/[jeton]")
})

test("compteursSurs : des nombres et des booléens seulement, jamais un texte", () => {
  assert.deepEqual(compteursSurs({ en_attente: 3, actif: true, vide: null, nom: "Léa Martin", liste: [1], Majuscule: 1, infini: Infinity }), { en_attente: 3, actif: true, vide: null })
})

test("sous node --test, sans faux fetch, rien ne part même avec des clés", () => {
  const o = creerObservabilite({ env: { ...ENV, NODE_TEST_CONTEXT: "child-v8" } })
  assert.deepEqual(o.actif, { sentry: false, posthog: false })
})

test("le pouls : un événement PostHog avec les compteurs, étiqueté par le produit", async () => {
  const f = fauxFetch()
  const o = creerObservabilite({ env: ENV, fetch: f, signaler: () => {} })
  o.ajouterPouls(() => ({ en_attente: 4, client: "Léa Martin" }))
  o.ajouterPouls(async () => ({ envois_ok: 12 }))
  assert.equal(await o.envoyerPouls(), true)
  const [appel] = f.appels
  assert.equal(appel.url, "https://eu.i.posthog.com/batch/")
  const corps = JSON.parse(appel.body)
  assert.equal(corps.api_key, ENV.POSTHOG_TOKEN)
  const [e] = corps.batch
  assert.equal(e.event, "pouls")
  assert.equal(e.distinct_id, "produit:mon-produit")
  assert.deepEqual([e.properties.produit, e.properties.environnement, e.properties.version, e.properties.en_attente, e.properties.envois_ok, e.properties.$process_person_profile, e.properties.$geoip_disable], ["mon-produit", "apercu", "94f260e5a1b2", 4, 12, false, true])
  assert.equal(e.properties.client, undefined)
  assert.ok(!appel.body.includes("Léa"))
})

test("une erreur : une enveloppe Sentry, masquée, une seule fois pour des doublons", async () => {
  const f = fauxFetch()
  const o = creerObservabilite({ env: ENV, fetch: f, signaler: () => {} })
  assert.equal(await o.signalerErreur(new Error("envoi à lea.martin@exemple.fr refusé après 3 essais")), true)
  assert.equal(await o.signalerErreur(new Error("envoi à lea.martin@exemple.fr refusé après 4 essais")), false)
  assert.equal(f.appels.length, 1)
  assert.equal(f.appels[0].url, "https://o1.ingest.de.sentry.io/api/2/envelope/")
  const e = JSON.parse(f.appels[0].body.split("\n")[2])
  assert.equal(e.exception.values[0].value, "envoi à [email] refusé après 3 essais")
  assert.deepEqual([e.environment, e.tags.produit, e.release], ["apercu", "mon-produit", "mon-produit@94f260e5a1b2"])
})

test("un service injoignable : rien n'est levé, le produit continue", async () => {
  const o = creerObservabilite({ env: ENV, fetch: async () => { throw new Error("ECONNREFUSED") }, signaler: () => {} })
  assert.equal(await o.envoyerPouls(), false)
  assert.equal(await o.signalerErreur(new Error("x")), false)
  assert.deepEqual(o.etat().pouls, { envoyes: 0, echecs: 1 })
})
