// Réorienter un projet en cours : ce qui est fabriqué est gardé, la suite est refaite et validée.
import { test, before } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

let ctx, m, pipeline, escalade, obtenir, taches
const appels = []
const messages = []
let issue = 100

const tache = (cle, titre, depend_de = []) => ({ cle, titre, description: `${titre}, précisément`, criteres: [`la page ${titre} répond`], depend_de })
const PLAN = {
  nom: "Agenda", slug: "agenda", resume: "Un agenda pour les agences.", brique: "webapp",
  lots: [
    { nom: "Socle", objectif: "voir ses rendez-vous", taches: [tache("T1", "Liste"), tache("T2", "Fiche", ["T1"])] },
    { nom: "Facturation", objectif: "facturer", taches: [tache("T3", "Factures", ["T2"]), tache("T4", "Relances", ["T3"])] },
    { nom: "Export", objectif: "exporter", taches: [tache("T5", "PDF", ["T3"])] },
  ],
}

before(async () => {
  // GitHub accepte tout ; l'atelier (l'analyste) n'est pas joignable.
  globalThis.fetch = async (url, { method = "GET" } = {}) => {
    const u = new URL(url)
    appels.push(`${method} ${u.pathname}`)
    const repondre = (status, json) => ({ ok: status < 400, status, json: async () => json })
    if (u.hostname === "127.0.0.1") return repondre(503, {})
    if (method === "GET" && u.pathname.includes("/contents/")) return repondre(404, {})
    if (method === "POST" && u.pathname.endsWith("/issues")) return repondre(201, { number: ++issue })
    return repondre(200, {})
  }
  const db = await import("../src/db.mjs")
  ;({ obtenir, taches } = db)
  m = await import("../src/reorientation.mjs")
  pipeline = await import("../src/pipeline.mjs")
  escalade = await import("../src/escalade.mjs")
  const dossier = mkdtempSync(join(tmpdir(), "reorientation-"))
  const base = db.ouvrirDb(join(dossier, "usine.db"))
  ;(await import("../src/couts.mjs")).ouvrirCouts(base)
  const noter = async (_p, texte) => messages.push(texte)
  ctx = {
    db: base,
    config: { dataDir: dossier, etatDir: dossier, github: { proprietaire: "essai" }, secrets: { github: "", worker: "x" }, atelier: { url: "http://127.0.0.1:1" }, domaine: { base: "exemple.test", https: true }, modeles: { analyste: { modele: "m" } }, autonomie: {} },
    notifier: { etape: noter, questions: noter, plan: async (_p, plan) => messages.push(plan), alerte: noter, progres: noter, escalade: async () => null, escaladeResolue: noter },
  }
  const ins = base.prepare("INSERT INTO projets (prompt, statut, nom, slug, plan, depot, lot_livre, debut_fabrication) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
  ins.run("un agenda", "fabrication", "Agenda", "agenda", JSON.stringify(PLAN), "essai/agenda", 1, "2026-10-20T10:00:00Z") // 1
  ins.run("livré", "livre", "Vitrine", "vitrine", JSON.stringify(PLAN), "essai/vitrine", 3, null) // 2
  const t = base.prepare("INSERT INTO taches (projet_id, cle, lot, titre, description, criteres, depend_de, issue, statut) VALUES (1, ?, ?, ?, 'd', '[]', '[]', ?, ?)")
  t.run("T1", 1, "Liste", 1, "fusionnee")
  t.run("T2", 1, "Fiche", 2, "fusionnee")
  t.run("T3", 2, "Factures", 3, "fusionnee")
  t.run("T4", 2, "Relances", 4, "bloquee")
  t.run("T5", 3, "PDF", 5, "attente")
  base.prepare("INSERT INTO escalades (projet_id, tache_id, issue, raison, options) VALUES (1, 4, 50, 'criteres', ?)").run(JSON.stringify(escalade.options("criteres", false)))
})

test("partager : on garde jusqu'au dernier lot qui a du code fusionné, tel quel", () => {
  const r = m.partager(PLAN, taches(ctx.db, 1))
  assert.equal(r.garde, 2)
  assert.deepEqual(r.gardes.map((l) => l.nom), ["Socle", "Facturation"])
  assert.deepEqual(r.nonFaites.map((t) => t.cle), ["T4", "T5"])
  assert.equal(r.derniere, 5)
})

test("fusionner : nom, slug et brique ne bougent pas ; la suite et le cap changent", () => {
  const nouveau = m.fusionner(PLAN, PLAN.lots.slice(0, 2), { resume: "Un agenda pour les artisans.", nom: "Autre", slug: "autre", lots: [{ nom: "Agenda partagé", objectif: "o", taches: [tache("T6", "Partage", ["T1"])] }] })
  assert.equal(nouveau.nom, "Agenda")
  assert.equal(nouveau.slug, "agenda")
  assert.equal(nouveau.resume, "Un agenda pour les artisans.")
  assert.deepEqual(nouveau.lots.map((l) => l.nom), ["Socle", "Facturation", "Agenda partagé"])
})

test("seule une fabrication en cours se réoriente", () => {
  const r = pipeline.reorienterProjet(ctx, 2, { consigne: "on vise les artisans", par: "moi" })
  assert.equal(r.ok, false)
  assert.match(r.message, /livré/)
  assert.equal(pipeline.reorienterProjet(ctx, 1, { consigne: "court", par: "moi" }).ok, false)
})

test("réorienter : la fabrication s'arrête, les demandes en file partent avec, les décisions attendent", async () => {
  const { mettreEnFile } = await import("../src/livraison.mjs")
  mettreEnFile(ctx.db, 1, "et un mode sombre", "moi")
  const r = pipeline.reorienterProjet(ctx, 1, { consigne: "On vise les artisans : plus de facturation, un agenda partagé.", par: "moi" })
  assert.equal(r.ok, true)
  assert.equal(obtenir(ctx.db, "projets", 1).statut, "reorientation")
  assert.match(m.lireReorientation(ctx.db, 1).consigne, /mode sombre/)
  assert.equal(pipeline.reorienterProjet(ctx, 1, { consigne: "encore une autre direction", par: "moi" }).ok, false)
  // L'analyste injoignable : la réorientation reste en pause, rien n'est perdu.
  await new Promise((ok) => setTimeout(ok, 50))
  assert.equal(obtenir(ctx.db, "projets", 1).statut, "reorientation")
  assert.ok(messages.some((x) => typeof x === "string" && x.includes("n'a pas pu refaire le plan")))
  // Une décision attendue ne se prend pas pendant la réorientation.
  const res = await escalade.resoudre(ctx, 1, { choix: "A", par: "moi" })
  assert.equal(res.ok, false)
})

test("garder l'ancien plan : tout redevient comme avant", () => {
  const r = pipeline.abandonnerPlan(ctx, 1, "moi")
  assert.equal(r.ok, true)
  const p = obtenir(ctx.db, "projets", 1)
  assert.equal(p.statut, "fabrication")
  assert.deepEqual(JSON.parse(p.plan), PLAN)
  assert.equal(m.lireReorientation(ctx.db, 1), null)
})

test("valider la réorientation : non faites abandonnées, nouvelles tâches ouvertes, la fabrication reprend", async () => {
  // L'état après le passage de l'analyste : la proposition est le plan du projet, à valider.
  const plan = m.fusionner(PLAN, PLAN.lots.slice(0, 2), { lots: [{ nom: "Agenda partagé", objectif: "partager", taches: [tache("T6", "Partage", ["T1"]), tache("T7", "Invitations", ["T6"])] }] })
  ctx.db.prepare("INSERT INTO reglages (cle, valeur) VALUES ('reorientation_1', ?)").run(JSON.stringify({ consigne: "les artisans", par: "moi", statut_avant: "fabrication", plan_avant: JSON.stringify(PLAN), garde: 2 }))
  ctx.db.prepare("UPDATE projets SET statut = 'plan_a_valider', plan = ?, lot_livre = 2 WHERE id = 1").run(JSON.stringify(plan))
  const r = await pipeline.validerPlan(ctx, 1, "moi")
  assert.equal(r.ok, true)
  for (let i = 0; i < 50 && obtenir(ctx.db, "projets", 1).statut !== "fabrication"; i++) await new Promise((ok) => setTimeout(ok, 20))
  const p = obtenir(ctx.db, "projets", 1)
  assert.equal(p.statut, "fabrication")
  assert.notEqual(p.debut_fabrication, "2026-10-20T10:00:00Z")
  const t = Object.fromEntries(taches(ctx.db, 1).map((x) => [x.cle, x]))
  assert.equal(t.T3.statut, "fusionnee")
  assert.equal(t.T4.statut, "abandonnee")
  assert.equal(t.T5.statut, "abandonnee")
  assert.equal(t.T6.lot, 3)
  assert.equal(t.T7.statut, "attente")
  assert.equal(ctx.db.prepare("SELECT statut FROM escalades WHERE id = 1").get().statut, "resolue")
  assert.equal(m.lireReorientation(ctx.db, 1), null)
  // Les agents liront la nouvelle direction ; le dépôt reçoit le nouveau plan et la mission.
  assert.ok(ctx.db.prepare("SELECT 1 FROM decisions WHERE projet_id = 1 AND question = 'Réorientation (nouvelle direction)'").get())
  assert.ok(appels.includes("PUT /repos/essai/agenda/contents/docs/PLAN.md"))
  assert.ok(appels.includes("PUT /repos/essai/agenda/contents/MISSION.md"))
})
