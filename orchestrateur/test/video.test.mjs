// La vidéo de présentation : les données viennent du projet, la page ne peut pas être détournée.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { donneesVideo, pageVideo, etatVideo } from "../src/video.mjs"

test("les données : fonctionnalités du plan (sans les lots de corrections), vraies captures, chiffres", () => {
  const dataDir = mkdtempSync(join(tmpdir(), "video-"))
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE projets (id INTEGER PRIMARY KEY, nom TEXT, slug TEXT, prompt TEXT, statut TEXT, plan TEXT, lot_livre INTEGER, plancher_tests INTEGER); CREATE TABLE taches (id INTEGER PRIMARY KEY, projet_id INTEGER, cle TEXT, lot INTEGER, statut TEXT); CREATE TABLE consommations (projet_id INTEGER, duree_s INTEGER); CREATE TABLE reglages (cle TEXT PRIMARY KEY, valeur TEXT)")
  const plan = { nom: "Prospecta", resume: "La prospection B2B.", design: { palette: { accent: "#4f46e5", fond: "pas une couleur" } },
    lots: [{ nom: "Socle", objectif: "o1", taches: [{ titre: "Contacts" }] }, { nom: "Campagnes", objectif: "o2", taches: [{ titre: "Envoi" }] }, { nom: "Corrections : retours", objectif: "x", taches: [] }] }
  db.prepare("INSERT INTO projets VALUES (2, 'Prospecta', 'prospecta', ?, 'en_production', ?, 3, 199)").run("Une app de prospection\n\n(Type de produit souhaité : Application web.)", JSON.stringify(plan))
  db.exec("INSERT INTO taches VALUES (1, 2, 'T1', 1, 'fusionnee'), (2, 2, 'T2', 2, 'fusionnee'), (3, 2, 'T3', 3, 'fusionnee'); INSERT INTO consommations VALUES (2, 7200)")
  mkdirSync(join(dataDir, "captures", "2", "T1"), { recursive: true })
  writeFileSync(join(dataDir, "captures", "2", "T1", "contacts-bureau.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const ctx = { db, config: { dataDir, domaine: { base: "exemple.test", https: true } } }
  const d = donneesVideo(ctx, 2)
  assert.deepEqual(d.lots.map((l) => l.nom), ["Socle", "Campagnes"])
  assert.match(d.lots[0].capture, /^data:image\/png;base64,/)
  assert.equal(d.lots[1].capture, null)
  assert.deepEqual(d.couleurs, { accent: "#4f46e5" })
  assert.equal(d.demande, "Une app de prospection")
  assert.deepEqual(d.chiffres, { lots: 3, taches: 3, tests: 199, duree: "2 h" })
  assert.equal(d.adresse, "https://prospecta.exemple.test")
  assert.equal(etatVideo(ctx, 2).etat, "aucune")
})

test("un texte piégé ne ferme pas la balise du script", () => {
  const h = pageVideo({ nom: "</script><script>alert(1)</script>", lots: [] })
  assert.ok(!h.includes("</script><script>alert(1)"))
  assert.match(h, /window\.DONNEES = /)
})
