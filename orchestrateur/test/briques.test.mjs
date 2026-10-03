// Les briques de départ : la liste de l'analyste concorde avec les dossiers, et
// l'assembleur produit un socle complet pour chacune.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BRIQUES, verifierPlan } from "../src/analyste.mjs"
import { assembler, briques } from "../../briques/assembler.mjs"

const dossier = () => mkdtempSync(join(tmpdir(), "brique-"))

test("chaque brique proposée par l'analyste existe, et inversement", () => {
  assert.deepEqual(Object.keys(BRIQUES).sort(), briques().map((b) => b.nom).sort())
})

test("le plan refuse une brique inconnue, accepte l'absence (webapp)", () => {
  const plan = { slug: "essai", nom: "Essai", lots: [{ taches: [{ cle: "T1", titre: "t", description: "d", criteres: ["c"] }] }] }
  assert.ok(verifierPlan({ ...plan, brique: "fusee" }).some((p) => p.includes("brique inconnue")))
  assert.ok(!verifierPlan({ ...plan, brique: "pwa" }).some((p) => p.includes("brique")))
  assert.ok(!verifierPlan(plan).some((p) => p.includes("brique")))
})

test("une surcouche part de sa base, retire, complète AGENTS.md et échappe le nom", () => {
  const cible = join(dossier(), "depot")
  const r = assembler("api", cible, { nomProduit: 'Le "Relais"', resume: "Un résumé", jetons: ":root{}" })
  assert.deepEqual(r.dependances, ["express", "nodemailer"])
  assert.ok(!existsSync(join(cible, "client")) && !existsSync(join(cible, "vite.config.js")))
  assert.ok(existsSync(join(cible, "server", "securite.js")), "les fichiers protégés de la base sont là")
  assert.ok(!existsSync(join(cible, "brique.json")) && !existsSync(join(cible, "AGENTS.brique.md")))
  assert.match(readFileSync(join(cible, "AGENTS.md"), "utf8"), /brique « API »/)
  assert.equal(JSON.parse(readFileSync(join(cible, "package.json"), "utf8")).scripts.build, "node --check server/index.js")
  assert.match(readFileSync(join(cible, "docs", "API.md"), "utf8"), /# API de Le "Relais"/)
})

test("le site et la PWA gardent l'interface, avec les jetons du brief", () => {
  for (const b of ["site", "pwa"]) {
    const cible = join(dossier(), "depot")
    assembler(b, cible, { nomProduit: "Atelier <Nord>", resume: "r", jetons: "/* jetons du brief */" })
    assert.match(readFileSync(join(cible, "client", "src", "styles.css"), "utf8"), /jetons du brief/)
    assert.match(readFileSync(join(cible, "client", "index.html"), "utf8"), /Atelier &lt;Nord&gt;/)
  }
  assert.throws(() => assembler("../etc", join(dossier(), "x")), /Brique inconnue/)
})
