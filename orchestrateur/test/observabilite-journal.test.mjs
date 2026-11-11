// L'orchestrateur vers PostHog : chaque ligne du journal devient un événement, sans son texte.
import { test } from "node:test"
import assert from "node:assert/strict"
import { creerObservabilite } from "../../commun/observabilite.mjs"
import { ouvrirCouts } from "../src/couts.mjs"
import { noter, ouvrirDb } from "../src/db.mjs"
import { evenementJournal, obs, proprietesJournal } from "../src/observabilite.mjs"

function base() {
  const db = ouvrirDb(":memory:")
  ouvrirCouts(db)
  db.prepare("INSERT INTO projets (id, slug, nom, prompt, statut) VALUES (9, 'acte-clair', 'Acte Clair', 'le prompt confidentiel', 'fabrication')").run()
  db.prepare("INSERT INTO taches (id, projet_id, cle, lot, titre, description, criteres, statut, tentative) VALUES (41, 9, 'L2-T3', 2, 'Envoi', 'd', '[]', 'verification', 1)").run()
  db.prepare("INSERT INTO taches (id, projet_id, cle, lot, titre, description, criteres) VALUES (42, 9, 'L2-T4', 2, 'Autre', 'd', '[]')").run()
  const conso = db.prepare("INSERT INTO consommations (projet_id, tache_id, role, moteur, modele, entree, sortie, cout_api_usd, duree_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
  conso.run(9, 41, "agent", "claude-code", "claude-opus", 1000, 200, 0.12345, 61.24)
  conso.run(9, 41, "verificateur", "codex", "gpt", 500, 100, null, 30)
  conso.run(9, 42, "agent", "claude-code", "claude-opus", 10, 10, 1, 5)
  conso.run(9, null, "analyste", "claude-code", "claude-opus", 10, 10, 2, 7)
  return db
}

test("proprietesJournal : la tâche, son produit et sa consommation cumulée, rien d'autre", () => {
  const p = proprietesJournal(base(), { projet: 9, tache: 41, type: "fusion" })
  assert.deepEqual(p, { type: "fusion", projet: 9, tache: 41, produit: "acte-clair", statut_projet: "fabrication", tache_cle: "L2-T3", lot: 2, statut_tache: "verification", tentative: 1, portee: "tache", appels: 2, duree_modeles_s: 91.2, cout_api_usd: 0.1235, jetons: 1800 })
})

test("proprietesJournal : sans tâche, le cumul du projet ; sans rien, le type seul", () => {
  const db = base()
  const p = proprietesJournal(db, { projet: 9, type: "plan" })
  assert.equal(p.portee, "projet")
  assert.equal(p.appels, 4)
  assert.equal(p.cout_api_usd, 3.1235)
  assert.deepEqual(proprietesJournal(db, { type: "cycle" }), { type: "cycle", projet: null, tache: null })
  // Une base sans les tables de coûts : l'événement part avec ce qu'on a.
  assert.deepEqual(proprietesJournal(ouvrirDb(":memory:"), { projet: 1, tache: 2, type: "erreur" }), { type: "erreur", projet: 1, tache: 2 })
})

test("evenementJournal : un événement « journal » vers PostHog, jamais le texte du message", async () => {
  const appels = []
  const instance = creerObservabilite({ posthogJeton: "phc_jetondetestjetondetest1234", service: "usine-orchestrateur", signaler: () => {}, fetch: async (url, o) => (appels.push({ url, corps: o.body }), new Response(null, { status: 200 })) })
  const db = base()
  // noter() écrit le journal (et appelle evenementJournal avec l'instance de l'usine, muette sous test).
  noter(db, { projet: 9, tache: 41, type: "erreur", message: "échec : le client paul@exemple.fr a reçu « bonjour Paul »" })
  evenementJournal(db, { projet: 9, tache: 41, type: "erreur" }, instance)
  await instance.vider()
  assert.equal(appels.length, 1)
  assert.equal(appels[0].url, "https://eu.i.posthog.com/batch/")
  const [e] = JSON.parse(appels[0].corps).batch
  assert.equal(e.event, "journal")
  assert.equal(e.properties.type, "erreur")
  assert.equal(e.properties.produit, "acte-clair")
  for (const fuite of ["paul", "bonjour", "confidentiel", "Envoi"]) assert.ok(!appels[0].corps.includes(fuite), `« ${fuite} » est sorti`)
  // L'instance de l'usine ne part jamais sous node --test.
  assert.deepEqual(obs.actif, { sentry: false, posthog: false })
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM journal").get().n, 1)
})
