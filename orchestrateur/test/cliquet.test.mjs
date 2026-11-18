// Le cliquet de non-régression : les tests que le vérificateur écrit ne rejoignent .usine/e2e/ que si
// l'usine lit ses marqueurs E2E_…, dont le nom contient un chiffre. Ce sont des corrigés : un test qui échoue
// ne se réécrit que si un critère l'explique, sinon le codeur rétablit le comportement ou une personne tranche.
// Leur rejeu est plafonné sans rien taire.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { marqueurs } from "../../commun/marqueurs.mjs"
import { ouvrirCouts } from "../src/couts.mjs"
import { ouvrirDb } from "../src/db.mjs"
import { NEUTRALISER } from "../src/profil.mjs"
import {
  contestesCliquet, criteresDesTachesSautees, ecrireSautes, lireSautes, minutesCliquet, porte, reecrituresAVerser, rejouerCliquet,
  testsRemplacesJustifies, trierTestsEcrits,
} from "../src/verification.mjs"

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

test("un test du cliquet qui échoue sans critère qui l'explique est une régression du codeur", () => {
  const m = { ...tout, E2E_ECHECS: "1", E2E_ECHECS_NOMS: " T5-1.cjs" }
  const r = porte({ marqueurs: m, verdict: verdict(), criteres: [CRITERE] })
  assert.equal(raisonsCliquet(r).length, 1)
  assert.match(r.join(), /régression : le test T5-1\.cjs du cliquet échoue/)
  assert.deepEqual(contestesCliquet({ verdict: verdict(), marqueurs: m, criteres: [CRITERE] }), [])
})

test("un test du cliquet réécrit avec le critère exact de la tâche passe la porte et sera versé", () => {
  const v = verdict({ tests_remplaces: [{ test: "T5-1.cjs", critere: `  ${CRITERE.toUpperCase()} `, raison: "la carte affiche maintenant la note" }] })
  const m = { ...tout, E2E_ECHECS: "1", E2E_ECHECS_NOMS: "T5-1.cjs", E2E_REMPLACES: "T5-1.cjs" }
  assert.deepEqual(porte({ marqueurs: m, verdict: v, criteres: [CRITERE] }), [])
  assert.deepEqual(contestesCliquet({ verdict: v, marqueurs: m, criteres: [CRITERE] }), [])
  const { remplaces, ecartes } = reecrituresAVerser({ verdict: v, marqueurs: m, criteres: [CRITERE] })
  assert.deepEqual(remplaces.map((x) => x.test), ["T5-1.cjs"])
  assert.deepEqual(ecartes, [])
})

test("une citation numérotée, avec apostrophes typographiques, point final et chemin, est reconnue", () => {
  const cite = `1. ${CRITERE.replaceAll("'", "’")}.`
  const j = testsRemplacesJustifies({ tests_remplaces: [{ test: ".usine/e2e/T5-1.cjs", critere: cite, raison: "ok" }] }, [`3) ${CRITERE}`])
  assert.deepEqual([...j.keys()], ["T5-1.cjs"])
})

