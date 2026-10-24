// La fabrique sert les projets à tour de rôle : le plus petit numéro ne passe pas toujours devant.
import { test } from "node:test"
import assert from "node:assert/strict"
import { aTourDeRole } from "../src/fabrique.mjs"

const ids = (l) => l.map((p) => p.id)

test("on repart du projet qui suit le dernier servi, puis on reboucle", () => {
  const projets = [{ id: 6 }, { id: 8 }, { id: 9 }, { id: 10 }]
  assert.deepEqual(ids(aTourDeRole(projets, 0)), [6, 8, 9, 10])
  assert.deepEqual(ids(aTourDeRole(projets, 6)), [8, 9, 10, 6])
  assert.deepEqual(ids(aTourDeRole(projets, 10)), [6, 8, 9, 10])
  // Le dernier servi a fini ou a disparu : on prend le suivant.
  assert.deepEqual(ids(aTourDeRole(projets, 7)), [8, 9, 10, 6])
})
