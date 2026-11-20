// Les volets repliables de la console (<details>) restent tels que la personne les a laissés : la
// console se redessine toutes les 5 s sur un projet (15 s ailleurs), et un volet sans mémoire se
// refermait sous ses yeux (« le chevron se referme », signalé le 19 nov. sur un projet repris).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("../console/console.js", import.meta.url), "utf8")
const ligne = (debut) => {
  const l = source.split("\n").find((x) => x.startsWith(debut))
  assert.ok(l, `${debut} introuvable dans console.js`)
  return l
}
// ouvert() telle qu'elle est dans console.js, avec un état d'essai.
const outils = new Function("etat", [ligne("const BRUT = "), ligne("const brut = "), ligne("const echapper = "), ligne("const ouvert = "), "return { ouvert, BRUT }"].join("\n"))
const attribut = (etat, ...args) => {
  const { ouvert, BRUT } = outils(etat)
  return ouvert(...args)[BRUT]
}

test("chaque volet repliable de la console garde son état au rafraîchissement", () => {
  // Les volets qui ont leur propre mémoire (un id suivi par l'écouteur « toggle », ou data-faits).
  const ids = [...source.matchAll(/if \(e\.target\.id === "([\w-]+)"\)/g)].map((m) => m[1])
  assert.ok(ids.includes("pilote-journal") && ids.includes("technique"))
  const sansMemoire = source.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /<details[\s>]/.test(l) && !l.trimStart().startsWith("//"))
    .filter(([, l]) => !/\$\{ouvert\(/.test(l) && !ids.some((id) => l.includes(`id="${id}"`)) && !l.includes("data-faits="))
  assert.deepEqual(sansMemoire.map(([n, l]) => `${n}: ${l.trim().slice(0, 90)}`), [], "un volet se refermerait à chaque rafraîchissement")
  // L'écouteur note le choix de la personne pour tous les volets marqués par ouvert().
  assert.match(source, /if \(e\.target\.dataset\?\.garde\) etat\.ouverts\.set\(e\.target\.dataset\.garde, e\.target\.open\)/)
  assert.match(source, /ouverts: new Map\(\)/)
})

test("ouvert() : fermé ou ouvert par défaut, puis le choix de la personne l'emporte", () => {
  const etat = { ouverts: new Map() }
  assert.equal(attribut(etat, "inventaire-7"), 'data-garde="inventaire-7"')
  assert.equal(attribut(etat, "inventaire-7", true), 'data-garde="inventaire-7" open', "ouvert d'office (un plan à valider)")
  etat.ouverts.set("inventaire-7", true)
  assert.equal(attribut(etat, "inventaire-7"), 'data-garde="inventaire-7" open', "ouvert à la main : il le reste")
  etat.ouverts.set("inventaire-7", false)
  assert.equal(attribut(etat, "inventaire-7", true), 'data-garde="inventaire-7"', "refermé à la main : il le reste, même ouvert d'office")
  assert.equal(attribut(etat, 'x"><script>'), 'data-garde="x&quot;&gt;&lt;script&gt;"', "la clé est échappée")
})

test("les volets d'un projet repris et d'un plan ont une clé par projet (et par lot)", () => {
  assert.match(source, /\$\{ouvert\(`inventaire-\$\{p\.id\}`, p\.statut === "plan_a_valider"\)\}/)
  assert.match(source, /\$\{ouvert\(`inventaire-technique-\$\{p\.id\}`\)\}/)
  assert.match(source, /\$\{ouvert\(`criteres-\$\{p\.id\}-\$\{i\}`\)\}/)
})
