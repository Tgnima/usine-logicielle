// Le cliquet de non-régression : les tests que le vérificateur écrit ne rejoignent .usine/e2e/ que si
// l'usine lit ses marqueurs E2E_…, dont le nom contient un chiffre. Ce sont des corrigés : un test qui échoue
// ne se réécrit que si un critère de la tâche l'explique, et leur rejeu est plafonné sans rien taire.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { marqueurs } from "../../commun/marqueurs.mjs"
import { NEUTRALISER } from "../src/profil.mjs"
import { porte, rejouerCliquet, testsRemplacesJustifies, trierTestsEcrits } from "../src/verification.mjs"

test("les marqueurs du cliquet, dont le nom contient un chiffre, sont lus", () => {
  const m = marqueurs(["@@ BUILD_OK", "@@ E2E_TOTAL 3", "@@ E2E_ECHECS 1", "@@ E2E_NOUVEAUX T76-4.cjs T76-5.cjs ", "@@ TESTS_PASSES 982"].join("\n"))
  assert.equal(m.BUILD_OK, "")
  assert.equal(m.E2E_TOTAL, "3")
  assert.equal(m.E2E_ECHECS, "1")
  assert.equal(m.E2E_NOUVEAUX, "T76-4.cjs T76-5.cjs")
  assert.equal(m.TESTS_PASSES, "982")
})

test("un produit ne peut pas imiter un marqueur du cliquet", () => {
  const sortie = execFileSync("bash", ["-c", `printf '%s\\n' '@@ E2E_NOUVEAUX faux.cjs' '  @@ E2E_TOTAL 0' 'ok 1 - un test' | ${NEUTRALISER}`], { encoding: "utf8" })
  assert.deepEqual(marqueurs(sortie), {})
})

test("une ligne qui n'a pas la forme d'un marqueur est ignorée", () => {
  assert.deepEqual(marqueurs("@@ minuscule 1\n@@E2E_COLLE\nok 1 - un test\n"), {})
})

// La porte, avec une vérification par ailleurs parfaite : seules les règles du cliquet peuvent refuser.
const tout = { INSTALL_OK: "", BUILD_OK: "", APP_STARTED: "", TESTS_PASSES: "12", TESTS_ECHECS: "0" }
const CRITERE = "Au retour, une note facultative de 200 caractères au plus s'affiche sur la carte de l'objet"
const verdict = (extra = {}) => ({ decision: "approuve", criteres: [{ critere: CRITERE, ok: true, preuve: "vu" }], ...extra })
const raisonsCliquet = (r) => r.filter((x) => /cliquet/.test(x))

test("un test du cliquet qui échoue sans critère qui l'explique est une régression", () => {
  const r = porte({ marqueurs: { ...tout, E2E_ECHECS_NOMS: " T5-1.cjs" }, verdict: verdict(), criteres: [CRITERE] })
  assert.equal(raisonsCliquet(r).length, 1)
  assert.match(r.join(), /régression : le test T5-1\.cjs du cliquet échoue/)
})

test("un test du cliquet réécrit avec le critère exact de la tâche passe la porte", () => {
  const v = verdict({ tests_remplaces: [{ test: "T5-1.cjs", critere: `  ${CRITERE.toUpperCase()} `, raison: "la carte affiche maintenant la note" }] })
  const r = porte({ marqueurs: { ...tout, E2E_ECHECS_NOMS: "T5-1.cjs", E2E_REMPLACES: "T5-1.cjs" }, verdict: v, criteres: [CRITERE] })
  assert.deepEqual(r, [])
})

test("un critère cité qui n'est pas dans la tâche ne justifie rien", () => {
  const v = verdict({ tests_remplaces: [{ test: "T5-1.cjs", critere: "La carte est plus jolie", raison: "goût" }] })
  const r = porte({ marqueurs: { ...tout, E2E_ECHECS_NOMS: "T5-1.cjs", E2E_REMPLACES: "T5-1.cjs" }, verdict: v, criteres: [CRITERE] })
  assert.match(r.join(), /régression : le test T5-1\.cjs/)
})

