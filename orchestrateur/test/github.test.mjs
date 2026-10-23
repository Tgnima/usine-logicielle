// GitHub : la description d'un dépôt tient dans la limite, et un refus dit pourquoi.
import { test } from "node:test"
import assert from "node:assert/strict"
import { creerDepot, descriptionDepot } from "../src/github.mjs"

test("la description d'un dépôt ne dépasse jamais 350 caractères", () => {
  assert.equal(descriptionDepot("Court."), "Court.")
  assert.equal(descriptionDepot("  deux\nlignes  "), "deux lignes")
  // Le résumé réel du plan de Palier faisait 357 caractères.
  const long = "Un portefeuille de clients et une boîte de réception triée pour un indépendant, ".repeat(5)
  const d = descriptionDepot(long)
  assert.ok(d.length <= 350, `${d.length} caractères`)
  assert.ok(d.endsWith("…"))
  assert.doesNotMatch(d, /\s…$/)
  assert.equal(descriptionDepot("x".repeat(400)).length, 350)
})

test("création du dépôt : description coupée, et le détail d'un refus de GitHub est gardé", async () => {
  const corps = []
  globalThis.fetch = async (url, { method = "GET", body } = {}) => {
    const chemin = new URL(url).pathname
    const repondre = (status, json) => ({ ok: status < 400, status, json: async () => json })
    if (method === "GET" && chemin.startsWith("/repos/")) return repondre(404, {})
    if (method === "GET" && chemin === "/user") return repondre(200, { login: "essai" })
    corps.push(JSON.parse(body))
    return repondre(422, { message: "Repository creation failed.", errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }] })
  }
  const config = { github: { proprietaire: "essai" }, secrets: { github: "" } }
  await assert.rejects(creerDepot(config, "palier", "r".repeat(357)), /GitHub 422 POST \/user\/repos : Repository creation failed\. \(name already exists on this account\)/)
  assert.equal(corps[0].description.length, 350)
})
