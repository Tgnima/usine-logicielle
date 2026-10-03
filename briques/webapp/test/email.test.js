// La barrière des destinataires : en situation réelle, seuls les contacts de test reçoivent.
import { test } from "node:test"
import assert from "node:assert/strict"
import { destinataireAutorise } from "../server/email.js"

test("sans liste, tout destinataire est autorisé", () => {
  assert.equal(destinataireAutorise("qui@importe.fr", ""), true)
})

test("une liste limite aux adresses et domaines cités", () => {
  const liste = "alice@exemple.fr, @test-equipe.fr"
  assert.equal(destinataireAutorise("Alice@Exemple.fr", liste), true)
  assert.equal(destinataireAutorise("bob@test-equipe.fr", liste), true)
  assert.equal(destinataireAutorise("bob@exemple.fr", liste), false)
  assert.equal(destinataireAutorise("x@autre-test-equipe.fr.evil.com", liste), false)
})
