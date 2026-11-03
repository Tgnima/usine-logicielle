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
    // Les dépôts de référence : l'un est visible (avec un README), l'autre non.
    if (u.pathname.startsWith("/repos/essai/invisible")) return repondre(404, {})
    if (u.pathname === "/repos/essai/la-ville") return repondre(200, { full_name: "essai/la-ville", description: "La Ville, un CRM gamifié", default_branch: "main" })
    if (u.pathname === "/repos/essai/la-ville/readme") return repondre(200, { content: Buffer.from("# La Ville\nChaque vente est un bâtiment.").toString("base64") })
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
  ins.run("en ligne", "en_production", "Carnet", "carnet", JSON.stringify(PLAN), "essai/carnet", 3, null) // 3
  ins.run("des questions", "questions", "Brouillon", "brouillon", null, null, 0, null) // 4
  // Les produits livrés : toutes leurs tâches sont fusionnées.
  const fini = base.prepare("INSERT INTO taches (projet_id, cle, lot, titre, description, criteres, depend_de, issue, statut) VALUES (?, ?, ?, 'x', 'd', '[]', '[]', ?, 'fusionnee')")
  for (const p of [2, 3]) ["T1", "T2", "T3", "T4", "T5"].forEach((c, i) => fini.run(p, c, [1, 1, 2, 2, 3][i], 200 + p * 10 + i))
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

test("un projet pas encore planifié ne se réoriente pas ; une direction trop courte non plus", () => {
  const r = pipeline.reorienterProjet(ctx, 4, { consigne: "on vise les artisans", par: "moi" })
  assert.equal(r.ok, false)
  assert.match(r.message, /pas encore validé/)
  assert.equal(pipeline.reorienterProjet(ctx, 1, { consigne: "court", par: "moi" }).ok, false)
})

