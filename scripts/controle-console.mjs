// Le contrôle automatique de la console, pour l'agent designer-console : contrastes des couleurs
// du thème (clair et sombre), couleurs écrites en dur, textes trop petits, jargon visible,
// boutons sans nom, images sans texte de remplacement. Lecture seule ; le code n'est pas exécuté.
// Usage : node scripts/controle-console.mjs
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const racine = join(dirname(fileURLToPath(import.meta.url)), "..", "orchestrateur", "console")
const css = readFileSync(join(racine, "console.css"), "utf8")
const js = readFileSync(join(racine, "console.js"), "utf8")
const constats = []
const noter = (gravite, quoi, ou = "") => constats.push({ gravite, quoi, ou })

// --- Contrastes (WCAG 2.2 : 4,5 pour un texte, 3 pour un grand texte ou un élément d'interface).
const jetons = (bloc) => Object.fromEntries([...bloc.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]))
const clair = jetons(css.slice(css.indexOf(":root {"), css.indexOf("@media (prefers-color-scheme: dark)")))
const sombre = { ...clair, ...jetons(css.slice(css.indexOf("@media (prefers-color-scheme: dark)"), css.indexOf("* { box-sizing"))) }
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}
const PAIRES = [
  ["encre", "fond"], ["encre", "surface"], ["texte", "surface"], ["texte", "fond"], ["doux", "surface"], ["doux", "fond"], ["doux", "surface-2"],
  ["accent", "surface"], ["accent", "fond"], ["accent-fort", "accent-fond"], ["accent-texte", "accent"],
  ["signal", "signal-fond"], ["signal", "surface"], ["ok", "ok-fond"], ["danger", "danger-fond"], ["danger", "surface"], ["code-texte", "code"],
]
const lignesContraste = []
for (const [theme, t] of [["clair", clair], ["sombre", sombre]]) {
  for (const [texte, fond] of PAIRES) {
    if (!t[texte] || !t[fond]) continue
    const r = ratio(t[texte], t[fond])
    lignesContraste.push(`${theme.padEnd(6)} --${texte} sur --${fond} : ${r.toFixed(2)}`)
    if (r < 4.5) noter(r < 3 ? "bloquant" : "à corriger", `contraste ${r.toFixed(2)} (thème ${theme}) : --${texte} sur --${fond}, sous 4,5 pour un texte`, "console.css")
  }
}

// --- Couleurs écrites en dur hors du thème (elles ne suivent pas le mode sombre).
const finTheme = css.indexOf("* { box-sizing")
css.split("\n").forEach((l, i) => {
  if (css.indexOf(l) < finTheme) return
  for (const m of l.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) noter("à surveiller", `couleur en dur ${m[0]} (ne suit pas le thème)`, `console.css:${i + 1}`)
})
js.split("\n").forEach((l, i) => {
  for (const m of l.matchAll(/(?:color|background)\s*:\s*(#[0-9a-fA-F]{3,8})\b/g)) noter("à surveiller", `couleur en dur ${m[1]} dans un style`, `console.js:${i + 1}`)
})

// --- Textes trop petits.
const lignesCss = css.split("\n")
lignesCss.forEach((l, i) => {
  for (const m of l.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) if (Number(m[1]) < 12) noter("à corriger", `texte de ${m[1]} px (au moins 12 px)`, `console.css:${i + 1}`)
})
js.split("\n").forEach((l, i) => {
  for (const m of l.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) if (Number(m[1]) < 12) noter("à corriger", `texte de ${m[1]} px (au moins 12 px)`, `console.js:${i + 1}`)
})

// --- Jargon visible : des mots techniques dans le texte affiché (entre > et <).
const JARGON = /\b(API|token|commit|merge|pull request|PR #|deploy\w*|backend|frontend|repo|workflow|webhook|endpoint|build|stack|cron|payload|bug)\b/i
js.split("\n").forEach((l, i) => {
  for (const m of l.matchAll(/>([^<>`$]{3,})</g)) {
    const t = m[1].trim()
    const j = JARGON.exec(t)
    if (j) noter("à surveiller", `mot technique « ${j[1]} » dans un texte visible : « ${t.slice(0, 70)} »`, `console.js:${i + 1}`)
  }
})

// --- Boutons sans nom (un pictogramme seul, sans aria-label) et images sans alt.
js.split("\n").forEach((l, i) => {
  for (const m of l.matchAll(/<button\b([^>]*)>\s*([^\w\s<$]{1,3})\s*<\/button>/g)) if (!/aria-label=/.test(m[1])) noter("à corriger", `bouton « ${m[2]} » sans aria-label : un lecteur d'écran ne dit pas ce qu'il fait`, `console.js:${i + 1}`)
  for (const m of l.matchAll(/<img\b([^>]*)>/g)) if (!/\balt=/.test(m[1])) noter("à corriger", "image sans attribut alt", `console.js:${i + 1}`)
})

const ordre = { bloquant: 0, "à corriger": 1, "à surveiller": 2 }
constats.sort((a, b) => ordre[a.gravite] - ordre[b.gravite])
console.log("# Contrastes du thème\n")
console.log(lignesContraste.join("\n"))
console.log(`\n# Constats (${constats.length})\n`)
const parGravite = Object.groupBy(constats, (c) => c.gravite)
for (const g of Object.keys(ordre)) console.log(`${g} : ${parGravite[g]?.length ?? 0}`)
console.log("")
for (const c of constats.slice(0, 80)) console.log(`- [${c.gravite}] ${c.quoi}${c.ou ? `  (${c.ou})` : ""}`)
if (constats.length > 80) console.log(`… et ${constats.length - 80} autres`)
