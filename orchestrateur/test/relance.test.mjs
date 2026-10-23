// Relancer un projet en échec : là où il a échoué, sans refaire ce qui a été validé.
import { test, before } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let ctx, relancerProjet, obtenir
const appels = []

before(async () => {
  // Le GitHub d'hier soir (incident) : le dépôt n'existe pas, sa création est refusée (422).
  globalThis.fetch = async (url, { method = "GET" } = {}) => {
    const chemin = new URL(url).pathname
    appels.push(`${method} ${chemin}`)
    const repondre = (status, json) => ({ ok: status < 400, status, json: async () => json })
    if (method === "GET" && chemin.startsWith("/repos/")) return repondre(404, { message: "Not Found" })
    if (method === "GET" && chemin === "/user") return repondre(200, { login: "essai" })
    if (method === "POST" && chemin === "/user/repos") return repondre(422, { message: "Repository creation failed." })
    return repondre(404, {})
  }
  const { ouvrirDb } = await import("../src/db.mjs")
  ;({ relancerProjet } = await import("../src/pipeline.mjs"))
  ;({ obtenir } = await import("../src/db.mjs"))
  const dossier = mkdtempSync(join(tmpdir(), "relance-"))
  const db = ouvrirDb(join(dossier, "usine.db"))
  const silence = async () => {}
  ctx = {
    db,
    config: { dataDir: dossier, github: { proprietaire: "essai" }, secrets: { github: "", worker: "x" }, atelier: { url: "http://127.0.0.1:1" }, domaine: { base: "exemple.test", https: true }, modeles: { analyste: { modele: "m" } } },
    notifier: { etape: silence, questions: silence, plan: silence, alerte: silence, progres: silence },
  }
  const plan = { nom: "Palier", slug: "palier", resume: "r", lots: [{ nom: "Socle", objectif: "o", taches: [{ cle: "T1", titre: "Liste", description: "d", criteres: ["c"], depend_de: [] }] }] }
  const ins = db.prepare("INSERT INTO projets (prompt, statut, nom, slug, plan) VALUES (?, ?, ?, ?, ?)")
  ins.run("création échouée", "echec", "Palier", "palier", JSON.stringify(plan)) // 1
  db.prepare("INSERT INTO decisions (projet_id, question, reponse, par) VALUES (1, 'Plan de fabrication', 'validé', 'moi')").run()
  ins.run("en fabrication", "fabrication", "Vitrine", "vitrine", JSON.stringify(plan)) // 2
  db.prepare("INSERT INTO decisions (projet_id, question, reponse, par) VALUES (2, 'Plan de fabrication', 'validé', 'moi')").run()
  db.prepare("UPDATE projets SET debut_fabrication = '2026-10-22T10:00:00Z' WHERE id = 2").run()
})

test("création échouée : la relance refait la création avec le plan validé, sans repasser par l'analyste", async () => {
  const planAvant = obtenir(ctx.db, "projets", 1).plan
  const r = relancerProjet(ctx, 1, "moi")
  assert.equal(r.ok, true)
  assert.match(r.message, /Création relancée, avec le plan validé/)
  assert.equal(obtenir(ctx.db, "projets", 1).statut, "creation")
  // La création tourne en tâche de fond : GitHub refuse encore, le projet repasse en échec.
  for (let i = 0; i < 50 && obtenir(ctx.db, "projets", 1).statut === "creation"; i++) await new Promise((x) => setTimeout(x, 20))
  const p = obtenir(ctx.db, "projets", 1)
  assert.equal(p.statut, "echec")
  assert.equal(p.plan, planAvant)
  assert.ok(appels.includes("POST /user/repos"))
  const journal = ctx.db.prepare("SELECT type, message FROM journal WHERE projet_id = 1 ORDER BY id").all()
  assert.ok(journal.some((x) => x.type === "relance" && /plan validé/.test(x.message)))
  assert.ok(journal.some((x) => x.type === "erreur" && /GitHub 422/.test(x.message)))
  // Et on peut relancer encore.
  assert.equal(relancerProjet(ctx, 1, "moi").ok, true)
})

test("un projet en fabrication ne se relance pas", () => {
  const r = relancerProjet(ctx, 2, "moi")
  assert.equal(r.ok, false)
  assert.match(r.message, /rien à relancer/)
  assert.equal(obtenir(ctx.db, "projets", 2).statut, "fabrication")
})

test("un projet inconnu", () => {
  assert.equal(relancerProjet(ctx, 99, "moi").ok, false)
})
