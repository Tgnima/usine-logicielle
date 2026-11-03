// La mise à jour de l'usine lit son dépôt avec la connexion de la console d'abord.
import { test } from "node:test"
import assert from "node:assert/strict"
import { jetonsMiseAJour, origineJeton } from "../jetons.mjs"

test("la connexion de la console passe avant le jeton du serveur, puis sans jeton", () => {
  assert.deepEqual(jetonsMiseAJour({ console: "ghs_console", serveur: "ghp_serveur" }), ["ghs_console", "ghp_serveur", null])
})

test("sans connexion console : le jeton du serveur, puis sans jeton", () => {
  assert.deepEqual(jetonsMiseAJour({ console: null, serveur: "ghp_serveur" }), ["ghp_serveur", null])
})

test("sans jeton du serveur : la console, puis sans jeton", () => {
  assert.deepEqual(jetonsMiseAJour({ console: "ghs_console", serveur: "" }), ["ghs_console", null])
  assert.deepEqual(jetonsMiseAJour(), [null])
})

test("un même jeton n'est pas essayé deux fois", () => {
  assert.deepEqual(jetonsMiseAJour({ console: "ghp_x", serveur: "ghp_x" }), ["ghp_x", null])
})

test("le journal dit d'où vient le jeton, sans le montrer", () => {
  const j = { console: "ghs_console", serveur: "ghp_serveur" }
  assert.equal(origineJeton("ghs_console", j), "connexion GitHub de la console")
  assert.equal(origineJeton("ghp_serveur", j), "jeton du serveur")
  assert.equal(origineJeton(null, j), "sans jeton")
})
