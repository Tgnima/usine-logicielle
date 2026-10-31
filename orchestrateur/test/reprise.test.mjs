// Reprendre un dépôt existant, pour un persona : les règles codées (profil, mode, inventaire,
// personas, recette). Ce sont elles, pas les modèles, qui décident.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { COMPTER_TESTS, PROFIL_BRIQUE, brancheDeBase, brancheDeTache, compterTests, lireProfil, proteges, verifierProfil } from "../src/profil.mjs"
import { choisirMode, lireAdresseDepot, porteInventaire } from "../src/reprise.mjs"
import { creerPersona, icpEnMarkdown, missionEnMarkdown, modifierPersona, nettoyerFiche, trouverPersona, validerPersona, verifierPersona } from "../src/personas.mjs"
import { ecartsEnCorrections } from "../src/recette.mjs"
import { verifierPlan } from "../src/analyste.mjs"
import { ouvrirDb } from "../src/db.mjs"

test("compterTests : node --test, jest, vitest, mocha, pytest et unittest", () => {
  assert.deepEqual(compterTests("ℹ tests 3\nℹ pass 3\nℹ fail 0\n"), { passes: 3, echecs: 0, trouve: true })
  assert.deepEqual(compterTests("Tests:       1 failed, 12 passed, 13 total\n"), { passes: 12, echecs: 1, trouve: true })
  assert.deepEqual(compterTests(" Tests  9 passed (9)\n"), { passes: 9, echecs: 0, trouve: true })
  assert.deepEqual(compterTests("  12 passing (40ms)\n  2 failing\n"), { passes: 12, echecs: 2, trouve: true })
  assert.deepEqual(compterTests("===== 1 failed, 10 passed, 2 warnings in 0.52s =====\n"), { passes: 10, echecs: 1, trouve: true })
  assert.deepEqual(compterTests("\x1b[32m======== 4 passed in 0.1s ========\x1b[0m\n"), { passes: 4, echecs: 0, trouve: true })
  assert.deepEqual(compterTests("Ran 10 tests in 0.010s\n\nFAILED (failures=2, errors=1)\n"), { passes: 7, echecs: 3, trouve: true })
  assert.equal(compterTests("rien à voir").trouve, false)
})

test("COMPTER_TESTS : le même comptage, lancé dans un script", () => {
  const dossier = mkdtempSync(join(tmpdir(), "compter-"))
  const f = join(dossier, "t.log")
  execFileSync("node", ["-e", `require("fs").writeFileSync(${JSON.stringify(f)}, "  5 passing\\n  1 failing\\n")`])
  const sortie = execFileSync("bash", ["-c", `${COMPTER_TESTS} '${f.replace(/\\/g, "/")}'`]).toString()
  assert.match(sortie, /@@ TESTS_PASSES 5/)
  assert.match(sortie, /@@ TESTS_ECHECS 1/)
})

test("profil : la brique par défaut, celui d'un dépôt repris, et ses commandes vérifiées", () => {
  assert.deepEqual(lireProfil({}), PROFIL_BRIQUE)
  assert.equal(lireProfil({ profil: JSON.stringify({ pile: "python", tester: "pytest" }) }).tester, "pytest")
  assert.deepEqual(verifierProfil({ pile: "node", installer: "npm ci", construire: "true", tester: "npm test", demarrer: "npm start" }), [])
  assert.match(verifierProfil({ pile: "ruby", installer: "a", construire: "b", tester: "c", demarrer: "d" }).join(), /ruby/)
  assert.match(verifierProfil({ pile: "node", installer: "npm ci\nrm -rf /", construire: "b", tester: "c", demarrer: "d" }).join(), /installer/)
})

test("branches : main pour l'usine ; une branche d'intégration et des tâches rangées pour un dépôt repris", () => {
  assert.equal(brancheDeBase({}), "main")
  assert.equal(brancheDeTache({ slug: "relais" }, "T3"), "usine/t3")
  const repris = { slug: "seo-local", origine: "{}", branche: "usine/seo-local/integration" }
  assert.equal(brancheDeBase(repris), "usine/seo-local/integration")
  assert.equal(brancheDeTache(repris, "T3"), "usine/seo-local/t3")
})

test("fichiers protégés : MISSION.md et ICP.md partout ; un dépôt repris ne protège pas les fichiers d'une brique", () => {
  const config = { perimetre_protege: ["Dockerfile", "server/index.js", ".usine/**"] }
  const brique = proteges(config, {})
  assert.ok(brique.includes("server/index.js") && brique.includes("MISSION.md") && brique.includes("ICP.md"))
  const repris = proteges(config, { origine: "{}" })
  assert.ok(!repris.includes("server/index.js"))
  assert.ok(repris.includes("Dockerfile") && repris.includes("MISSION.md") && repris.includes(".usine/**"))
})

