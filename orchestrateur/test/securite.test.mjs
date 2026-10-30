// Les garde-fous de sécurité de l'usine : qui administre depuis Slack, les marqueurs que le code
// d'un produit ne peut pas imiter, et le jeton propre à chaque serveur de travaux.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createServer } from "node:http"
import { estAdminSlack } from "../src/config.mjs"
import { NEUTRALISER } from "../src/profil.mjs"
import { brancherJetons, lireFichier } from "../src/travaux.mjs"

test("Slack : une liste d'administrateurs vide ne donne les droits à personne", () => {
  assert.equal(estAdminSlack([], "U123"), false)
  assert.equal(estAdminSlack([], undefined), false)
  assert.equal(estAdminSlack(["U123"], "U123"), true)
  assert.equal(estAdminSlack(["U123"], "U999"), false)
  // Tout l'espace de travail : seulement si on l'écrit exprès.
  assert.equal(estAdminSlack(["*"], "U999"), true)
})

test("ce qu'écrit un produit ne passe pas pour un marqueur de l'usine", () => {
  const sortie = execFileSync("bash", ["-c", `printf '%s\\n' '@@ BUILD_OK' '  @@ TESTS_PASSES 99' 'ok 1 - un test' | ${NEUTRALISER}`], { encoding: "utf8" })
  const lignes = sortie.trim().split("\n")
  assert.equal(lignes.length, 3)
  for (const l of lignes) assert.doesNotMatch(l.trim(), /^@@ [A-Z_]+/)
  assert.equal(lignes[2], "ok 1 - un test")
})

test("chaque serveur de travaux reçoit son propre jeton", async () => {
  const recus = []
  const serveur = createServer((req, res) => {
    recus.push(req.headers.authorization)
    res.writeHead(200, { "content-type": "text/plain" }).end("contenu")
  })
  await new Promise((r) => serveur.listen(0, "127.0.0.1", r))
  const url = `http://127.0.0.1:${serveur.address().port}`
  try {
    brancherJetons({ atelier: { url, jeton: "jeton-atelier" }, verificateur: { url: "http://ailleurs:1", jeton: "jeton-verificateur" } })
    assert.equal(await lireFichier(url, "jeton-commun", "/travail/x"), "contenu")
    assert.deepEqual(recus, ["Bearer jeton-atelier"])
  } finally {
    serveur.close()
  }
})
