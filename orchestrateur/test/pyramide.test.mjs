// La pyramide de l'expérience : notes remises en ordre, étage atteint, gouffre, corrections.
import { test } from "node:test"
import assert from "node:assert/strict"
import { GOUFFRE, NIVEAUX, etageAtteint, normaliserPyramide, prochainEtage, pyramideEnCorrections, pyramideEnLignes, verdictPyramide } from "../src/pyramide.mjs"
import { ecartsEnCorrections, pointsACorriger } from "../src/recette.mjs"

const notes = (...n) => normaliserPyramide(NIVEAUX.map((x, i) => ({ cle: x.cle, note: n[i], observe: `vu ${x.cle}`, pour_monter: `monter ${x.cle}` })))

test("les notes sont remises dans l'ordre des étages et bornées", () => {
  const p = normaliserPyramide([{ cle: "sens", note: 3 }, { cle: "fonctionnel", note: 14 }, { cle: "fiable", note: "8" }])
  assert.equal(p.length, NIVEAUX.length)
  assert.equal(p[0].note, 10)
  assert.equal(p[1].note, 8)
  assert.equal(p[2].note, null)
  assert.equal(p[5].note, 3)
  assert.equal(normaliserPyramide([]), null)
  assert.equal(normaliserPyramide("rien"), null)
})

test("l'étage atteint s'arrête au premier trou, même si un étage plus haut est noté", () => {
  const p = notes(9, 8, 6, 9, 9, 9)
  assert.equal(etageAtteint(p), 1)
  assert.equal(prochainEtage(p).cle, "utilisable")
  assert.match(verdictPyramide(p), /Fiable \(sous le gouffre\).*Utilisable, monter utilisable/)
  assert.equal(etageAtteint(notes(5, 9, 9, 9, 9, 9)), -1)
})

test("le gouffre est franchi à partir de « Pratique »", () => {
  const p = notes(9, 9, 8, 7, 5, 4)
  assert.equal(etageAtteint(p), GOUFFRE)
  assert.match(verdictPyramide(p), /Pratique \(gouffre franchi\)/)
  assert.match(verdictPyramide(notes(9, 9, 9, 9, 9, 9)), /Toute la pyramide est tenue/)
})

test("les lignes vont du sommet à la base, avec le gouffre entre Pratique et Utilisable", () => {
  const l = pyramideEnLignes(notes(9, 9, 8, 7, 5, 4))
  assert.equal(l.length, NIVEAUX.length + 1)
  assert.match(l[0], /Qui a du sens/)
  assert.match(l[2], /\*.*Pratique\*/)
  assert.match(l[3], /gouffre/)
  assert.match(l[4], /Utilisable/)
})

test("les corrections partent du premier étage non tenu, trois au plus", () => {
  const texte = pyramideEnCorrections(notes(9, 6, 5, 4, 3, 2))
  assert.match(texte, /- Fiable \(6\/10\) : monter fiable/)
  assert.equal(texte.split("\n").filter((x) => x.startsWith("- ")).length, 3)
  assert.equal(pyramideEnCorrections(notes(9, 9, 9, 9, 9, 9)), "")
})

test("la recette envoie à l'analyste les écarts du persona puis la pyramide", () => {
  const recette = { persona: "Léa", scenarios: [{ titre: "Réserver", tenu: false, ecart: "le bouton est caché" }, { titre: "Payer", tenu: true }], pyramide: notes(9, 9, 9, 5, 4, 3) }
  const texte = ecartsEnCorrections(recette)
  assert.match(texte, /persona « Léa ».*\n- Réserver : le bouton est caché/)
  assert.match(texte, /pyramide.*\n- Pratique \(5\/10\)/)
  assert.equal(pointsACorriger(recette), 4)
  // Sans persona : seule la pyramide.
  assert.match(ecartsEnCorrections({ persona: null, scenarios: [], pyramide: notes(9, 9, 6, 5, 5, 5) }), /^La pyramide/)
  assert.equal(ecartsEnCorrections({ scenarios: [], pyramide: null }), "")
})
