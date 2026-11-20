// La page « À propos » de la console (console.js, vueAPropos) : la version de l'usine en service,
// son canal et ses mises à jour, lus dans le bilan du déployeur (mise_a_jour).
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("../console/console.js", import.meta.url), "utf8")
const extraire = (debut) => {
  const i = source.indexOf(debut)
  assert.ok(i >= 0, `${debut} introuvable dans console.js`)
  return source.slice(i, source.indexOf("\n}\n", i) + 2)
}
const ligne = (debut) => {
  const l = source.split("\n").find((x) => x.startsWith(debut))
  assert.ok(l, `${debut} introuvable dans console.js`)
  return l
}
// vueAPropos telle qu'elle est dans console.js, avec ses outils, et un état d'essai.
const page = new Function("etat", [
  ligne("const BRUT = "), ligne("const brut = "), ligne("const echapper = "), ligne("const valeur = "), extraire("function html("), ligne("const ouvert = "),
  extraire("const aParis = "), ligne("const momentParis = "),
  ligne("const CANAUX = "), ligne("const VERSION_PUBLIEE = "), ligne("const lienDepot = "), extraire("function vueAPropos("),
  "return valeur(vueAPropos())",
].join("\n"))
const rendre = (mise_a_jour) => page({ resume: { usine: { mise_a_jour } }, ouverts: new Map() })
// Le texte que l'on lit à l'écran : sans balises, entités décodées.
const texte = (h) => h.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ")

test("à propos : une version publiée, à jour, avec ses notes de version", () => {
  const h = rendre({ version: "v1.2.0", canal: "stable", cible: "v1.2.0", disponible: 0, commits: [], verifie_le: "2026-11-19T07:00:00Z", erreur: null, depot: "Tgnima/usine-logicielle" })
  assert.match(texte(h), /Version en service v1\.2\.0 Une version publiée\./)
  assert.match(h, /href="https:\/\/github\.com\/Tgnima\/usine-logicielle\/releases\/tag\/v1\.2\.0"/)
  assert.match(h, /href="https:\/\/github\.com\/Tgnima\/usine-logicielle\/releases"/)
  assert.match(texte(h), /Canal les versions publiées/)
  assert.match(texte(h), /Mises à jour l'usine est à jour/)
  assert.doesNotMatch(h, /mettre-a-jour/, "pas de bouton quand il n'y a rien à appliquer")
  assert.doesNotMatch(texte(h), /(^| )0( |$)/, "aucun « 0 » égaré quand rien n'est disponible")
})

test("à propos : sur main, un commit n'est pas une version publiée ; les changements disponibles se listent", () => {
  const h = rendre({ version: "332f6e8", canal: "main", cible: "main", disponible: 17, commits: ["a1b2c3d Ajoute la page <À propos>", "e4f5a6b Corrige update.sh"], verifie_le: "2026-11-19T07:00:00Z", depot: "Tgnima/usine-logicielle" })
  assert.match(texte(h), /Une version de développement/)
  assert.match(h, /commit\/332f6e8/)
  assert.match(texte(h), /17 changements disponibles/)
  assert.match(texte(h), /Une nouvelle version est disponible L'usine/, "sur main, la cible n'est pas une version à nommer")
  assert.match(h, /data-quoi="mettre-a-jour"/)
  assert.match(h, /Ajoute la page &lt;À propos&gt;/, "les messages des commits sont échappés")
  assert.match(texte(h), /et 15 autres\./)
})

test("à propos : une version publiée en attente porte son nom ; une vérification en échec se dit", () => {
  const h = rendre({ version: "v1.1.1", canal: "stable", cible: "v1.2.0", disponible: 1, commits: ["abc1234 Version 1.2.0"], verifie_le: "2026-11-19T07:00:00Z", depot: "Tgnima/usine-logicielle" })
  assert.match(texte(h), /Une nouvelle version est disponible : v1\.2\.0/)
  assert.match(texte(h), /1 changement disponible /)
  const e = rendre({ version: "v1.2.0", canal: "stable", disponible: 0, erreur: { message: "could not resolve host", depuis: "2026-11-19T06:00:00Z" }, depot: "Tgnima/usine-logicielle" })
  assert.match(texte(e), /Mises à jour vérification impossible/)
  assert.match(texte(e), /La vérification des mises à jour échoue depuis .+ : could not resolve host/)
})

test("à propos : avant la première lecture du déployeur, et sans dépôt connu, aucun lien inventé", () => {
  const h = rendre(null)
  assert.match(texte(h), /Version en service — Pas encore lue/)
  assert.doesNotMatch(h, /github\.com/)
  const sansDepot = rendre({ version: "v1.2.0", canal: "stable", disponible: 0, depot: "pas un dépôt" })
  assert.doesNotMatch(sansDepot, /github\.com/, "un nom de dépôt invalide ne fabrique pas de lien")
})

test("à propos : une mise à jour lancée depuis la console, réussie ou non, est rappelée", () => {
  const h = rendre({ version: "v1.2.0", canal: "stable", disponible: 0, derniere: { terminee_le: "2026-11-19T00:25:06Z", reussie: false, code: 1 }, depot: "Tgnima/usine-logicielle" })
  assert.match(texte(h), /Dernière mise à jour lancée depuis la console .+, en échec \(code 1\)/)
})

test("à propos : la page est dans le sous-menu des réglages, et la version se voit en bas du menu", () => {
  assert.match(source, /\["apropos", "À propos", "La version de l'usine"\]/)
  assert.match(extraire("function vueReglages("), /apropos: vueAPropos/)
  assert.match(source, /href="#\/reglages\/apropos"[^>]*>\$\{r\.usine\.mise_a_jour\?\.version \? `Usine \$\{r\.usine\.mise_a_jour\.version\}` : "À propos"\}/)
  // Le déployeur publie le dépôt de l'usine avec l'état de la mise à jour.
  const deployeur = readFileSync(new URL("../../deployeur/server.mjs", import.meta.url), "utf8")
  assert.match(deployeur, /mise_a_jour: \{ \.\.\.miseAJour, depot: DEPOT_USINE \|\| null \}/)
})