test("adresse d'un dépôt : les formes acceptées, et ce qui est refusé", () => {
  assert.deepEqual(lireAdresseDepot("https://github.com/Hava-star/seo-rea"), { depot: "Hava-star/seo-rea", branche: null })
  assert.deepEqual(lireAdresseDepot("github.com/o/r.git"), { depot: "o/r", branche: null })
  assert.deepEqual(lireAdresseDepot("o/r"), { depot: "o/r", branche: null })
  assert.deepEqual(lireAdresseDepot("<https://github.com/o/r/tree/feature/rea>"), { depot: "o/r", branche: "feature/rea" })
  assert.equal(lireAdresseDepot("https://gitlab.com/o/r"), null)
  assert.equal(lireAdresseDepot("o/r; rm -rf /"), null)
  assert.equal(lireAdresseDepot("../.."), null)
})

test("mode : direct seulement si l'usine peut écrire ; un direct impossible est expliqué, jamais forcé", () => {
  const ecrit = { nom: "o/r", pousser: true, archive: false }
  const lit = { nom: "o/r", pousser: false, archive: false }
  assert.deepEqual(choisirMode("auto", ecrit), { mode: "direct" })
  assert.deepEqual(choisirMode("auto", lit), { mode: "copie" })
  assert.deepEqual(choisirMode("copie", ecrit), { mode: "copie" })
  assert.match(choisirMode("direct", lit).erreur, /collaborateur/)
  assert.deepEqual(choisirMode("auto", { ...ecrit, archive: true }), { mode: "copie" })
})

test("porte de l'inventaire : des commandes éprouvées par le code, pas une déclaration", () => {
  const inv = { pile: "node", commandes: { installer: "npm ci", construire: "true", tester: "npm test", demarrer: "npm start" } }
  const tout = { INSTALL_OK: "", BUILD_OK: "", TESTS_PASSES: "3", TESTS_ECHECS: "0", DOCKERFILE_OK: "", APP_STARTED: "", ECRIT_DANS_CODE: "" }
  assert.deepEqual(porteInventaire(tout, inv), [])
  assert.match(porteInventaire(tout, null).join(), /absent/)
  assert.match(porteInventaire({ ...tout, TESTS_PASSES: "0" }, inv).join(), /aucun test/)
  const { APP_STARTED, ...sansApp } = tout
  assert.match(porteInventaire(sansApp, inv).join(), /api\/health/)
  const { DOCKERFILE_OK, ...sansDocker } = tout
  assert.match(porteInventaire(sansDocker, inv).join(), /Dockerfile/)
  assert.match(porteInventaire({ ...tout, ECRIT_DANS_CODE: "./db.sqlite" }, inv).join(), /DATA_DIR/)
  assert.match(porteInventaire(tout, { ...inv, pile: "php" }).join(), /php/)
})

test("plan d'un dépôt repris : pas de brique à choisir", () => {
  const plan = { nom: "SEO local", slug: "seo-local", brique: "inconnue", lots: [{ nom: "L1", objectif: "o", taches: [{ cle: "T1", titre: "t", description: "d", criteres: ["c"], depend_de: [] }] }] }
  assert.match(verifierPlan(plan).join(), /brique inconnue/)
  assert.ok(!verifierPlan(plan, { repris: true }).join().includes("brique"))
})

const fiche = {
  resume: "Gérant d'un commerce de quartier.",
  problemes: [{ probleme: "Invisible sur Google", preuve: "étude", source: "https://exemple.test/a" }, { probleme: "Pas le temps", source: "pas une adresse" }, { probleme: "Avis sans réponse" }],
  besoins: ["être trouvé", "répondre aux avis"],
  sources: [{ titre: "Étude", url: "https://exemple.test/a" }, { titre: "Forum", url: "https://exemple.test/b" }, { titre: "Fausse", url: "javascript:alert(1)" }],
}
const scenarios = [1, 2, 3].map((i) => ({ titre: `S${i}`, situation: "un matin", etapes: ["ouvre"], attendu: `voit ${i}` }))

test("persona : la fiche est nettoyée (adresses invalides écartées) et vérifiée avant validation", () => {
  const f = nettoyerFiche(fiche)
  assert.equal(f.sources.length, 2)
  assert.equal(f.problemes[1].source, "")
  assert.deepEqual(verifierPersona({ fiche: f, hors_perimetre: ["backlinks"], scenarios }), [])
  assert.match(verifierPersona({ fiche: f, hors_perimetre: [], scenarios }).join(), /hors périmètre/)
  assert.match(verifierPersona({ fiche: f, hors_perimetre: ["x"], scenarios: scenarios.slice(0, 2) }).join(), /de 3 à 5/)
  assert.match(verifierPersona({ fiche: { ...f, sources: [] }, hors_perimetre: ["x"], scenarios }).join(), /sources/)
})

test("ICP.md ne contient jamais les scénarios cachés ; MISSION.md porte le hors périmètre", () => {
  const persona = { nom: "Commerçant", fiche: nettoyerFiche(fiche), hors_perimetre: ["suivi des backlinks"], scenarios: [{ titre: "SECRET-SCENARIO", situation: "s", etapes: [], attendu: "ATTENDU-CACHE" }] }
  const icp = icpEnMarkdown(persona)
  assert.ok(!icp.includes("SECRET-SCENARIO") && !icp.includes("ATTENDU-CACHE"))
  assert.match(icp, /Invisible sur Google/)
  const mission = missionEnMarkdown({ nom: "SEO local", resume: "r", hors_perimetre: ["multi-pays"] }, { persona, repris: true, pile: "python" })
  assert.match(mission, /suivi des backlinks/)
  assert.match(mission, /multi-pays/)
  assert.match(mission, /pile python/)
  assert.ok(!mission.includes("SECRET-SCENARIO"))
})

