// La sécurité de base : en-têtes, erreurs sans détail technique, limitation. Fichier protégé.
import { test } from "node:test"
import assert from "node:assert/strict"
import express from "express"
import { entetes, gestionErreurs, limiter } from "../server/securite.js"

async function servir(app, essai) {
  const serveur = app.listen(0)
  try {
    return await essai(`http://127.0.0.1:${serveur.address().port}`)
  } finally {
    serveur.close()
  }
}

test("les en-têtes de sécurité sont posés", async () => {
  const app = express()
  app.use(entetes())
  app.get("/", (_req, res) => res.send("ok"))
  await servir(app, async (url) => {
    const r = await fetch(url)
    assert.match(r.headers.get("content-security-policy"), /default-src 'self'/)
    assert.equal(r.headers.get("x-content-type-options"), "nosniff")
    assert.equal(r.headers.get("x-frame-options"), "SAMEORIGIN")
  })
})

test("une panne ne montre aucun détail technique ; une erreur métier garde son message", async () => {
  const app = express()
  app.get("/panne", () => {
    throw new Error("SQLITE_ERROR: no such table secrete")
  })
  app.get("/metier", () => {
    throw Object.assign(new Error("Le nom est obligatoire."), { status: 400 })
  })
  app.use(gestionErreurs())
  await servir(app, async (url) => {
    const p = await fetch(`${url}/panne`)
    assert.equal(p.status, 500)
    assert.doesNotMatch(await p.text(), /SQLITE|secrete/)
    const m = await fetch(`${url}/metier`)
    assert.equal(m.status, 400)
    assert.equal((await m.json()).erreur, "Le nom est obligatoire.")
  })
})

test("au-delà de la limite, 429", async () => {
  const app = express()
  app.use(limiter({ max: 3 }))
  app.get("/", (_req, res) => res.send("ok"))
  await servir(app, async (url) => {
    const statuts = []
    for (let i = 0; i < 5; i++) statuts.push((await fetch(url)).status)
    assert.deepEqual(statuts, [200, 200, 200, 429, 429])
  })
})
