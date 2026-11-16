// Le cliquet de non-régression : les tests que le vérificateur écrit ne rejoignent .usine/e2e/ que si
// l'usine lit ses marqueurs E2E_…, dont le nom contient un chiffre.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { marqueurs } from "../../commun/marqueurs.mjs"
import { NEUTRALISER } from "../src/profil.mjs"

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