test("persona : création, correction, validation, recherche par nom", async () => {
  const db = ouvrirDb(join(mkdtempSync(join(tmpdir(), "personas-")), "usine.db"))
  // L'atelier est injoignable : la recherche échoue en arrière-plan, sans gêner le reste.
  const ctx = { db, config: { atelier: { url: "http://127.0.0.1:1" }, secrets: { worker: "x" }, modeles: { analyste: { modele: "m" } }, dataDir: tmpdir() } }
  assert.equal((await creerPersona(ctx, { nom: "C", brief: "trop court" })).ok, false)
  const { ok, id } = await creerPersona(ctx, { nom: "Commerçant de quartier", brief: "Une boulangerie de quartier sans site web.", par: "a@b" })
  assert.ok(ok)
  // La recherche (atelier injoignable) peut déjà avoir échoué en arrière-plan : on la remet en cours.
  db.prepare("UPDATE personas SET statut = ?").run("recherche")
  assert.match(modifierPersona(ctx, id, { fiche }, "a@b").message, /recherche est en cours/)
  db.prepare("UPDATE personas SET statut = 'a_valider' WHERE id = ?").run(id)
  assert.ok(modifierPersona(ctx, id, { fiche, hors_perimetre: ["backlinks"], scenarios: scenarios.slice(0, 2) }, "a@b").ok)
  assert.match(validerPersona(ctx, id, "a@b").message, /de 3 à 5/)
  modifierPersona(ctx, id, { scenarios }, "a@b")
  assert.ok(validerPersona(ctx, id, "a@b").ok)
  assert.equal(trouverPersona(db, "commercant de").id, id)
  assert.equal(trouverPersona(db, String(id)).statut, "valide")
  // Une correction après validation : la fiche repasse « à valider ».
  modifierPersona(ctx, id, { nom: "Commerçant" }, "a@b")
  assert.equal(trouverPersona(db, "Commerçant").statut, "a_valider")
})

test("recette : les écarts deviennent une demande de corrections ; aucun écart, rien à corriger", () => {
  const r = { persona: "Commerçant", scenarios: [{ titre: "Voir sa place", tenu: true, observe: "ok" }, { titre: "Répondre à un avis", tenu: false, observe: "bouton absent", ecart: "aucun moyen de répondre" }] }
  const texte = ecartsEnCorrections(r)
  assert.match(texte, /1 écart/)
  assert.match(texte, /aucun moyen de répondre/)
  assert.ok(!texte.includes("Voir sa place"))
  assert.equal(ecartsEnCorrections({ ...r, scenarios: [r.scenarios[0]] }), "")
})

test("moteurs : Claude et Codex ne lisent jamais l'entrée standard du script (elle porte les lignes suivantes)", async () => {
  const { scriptClaude, scriptCodex } = await import("../src/moteurs.mjs")
  const db = ouvrirDb(join(mkdtempSync(join(tmpdir(), "moteurs-")), "usine.db"))
  const { ouvrirCouts } = await import("../src/couts.mjs")
  ouvrirCouts(db)
  const ctx = { db, config: {} }
  const claude = scriptClaude(ctx, { args: "-p x", modele: "m", sortie: "/tmp/s" })
  const codex = scriptCodex(ctx, { args: "x", journal: "/tmp/j" })
  for (const s of [claude, codex]) for (const ligne of s.split("\n").filter((l) => /(claude|codex exec) /.test(l) && /^\s*if /.test(l))) assert.match(ligne, /< '\/dev\/null'/)
  // Une consigne, même très longue, passe par un fichier sur l'entrée standard, jamais en argument
  // (au-delà de 128 Ko, Linux refuse : « Argument list too long »).
  const avecConsigne = scriptClaude(ctx, { args: "-p", modele: "m", sortie: "/tmp/s", entree: "/tmp/c.md" }) + scriptCodex(ctx, { args: "-", journal: "/tmp/j", entree: "/tmp/c.md" })
  assert.ok((avecConsigne.match(/< '\/tmp\/c\.md'/g)?.length ?? 0) >= 2)
  for (const f of ["analyste", "personas", "relectures", "fabrique", "reprise", "recette", "verification"]) assert.doesNotMatch(readFileSync(new URL(`../src/${f}.mjs`, import.meta.url), "utf8"), /\$\(cat [^)]*consigne/, f)
  // Le même mécanisme qu'en vrai : un script lu par bash sur son entrée standard, la ligne d'après doit s'exécuter.
  const sortie = execFileSync("bash", ["-s"], { input: "cat < /dev/null > /dev/null\necho LIGNE_SUIVANTE\n" }).toString()
  assert.match(sortie, /LIGNE_SUIVANTE/)
})
