// Les versions publiées de l'usine et le canal de mise à jour.
import { test } from "node:test"
import assert from "node:assert/strict"
import { canal, derniereVersion } from "../versions.mjs"

test("la dernière version se compare nombre par nombre, pas comme du texte", () => {
  assert.equal(derniereVersion(["v1.2.0", "v1.10.0", "v1.9.3"]), "v1.10.0")
  assert.equal(derniereVersion(["v2.0.0", "v10.0.0"]), "v10.0.0")
})

test("seules les étiquettes vX.Y.Z sont des versions", () => {
  assert.equal(derniereVersion(["v3-essai", "test", "v1.0.0", "v1.1"]), "v1.0.0")
  assert.equal(derniereVersion([]), null)
})

test("un canal inconnu ou absent est le canal stable", () => {
  assert.equal(canal("main"), "main")
  assert.equal(canal(undefined), "stable")
  assert.equal(canal("nuit"), "stable")
})
