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

test("une tâche qui demande de modifier un fichier protégé est refusée, pas une qui le lit", async () => {
  const { tachesSurProteges } = await import("../src/analyste.mjs")
  const lot = (description) => [{ taches: [{ cle: "T30", titre: "Revue", description, criteres: ["…"] }] }]
  assert.equal(tachesSurProteges(lot("Documentation : ajouter à docs/DESIGN.md une section « Revue de finition »."), ["docs/DESIGN.md"]).length, 1)
  assert.equal(tachesSurProteges(lot("Passer chaque écran au crible de la grille de docs/DESIGN.md et corriger les écarts."), ["docs/DESIGN.md"]).length, 0)
  assert.equal(tachesSurProteges(lot("Écrire la revue dans docs/REVUE.md."), ["docs/DESIGN.md"]).length, 0)
  // Des lectures, pas des écritures (faux positifs rencontrés sur Prospecta).
  for (const lecture of ["Corriger les écrans comme décrit dans docs/DESIGN.md.", "Modifier les écrans selon la grille de docs/DESIGN.md.", "Respecter la section Couleurs de docs/DESIGN.md."]) assert.equal(tachesSurProteges(lot(lecture), ["docs/DESIGN.md"]).length, 0, lecture)
  for (const ecriture of ["Mettre à jour docs/DESIGN.md avec la revue.", "Rédiger dans docs/DESIGN.md le bilan.", "Le fichier docs/DESIGN.md est mis à jour."]) assert.equal(tachesSurProteges(lot(ecriture), ["docs/DESIGN.md"]).length, 1, ecriture)
})
