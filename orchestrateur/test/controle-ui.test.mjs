// Le contrôle automatique de l'interface : les règles du design system, lues sur les lignes
// ajoutées d'un diff, et le script envoyé à l'atelier qui les applique.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { SCRIPT_CONTROLE_UI, decrireDefautUi, defautsUi, lireDefautsUi } from "../src/controle-ui.mjs"

// Un diff unifié (-U0) qui ajoute ces lignes à un fichier.
const diff = (fichier, lignes, debut = 1) => `diff --git a/${fichier} b/${fichier}\n--- a/${fichier}\n+++ b/${fichier}\n@@ -0,0 +${debut},${lignes.length} @@\n${lignes.map((l) => `+${l}`).join("\n")}\n`

test("chaque règle relève sa faute, avec la ligne et la correction", () => {
  const d = defautsUi(diff("client/src/Contacts.jsx", [
    'const a = <div className="bg-primaire p-4">ok</div>',
    'const b = <div style={{ color: "#3b82f6" }}>x</div>',
    'const c = <p className="text-gray-500 hover:bg-blue-50">x</p>',
    'const e = <p className="p-[13px] text-[15px] bg-[#fafafa]">x</p>',
    'import { FaUser } from "react-icons/fa"',
  ], 10))
  assert.deepEqual(d.map((x) => [x.ligne, x.regle]), [[11, "couleur"], [12, "palette"], [13, "couleur"], [13, "arbitraire"], [14, "icones"]])
  assert.match(decrireDefautUi(d[0]), /^interface : client\/src\/Contacts\.jsx:11 : couleur écrite en dur \(`#3b82f6`\) → utilise un jeton du brief/)
})

test("ce qui est permis ne bloque pas : jetons, opacité, calc, ancres, commentaires, autres fichiers", () => {
  const permis = [
    'const a = <div className="bg-primary/10 text-muted-foreground border-border rounded-lg gap-6 text-sm">x</div>',
    'const b = <div className="max-h-[calc(100vh-2rem)] min-w-[var(--radix-select-trigger-width)] grid-cols-[1fr_auto]">x</div>',
    'const c = <a href="#contact">Contact</a>',
    "// une couleur #ff0000 citée en commentaire",
    'const d = <div style={{ background: "var(--color-primaire)" }} />',
    'import { Plus } from "lucide-react"',
    'const url = "https://exemple.fr/#abc123"',
  ]
  assert.deepEqual(defautsUi(diff("client/src/A.jsx", permis)), [])
  // Les jetons vivent dans la feuille de style, le serveur n'est pas une interface.
  assert.deepEqual(defautsUi(diff("client/src/styles.css", ["--color-primaire: #0f766e;"])), [])
  assert.deepEqual(defautsUi(diff("server/routes/x.js", ['const c = "#0f766e"'])), [])
})

test("seules les lignes ajoutées comptent, et la liste est bornée", () => {
  const avecRetrait = "+++ b/client/src/A.jsx\n@@ -3,1 +3,1 @@\n-const v = \"#ff0000\"\n+const v = \"ok\"\n"
  assert.deepEqual(defautsUi(avecRetrait), [])
  assert.equal(defautsUi(diff("client/src/A.jsx", Array.from({ length: 40 }, () => 'x = "#ff0000"'))).length, 15)
  assert.deepEqual(lireDefautsUi("pas du json"), [])
  assert.deepEqual(lireDefautsUi(undefined), [])
})

test("le script de l'atelier donne le même résultat que le module", () => {
  const dossier = mkdtempSync(join(tmpdir(), "controle-ui-"))
  const script = join(dossier, "controle-ui.cjs")
  writeFileSync(script, SCRIPT_CONTROLE_UI)
  const entree = diff("client/src/B.jsx", ['<p className="text-red-600 p-[7px]">x</p>', '<p className="text-danger">x</p>'])
  const sortie = execFileSync(process.execPath, [script], { input: entree, encoding: "utf8" })
  const m = /^@@ UI_DEFAUTS (.*)$/m.exec(sortie)
  assert.ok(m, sortie)
  assert.deepEqual(lireDefautsUi(m[1]), defautsUi(entree))
  assert.equal(lireDefautsUi(m[1]).length, 2)
})

test("les composants de la brique respectent eux-mêmes le contrôle", () => {
  const racine = join(import.meta.dirname, "..", "..", "briques")
  const fichiers = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? fichiers(join(d, f)) : [join(d, f)]))
  for (const brique of ["webapp", "site", "pwa"]) {
    const src = join(racine, brique, "client", "src")
    let tout = ""
    try {
      for (const f of fichiers(src)) tout += diff(relative(join(racine, brique), f).replaceAll("\\", "/"), readFileSync(f, "utf8").split("\n"))
    } catch {
      continue
    }
    assert.deepEqual(defautsUi(tout).map(decrireDefautUi), [], brique)
  }
})