test("un produit livré se réoriente : tous ses lots sont gardés, et il reste tel quel en attendant", async () => {
  assert.equal(m.partager(PLAN, taches(ctx.db, 2)).garde, 3)
  assert.deepEqual(m.partager(PLAN, taches(ctx.db, 2)).nonFaites, [])
  const r = pipeline.reorienterProjet(ctx, 2, { consigne: "On vise les artisans plutôt que les agences.", par: "moi" })
  assert.equal(r.ok, true)
  assert.equal(obtenir(ctx.db, "projets", 2).statut, "reorientation")
  assert.equal(m.lireReorientation(ctx.db, 2).statut_avant, "livre")
  assert.ok(messages.some((x) => typeof x === "string" && x.includes("Le produit livré reste tel quel ;")))
  await new Promise((ok) => setTimeout(ok, 50)) // l'analyste injoignable : rien ne bouge
  // Garder le produit : il redevient livré, avec son plan d'origine.
  const g = pipeline.abandonnerPlan(ctx, 2, "moi")
  assert.equal(g.ok, true)
  assert.match(g.message, /reste tel qu'il a été livré/)
  const p = obtenir(ctx.db, "projets", 2)
  assert.equal(p.statut, "livre")
  assert.deepEqual(JSON.parse(p.plan), PLAN)
})

test("un produit en ligne se réoriente et, gardé tel quel, reste en ligne", async () => {
  const r = pipeline.reorienterProjet(ctx, 3, { consigne: "Un carnet partagé entre amis, avec des listes.", par: "moi" })
  assert.equal(r.ok, true)
  assert.ok(messages.some((x) => typeof x === "string" && x.includes("reste tel quel et en ligne")))
  await new Promise((ok) => setTimeout(ok, 50))
  assert.equal(pipeline.abandonnerPlan(ctx, 3, "moi").ok, true)
  assert.equal(obtenir(ctx.db, "projets", 3).statut, "en_production")
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

test("valider la réorientation d'un produit livré : la suite s'ajoute après tous ses lots, sans relivrer l'ancien", async () => {
  const plan = m.fusionner(PLAN, PLAN.lots, { lots: [{ nom: "Pour les artisans", objectif: "viser les artisans", taches: [tache("T6", "Devis", ["T1"])] }] })
  ctx.db.prepare("INSERT INTO reglages (cle, valeur) VALUES ('reorientation_2', ?)").run(JSON.stringify({ consigne: "les artisans", par: "moi", statut_avant: "livre", plan_avant: JSON.stringify(PLAN), garde: 3 }))
  ctx.db.prepare("UPDATE projets SET statut = 'plan_a_valider', plan = ? WHERE id = 2").run(JSON.stringify(plan))
  const avant = messages.length
  assert.equal((await pipeline.validerPlan(ctx, 2, "moi")).ok, true)
  for (let i = 0; i < 50 && obtenir(ctx.db, "projets", 2).statut !== "fabrication"; i++) await new Promise((ok) => setTimeout(ok, 20))
  const p = obtenir(ctx.db, "projets", 2)
  assert.equal(p.statut, "fabrication")
  assert.equal(p.lot_livre, 3)
  const t = Object.fromEntries(taches(ctx.db, 2).map((x) => [x.cle, x]))
  assert.equal(t.T6.lot, 4)
  assert.equal(t.T6.statut, "attente")
  assert.ok(["T1", "T2", "T3", "T4", "T5"].every((c) => t[c].statut === "fusionnee"))
  assert.ok(!messages.slice(avant).some((x) => typeof x === "string" && x.includes("Lot 3 terminé")), "le lot 3 n'est pas relivré")
})

test("la commande Slack : persona et dépôt de référence facultatifs, adresse avec « : » comprise", () => {
  assert.deepEqual(m.lireCommandeReorienter("reorienter 9 : on vise les artisans"), { projet: 9, persona: null, depot: null, consigne: "on vise les artisans" })
  assert.deepEqual(m.lireCommandeReorienter("reorienter 9 depot https://github.com/o/r : la Ville : gamifiée"), { projet: 9, persona: null, depot: "https://github.com/o/r", consigne: "la Ville : gamifiée" })
  assert.deepEqual(m.lireCommandeReorienter("reorienter 9 persona Négociateur immo dépôt <https://github.com/o/r|o/r> : x"), { projet: 9, persona: "Négociateur immo", depot: "<https://github.com/o/r|o/r>", consigne: "x" })
  assert.equal(m.lireCommandeReorienter("reorienter neuf : x"), null)
})

test("un dépôt de référence à l'adresse illisible est refusé, sans rien changer", () => {
  const r = pipeline.reorienterProjet(ctx, 3, { consigne: "Un carnet partagé entre amis.", depot: "pas une adresse !", par: "moi" })
  assert.equal(r.ok, false)
  assert.match(r.message, /illisible/)
  assert.equal(obtenir(ctx.db, "projets", 3).statut, "en_production")
})

test("le dépôt de référence est lu pour l'analyste : sa description et son README ; un dépôt invisible est refusé", async () => {
  const ref = await m.lireReference(ctx.config, "essai/la-ville")
  assert.equal(ref.nom, "essai/la-ville")
  assert.match(ref.texte, /La Ville, un CRM gamifié/)
  assert.match(ref.texte, /Chaque vente est un bâtiment/)
  await assert.rejects(m.lireReference(ctx.config, "essai/invisible"), /introuvable, ou privé et invisible/)
})

test("réorienter avec un dépôt de référence : il est gardé, annoncé, et un dépôt invisible arrête la préparation", async () => {
  const r = pipeline.reorienterProjet(ctx, 3, { consigne: "Un carnet partagé entre amis.", depot: "https://github.com/essai/invisible", par: "moi" })
  assert.equal(r.ok, true)
  assert.equal(m.lireReorientation(ctx.db, 3).depot, "essai/invisible")
  assert.ok(messages.some((x) => typeof x === "string" && x.includes("Dépôt de référence : https://github.com/essai/invisible")))
  await new Promise((ok) => setTimeout(ok, 50))
  assert.equal(obtenir(ctx.db, "projets", 3).statut, "reorientation")
  assert.ok(messages.some((x) => typeof x === "string" && x.includes("dépôt de référence essai/invisible est introuvable")))
  assert.equal(pipeline.abandonnerPlan(ctx, 3, "moi").ok, true)
  assert.equal(obtenir(ctx.db, "projets", 3).statut, "en_production")
})
