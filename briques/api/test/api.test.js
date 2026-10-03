// L'API de départ : la documentation et l'appelant.
import { test } from "node:test"
import assert from "node:assert/strict"
import { creerApp } from "../server/index.js"

async function serveur() {
  const s = creerApp().listen(0)
  await new Promise((r) => s.once("listening", r))
  return { s, url: `http://127.0.0.1:${s.address().port}` }
}

test("la documentation est servie sur /api/docs", async () => {
  const { s, url } = await serveur()
  try {
    const r = await fetch(`${url}/api/docs`)
    assert.equal(r.status, 200)
    assert.match(await r.text(), /## Points d'accès/)
  } finally {
    s.close()
  }
})

test("/api/moi rend l'appelant transmis par l'usine", async () => {
  const { s, url } = await serveur()
  try {
    const r = await fetch(`${url}/api/moi`, { headers: { "x-usine-utilisateur": "cle:test" } })
    assert.deepEqual(await r.json(), { appelant: "cle:test" })
  } finally {
    s.close()
  }
})
