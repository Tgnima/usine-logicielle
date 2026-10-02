// Le test socle : l'application démarre et répond à son contrôle de santé.
// Fichier protégé : l'usine le restaure s'il est modifié.
import { test } from "node:test"
import assert from "node:assert/strict"
import { dbDeTest } from "../server/db.js"
import { creerApp } from "../server/index.js"

test("le contrôle de santé répond ok", async () => {
  dbDeTest()
  const serveur = creerApp().listen(0)
  try {
    const { port } = serveur.address()
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { ok: true })
  } finally {
    serveur.close()
  }
})