test("une réécriture déclarée qui ne tient pas part chez une personne, pas chez le codeur", () => {
  const m = { ...tout, E2E_ECHECS: "1", E2E_ECHECS_NOMS: "T5-1.cjs" }
  const cas = [
    // Un critère cité qui n'est pas dans la tâche.
    [{ test: "T5-1.cjs", critere: "La carte est plus jolie", raison: "goût" }, { E2E_REMPLACES: "T5-1.cjs" }, /cite un critère qui n'est pas dans la tâche/],
    // La nouvelle version échoue elle-même sur l'application.
    [{ test: "T5-1.cjs", critere: CRITERE, raison: "changé exprès" }, { E2E_ECRITS_KO: "T5-1.cjs" }, /échoue elle-même/],
    // Aucun fichier réécrit.
    [{ test: "T5-1.cjs", critere: CRITERE, raison: "changé exprès" }, {}, /sans fournir le test réécrit/],
  ]
  for (const [declaration, extra, attendu] of cas) {
    const v = verdict({ tests_remplaces: [declaration] })
    const mm = { ...m, ...extra }
    assert.deepEqual(raisonsCliquet(porte({ marqueurs: mm, verdict: v, criteres: [CRITERE] })), [])
    const c = contestesCliquet({ verdict: v, marqueurs: mm, criteres: [CRITERE] })
    assert.equal(c.length, 1)
    assert.equal(c[0].critere, "Test du cliquet T5-1.cjs")
    assert.match(c[0].raison, attendu)
    assert.match(c[0].raison, /Faut-il garder l'ancien test/)
    assert.deepEqual(reecrituresAVerser({ verdict: v, marqueurs: mm, criteres: [CRITERE] }).remplaces, [])
  }
})

test("la réécriture d'un test qui passait n'est ni refusée ni versée, seulement écartée", () => {
  const v = verdict({ tests_remplaces: [{ test: "T2-3.cjs", critere: CRITERE, raison: "plus simple" }] })
  const m = { ...tout, E2E_REMPLACES: "T2-3.cjs" }
  assert.deepEqual(porte({ marqueurs: m, verdict: v, criteres: [CRITERE] }), [])
  assert.deepEqual(contestesCliquet({ verdict: v, marqueurs: m, criteres: [CRITERE] }), [])
  assert.deepEqual(reecrituresAVerser({ verdict: v, marqueurs: m, criteres: [CRITERE] }), { remplaces: [], ecartes: ["T2-3.cjs"] })
})

test("une régression déjà nommée par le vérificateur n'est pas dite deux fois", () => {
  const v = verdict({ regressions: ["T5-1.cjs : la note n'apparaît plus"] })
  const r = porte({ marqueurs: { ...tout, E2E_ECHECS: "1", E2E_ECHECS_NOMS: "T5-1.cjs" }, verdict: v, criteres: [CRITERE] })
  assert.equal(r.filter((x) => x.includes("T5-1.cjs")).length, 1)
})

test("un verdict mal formé ne fait pas planter la porte", () => {
  const v = { decision: "approuve", criteres: "tous", regressions: "T5-1.cjs cassé", problemes: "aucun", tests_remplaces: "T5-1.cjs" }
  const r = porte({ marqueurs: { ...tout, E2E_ECHECS: "1", E2E_ECHECS_NOMS: "T5-1.cjs" }, verdict: v, criteres: "pas une liste", design: { graves: "non" } })
  assert.match(r.join(), /régression : le test T5-1\.cjs/)
  assert.match(r.join(), /aucun critère/)
  assert.deepEqual(contestesCliquet({ verdict: v, marqueurs: { E2E_ECHECS_NOMS: "T5-1.cjs" }, criteres: "x" }), [])
})

test("des échecs du cliquet que l'usine ne sait pas nommer empêchent de conclure", () => {
  const r = porte({ marqueurs: { ...tout, E2E_ECHECS: "3", E2E_ECHECS_NOMS: "T5-1.cjs" }, verdict: verdict(), criteres: [CRITERE] })
  assert.match(r.join(), /2 test\(s\) du cliquet échouent sans que l'usine sache lesquels/)
})

test("seuls les noms de fichiers sûrs et les critères permis sont gardés", () => {
  const j = testsRemplacesJustifies({ tests_remplaces: [
    { test: "../../etc/passwd", critere: CRITERE },
    { test: "T5-1.cjs", critere: CRITERE, raison: "ok" },
    { test: "T5-2.cjs", critere: "autre chose" },
  ] }, [CRITERE])
  assert.deepEqual([...j.keys()], ["T5-1.cjs"])
  assert.equal(testsRemplacesJustifies(null, [CRITERE]).size, 0)
})

test("un test sauté peut être réécrit avec un critère d'une tâche fusionnée pendant qu'il l'était, et lui seul", () => {
  const AUTRE = "La liste des objets se trie par date de retour"
  const autres = { "T3-2.cjs": [AUTRE] }
  const v = verdict({ tests_remplaces: [{ test: "T3-2.cjs", critere: AUTRE, raison: "tri changé par T7" }, { test: "T3-3.cjs", critere: AUTRE, raison: "idem" }] })
  const j = testsRemplacesJustifies(v, [CRITERE], autres)
  assert.deepEqual([...j.keys()], ["T3-2.cjs"])
  const m = { ...tout, E2E_ECHECS: "2", E2E_ECHECS_NOMS: "T3-2.cjs T3-3.cjs", E2E_REMPLACES: "T3-2.cjs T3-3.cjs" }
  assert.deepEqual(raisonsCliquet(porte({ marqueurs: m, verdict: v, criteres: [CRITERE], autres })), [])
  assert.deepEqual(contestesCliquet({ verdict: v, marqueurs: m, criteres: [CRITERE], autres }).map((c) => c.critere), ["Test du cliquet T3-3.cjs"])
  assert.deepEqual(reecrituresAVerser({ verdict: v, marqueurs: m, criteres: [CRITERE], autres }).remplaces.map((x) => x.test), ["T3-2.cjs"])
})

test("les tests sautés sont gardés d'une vérification à l'autre, avec les tâches fusionnées entre-temps", () => {
  const db = ouvrirDb(":memory:")
  ouvrirCouts(db)
  const tache = (cle, criteres, statut) => Number(db.prepare("INSERT INTO taches (projet_id, cle, lot, titre, description, criteres, statut) VALUES (1, ?, 1, 't', 'd', ?, ?)").run(cle, JSON.stringify(criteres), statut).lastInsertRowid)
  const t7 = tache("T7", ["La liste se trie par date"], "fusionnee")
  const t8 = tache("T8", ["Un critère refusé"], "verification")
  const cle = "cliquet_sautes_1"
  assert.deepEqual(lireSautes(db, cle), {})
  ecrireSautes(db, cle, {}, ["T3-2.cjs", "T3-3.cjs"], t7)
  let s = lireSautes(db, cle)
  ecrireSautes(db, cle, s, ["T3-2.cjs"], t8) // T3-3 a tourné : il sort de la liste.
  ecrireSautes(db, cle, lireSautes(db, cle), ["T3-2.cjs"], t8) // la même tâche repasse : pas de doublon.
  s = lireSautes(db, cle)
  assert.deepEqual(s, { "T3-2.cjs": [t7, t8] })
  // Seule la tâche fusionnée apporte ses critères.
  assert.deepEqual(criteresDesTachesSautees(db, s), { "T3-2.cjs": ["La liste se trie par date"] })
  // Une valeur illisible ou forgée est ignorée.
  db.prepare("UPDATE reglages SET valeur = ? WHERE cle = ?").run('{"../x.cjs":[1],"T1-1.cjs":"non"}', cle)
  assert.deepEqual(lireSautes(db, cle), {})
  db.prepare("UPDATE reglages SET valeur = ? WHERE cle = ?").run("pas du json", cle)
  assert.deepEqual(lireSautes(db, cle), {})
})

// Le script de rejeu, lancé pour de vrai dans un dossier jetable.
function dossierJetable() {
  const d = mkdtempSync(join(tmpdir(), "cliquet-"))
  mkdirSync(join(d, ".usine", "e2e"), { recursive: true })
  writeFileSync(join(d, ".usine", "e2e", "T1-1.cjs"), "require('fs').appendFileSync('ordre.txt', 'T1-1\\n')\n")
  writeFileSync(join(d, ".usine", "e2e", "T1-2.cjs"), "require('fs').appendFileSync('ordre.txt', 'T1-2\\n'); console.log('la note manque'); process.exit(1)\n")
  return d
}
const lancer = (d, lignes) => marqueurs(execFileSync("bash", ["-c", lignes.join("\n")], { cwd: d, encoding: "utf8" }))
const sortiesDe = (d) => join(d, "sorties").replaceAll("\\", "/")
const avecDossier = (fn) => {
  const d = dossierJetable()
  try {
    fn(d)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
}

test("le rejeu nomme les tests qui échouent, après un second essai, et n'en saute aucun quand il a le temps", () => avecDossier((d) => {
  const m = lancer(d, rejouerCliquet({ minutes: 1, base: "http://localhost:1", sorties: sortiesDe(d) }))
  assert.equal(m.E2E_TOTAL, "2")
  assert.equal(m.E2E_ECHECS, "1")
  assert.equal(m.E2E_ECHECS_NOMS, "T1-2.cjs")
  assert.equal(m.E2E_SAUTES, "0")
  assert.equal(m.E2E_NOMS_INVALIDES, "0")
  // Le test qui échoue a été lancé deux fois avant d'être compté.
  assert.equal(readFileSync(join(d, "ordre.txt"), "utf8").split("\n").filter((l) => l === "T1-2").length, 2)
  assert.match(readFileSync(join(d, "sorties", "e2e-echecs.txt"), "utf8"), /== T1-2\.cjs[\s\S]*la note manque/)
}))

test("un test instable qui passe au second essai n'est pas compté comme un échec", () => avecDossier((d) => {
  writeFileSync(join(d, ".usine", "e2e", "T1-3.cjs"), "const fs = require('fs'); const n = fs.existsSync('compteur') ? Number(fs.readFileSync('compteur', 'utf8')) : 0; fs.writeFileSync('compteur', String(n + 1)); process.exit(n === 0 ? 1 : 0)\n")
  const m = lancer(d, rejouerCliquet({ minutes: 1, base: "http://localhost:1", sorties: sortiesDe(d) }))
  assert.equal(m.E2E_TOTAL, "3")
  assert.equal(m.E2E_ECHECS_NOMS, "T1-2.cjs")
}))

test("les tests sautés la fois précédente passent en premier", () => avecDossier((d) => {
  for (let i = 0; i < 3; i++) {
    rmSync(join(d, "ordre.txt"), { force: true })
    lancer(d, rejouerCliquet({ minutes: 1, base: "http://localhost:1", sorties: sortiesDe(d), prioritaires: ["T1-2.cjs", "absent.cjs", "../x.cjs"] }))
    assert.equal(readFileSync(join(d, "ordre.txt"), "utf8").split("\n")[0], "T1-2")
  }
}))

test("le plafond du rejeu : 15 min par défaut, entre 1 et 20", () => {
  assert.equal(minutesCliquet({}), 15)
  assert.equal(minutesCliquet({ autonomie: { minutes_cliquet: 30 } }), 20)
  assert.equal(minutesCliquet({ autonomie: { minutes_cliquet: 0.2 } }), 1)
  assert.equal(minutesCliquet({ autonomie: { minutes_cliquet: "abc" } }), 15)
})

test("au-delà du plafond, les tests restants sont comptés et nommés comme sautés, pas tus", () => avecDossier((d) => {
  const m = lancer(d, rejouerCliquet({ secondes: 0, base: "http://localhost:1", sorties: sortiesDe(d) }))
  assert.equal(m.E2E_TOTAL, "0")
  assert.equal(m.E2E_SAUTES, "2")
  assert.deepEqual(m.E2E_SAUTES_NOMS.split(" ").sort(), ["T1-1.cjs", "T1-2.cjs"])
  assert.equal(m.E2E_ECHECS_NOMS, "")
}))

test("un fichier au nom illisible n'est ni rejoué ni tu", () => avecDossier((d) => {
  writeFileSync(join(d, ".usine", "e2e", "T1 3.cjs"), "process.exit(1)\n")
  const m = lancer(d, rejouerCliquet({ minutes: 1, base: "http://localhost:1", sorties: sortiesDe(d) }))
  assert.equal(m.E2E_TOTAL, "2")
  assert.equal(m.E2E_NOMS_INVALIDES, "1")
}))

test("les tests écrits sont lancés puis triés : nouveaux, réécritures, et ceux qui échouent eux-mêmes", () => avecDossier((d) => {
  mkdirSync(join(d, "sorties", "e2e"), { recursive: true })
  writeFileSync(join(d, "sorties", "e2e", "T1-2.cjs"), "process.exit(0)\n")
  writeFileSync(join(d, "sorties", "e2e", "T9-1.cjs"), "process.exit(0)\n")
  writeFileSync(join(d, "sorties", "e2e", "T9-2.cjs"), "process.exit(1)\n")
  writeFileSync(join(d, "sorties", "e2e", "T9 3.cjs"), "process.exit(0)\n")
  const m = lancer(d, [trierTestsEcrits({ sorties: sortiesDe(d), base: "http://localhost:1" })])
  assert.equal(m.E2E_NOUVEAUX, "T9-1.cjs")
  assert.equal(m.E2E_REMPLACES, "T1-2.cjs")
  assert.equal(m.E2E_ECRITS_KO, "T9-2.cjs")
  assert.equal(m.E2E_ECRITS_INVALIDES, "1")
}))

test("une réécriture se reconnaît dans git, pas dans le clone modifiable", () => avecDossier((d) => {
  const git = (...a) => execFileSync("git", ["-c", "user.email=essai@exemple.test", "-c", "user.name=essai", "-c", "core.autocrlf=false", ...a], { cwd: d, encoding: "utf8" })
  git("init", "-q")
  git("add", ".usine/e2e/T1-1.cjs")
  git("commit", "-q", "-m", "base")
  // T1-2.cjs est dans le clone, mais pas sur la branche de base : un test écrit sous ce nom est nouveau.
  mkdirSync(join(d, "sorties", "e2e"), { recursive: true })
  writeFileSync(join(d, "sorties", "e2e", "T1-1.cjs"), "process.exit(0)\n")
  writeFileSync(join(d, "sorties", "e2e", "T1-2.cjs"), "process.exit(0)\n")
  const m = lancer(d, [trierTestsEcrits({ sorties: sortiesDe(d), base: "http://localhost:1", ref: "HEAD" })])
  assert.equal(m.E2E_REMPLACES, "T1-1.cjs")
  assert.equal(m.E2E_NOUVEAUX, "T1-2.cjs")
}))