test("une réécriture déclarée sans fichier réécrit ne justifie rien", () => {
  const v = verdict({ tests_remplaces: [{ test: "T5-1.cjs", critere: CRITERE, raison: "changé exprès" }] })
  const r = porte({ marqueurs: { ...tout, E2E_ECHECS_NOMS: "T5-1.cjs" }, verdict: v, criteres: [CRITERE] })
  assert.match(r.join(), /régression : le test T5-1\.cjs/)
})

test("un test du cliquet qui passait ne se réécrit pas, même avec un critère", () => {
  const v = verdict({ tests_remplaces: [{ test: "T2-3.cjs", critere: CRITERE, raison: "plus simple" }] })
  const r = porte({ marqueurs: { ...tout, E2E_REMPLACES: "T2-3.cjs" }, verdict: v, criteres: [CRITERE] })
  assert.match(r.join(), /T2-3\.cjs du cliquet passait/)
})

test("une régression déjà nommée par le vérificateur n'est pas dite deux fois", () => {
  const v = verdict({ regressions: ["T5-1.cjs : la note n'apparaît plus"] })
  const r = porte({ marqueurs: { ...tout, E2E_ECHECS_NOMS: "T5-1.cjs" }, verdict: v, criteres: [CRITERE] })
  assert.equal(r.filter((x) => x.includes("T5-1.cjs")).length, 1)
})

test("seuls les noms de fichiers sûrs et les critères de la tâche sont gardés", () => {
  const j = testsRemplacesJustifies({ tests_remplaces: [
    { test: "../../etc/passwd", critere: CRITERE },
    { test: "T5-1.cjs", critere: CRITERE, raison: "ok" },
    { test: "T5-2.cjs", critere: "autre chose" },
  ] }, [CRITERE])
  assert.deepEqual([...j.keys()], ["T5-1.cjs"])
  assert.equal(testsRemplacesJustifies(null, [CRITERE]).size, 0)
})

// Le script de rejeu, lancé pour de vrai dans un dossier jetable.
function dossierJetable() {
  const d = mkdtempSync(join(tmpdir(), "cliquet-"))
  mkdirSync(join(d, ".usine", "e2e"), { recursive: true })
  writeFileSync(join(d, ".usine", "e2e", "T1-1.cjs"), "process.exit(0)\n")
  writeFileSync(join(d, ".usine", "e2e", "T1-2.cjs"), "console.log('la note manque'); process.exit(1)\n")
  return d
}
const lancer = (d, lignes) => marqueurs(execFileSync("bash", ["-c", lignes.join("\n")], { cwd: d, encoding: "utf8" }))

test("le rejeu nomme les tests qui échouent et n'en saute aucun quand il a le temps", () => {
  const d = dossierJetable()
  try {
    const m = lancer(d, rejouerCliquet({ minutes: 1, base: "http://localhost:1", sorties: join(d, "sorties").replaceAll("\\", "/") }))
    assert.equal(m.E2E_TOTAL, "2")
    assert.equal(m.E2E_ECHECS, "1")
    assert.equal(m.E2E_ECHECS_NOMS, "T1-2.cjs")
    assert.equal(m.E2E_SAUTES, "0")
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("au-delà du plafond, les tests restants sont comptés comme sautés, pas tus", () => {
  const d = dossierJetable()
  try {
    const m = lancer(d, rejouerCliquet({ secondes: 0, base: "http://localhost:1", sorties: join(d, "sorties").replaceAll("\\", "/") }))
    assert.equal(m.E2E_TOTAL, "0")
    assert.equal(m.E2E_SAUTES, "2")
    assert.equal(m.E2E_ECHECS_NOMS, "")
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test("les tests écrits sont triés : nouveaux d'un côté, réécritures du cliquet de l'autre", () => {
  const d = dossierJetable()
  const sorties = join(d, "sorties").replaceAll("\\", "/")
  try {
    mkdirSync(join(d, "sorties", "e2e"), { recursive: true })
    writeFileSync(join(d, "sorties", "e2e", "T1-2.cjs"), "process.exit(0)\n")
    writeFileSync(join(d, "sorties", "e2e", "T9-1.cjs"), "process.exit(0)\n")
    const m = lancer(d, [trierTestsEcrits({ sorties })])
    assert.equal(m.E2E_NOUVEAUX, "T9-1.cjs")
    assert.equal(m.E2E_REMPLACES, "T1-2.cjs")
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})
