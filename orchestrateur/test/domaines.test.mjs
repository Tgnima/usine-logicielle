// Les domaines personnalisés : adresses acceptées, refus, instructions DNS, règles d'ajout.
import { test } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { ajouterDomaine, hoteValide, instructionsDns, listerDomaines, ouvrirDomaines } from "../src/domaines.mjs"

test("une adresse est nettoyée (lien Slack, https, majuscules) puis validée", () => {
  assert.deepEqual(hoteValide("<http://App.Client.fr|App.Client.fr>", "usine.test"), { ok: true, hote: "app.client.fr" })
  assert.deepEqual(hoteValide("https://app.client.fr/", "usine.test"), { ok: true, hote: "app.client.fr" })
  assert.equal(hoteValide("pas un domaine", "usine.test").ok, false)
  assert.equal(hoteValide("prospecta.usine.test", "usine.test").ok, false)
  assert.equal(hoteValide("usine.test", "usine.test").ok, false)
})

test("les instructions DNS donnent le bon nom et l'adresse IP", () => {
  assert.match(instructionsDns("app.client.fr", ["45.93.21.17"]), /nom \*app\*.*45\.93\.21\.17/s)
  assert.match(instructionsDns("client.fr", ["45.93.21.17"]), /nom \*@\*/)
})

test("un domaine se demande seulement pour un produit en production, une fois", async () => {
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE projets (id INTEGER PRIMARY KEY, nom TEXT, slug TEXT, statut TEXT); CREATE TABLE journal (projet_id INTEGER, tache_id INTEGER, type TEXT, message TEXT)")
  db.exec("INSERT INTO projets VALUES (1, 'Prospecta', 'prospecta', 'en_production'), (2, 'Brouillon', 'brouillon', 'fabrication')")
  ouvrirDomaines(db)
  process.env.IP_PUBLIQUE = "45.93.21.17"
  const messages = []
  const ctx = { db, config: { domaine: { base: "usine.test" } }, notifier: { etape: async (_p, t) => messages.push(t) } }
  assert.equal((await ajouterDomaine(ctx, 2, "app.client.fr", "test")).ok, false)
  const r = await ajouterDomaine(ctx, 1, "app.client.fr", "test")
  assert.ok(r.ok, r.message)
  assert.match(messages[0], /45\.93\.21\.17/)
  assert.equal((await ajouterDomaine(ctx, 1, "APP.client.fr", "test")).ok, false)
  assert.match(listerDomaines(db, 1)[0], /app\.client\.fr.*attente du DNS/)
})

test("deux décisions ouvertes : une réponse sans précision est mise en attente, une réponse précise va à la bonne", async () => {
  const { choisirEscalade } = await import("../src/conversation.mjs")
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE taches (id INTEGER PRIMARY KEY, cle TEXT); CREATE TABLE escalades (id INTEGER PRIMARY KEY, projet_id INTEGER, tache_id INTEGER, raison TEXT, options TEXT, statut TEXT)")
  db.exec("INSERT INTO taches VALUES (32, 'T30'); INSERT INTO escalades VALUES (4, 2, 32, 'criteres', '[]', 'ouverte'), (5, 2, NULL, 'budget', '[]', 'ouverte')")
  assert.match(choisirEscalade(db, 2, "A mets la revue ailleurs").ambigu, /T30 A/)
  const t = choisirEscalade(db, 2, "T30 A mets la revue dans docs/REVUE.md")
  assert.equal(t.escalade.id, 4)
  assert.equal(t.texte, "A mets la revue dans docs/REVUE.md")
  assert.equal(choisirEscalade(db, 2, "budget A").escalade.id, 5)
  db.exec("UPDATE escalades SET statut = 'resolue' WHERE id = 5")
  assert.equal(choisirEscalade(db, 2, "A").escalade.id, 4)
})
