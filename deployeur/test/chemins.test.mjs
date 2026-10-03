// Les chemins publics déclarés par un produit : seuls des chemins précis passent.
import { test } from "node:test"
import assert from "node:assert/strict"
import { CHEMINS_PUBLICS, cheminsDeclares } from "../chemins.mjs"

test("les chemins de l'usine sont publics par défaut", () => {
  assert.ok(CHEMINS_PUBLICS.includes("/api/health"))
  assert.ok(CHEMINS_PUBLICS.includes("/api/public/*"))
})

test("des chemins précis sont acceptés", () => {
  assert.deepEqual(cheminsDeclares('{"chemins_publics": ["/api/t/*", "/merci", "/merci"]}'), { chemins: ["/api/t/*", "/merci"], refuses: [] })
})

test("une déclaration trop large ou piégée est refusée", () => {
  const r = cheminsDeclares('{"chemins_publics": ["/", "/*", "/api/*", "/_portier/connexion", "/x/../admin", "api/t", "/a*b", 42]}')
  assert.deepEqual(r.chemins, [])
  assert.equal(r.refuses.length, 8)
})

test("un fichier absent ou illisible ne déclare rien", () => {
  assert.deepEqual(cheminsDeclares(undefined), { chemins: [], refuses: [] })
  assert.deepEqual(cheminsDeclares("pas du json"), { chemins: [], refuses: [] })
})
