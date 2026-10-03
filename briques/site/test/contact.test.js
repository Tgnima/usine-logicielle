// Le formulaire de contact : validation et enregistrement.
import { test } from "node:test"
import assert from "node:assert/strict"
import { dbDeTest } from "../server/db.js"
import { recevoirMessage } from "../server/actions/contact.js"

test("un message valide est enregistré", async () => {
  const base = dbDeTest()
  const { id } = await recevoirMessage({ nom: "Alice Martin", email: "alice@exemple.test", message: "Bonjour, je voudrais un devis." })
  assert.ok(id > 0)
  assert.equal(base.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 1)
})

test("un message invalide est refusé avec un motif clair", async () => {
  dbDeTest()
  await assert.rejects(recevoirMessage({ nom: "A", email: "x@y.z", message: "Bonjour à vous tous" }), /nom/)
  await assert.rejects(recevoirMessage({ nom: "Alice", email: "pas-une-adresse", message: "Bonjour à vous tous" }), /email/)
  await assert.rejects(recevoirMessage({ nom: "Alice", email: "a@b.fr", message: "court" }), /message/)
})
