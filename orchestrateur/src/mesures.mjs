// Ce que l'usine mesure elle-même pendant une vérification, sans demander d'avis à un modèle :
//   - les budgets de l'interface (écart 6 de la boucle de vérification) : erreurs dans la console du
//     navigateur, défauts d'accessibilité graves (axe-core), temps de chargement, et les mêmes pages sur
//     téléphone dans WebKit, le moteur de Safari ;
//   - une refonte comparée à l'ancienne version (écart 5) : pour une tâche qui ne doit rien changer à
//     l'écran ni à l'API, le corrigé est l'ancienne version, écran par écran et route par route ;
//   - un incident reproduit (écart 4) : un test qui échoue sur l'ancienne version et passe sur la nouvelle.
// Les scripts tournent dans le vérificateur (Playwright avec Chromium et WebKit, et axe-core, installés dans son
// image). Écrits avec String.raw, sans accent grave ni « dollar accolade » : ils restent tels quels dans ce
// fichier, barres obliques inverses comprises.

import { ecrireReglage, lireReglage } from "./couts.mjs"

// Les budgets de l'interface, page par page : chaque page de la tâche, sur ordinateur (avec le chargement et
// l'accessibilité) et sur téléphone, dans Chromium puis dans WebKit. Résultat dans /tmp/sorties/verif/budgets.json.
export const BUDGETS_JS = String.raw`// Les budgets de l'interface, mesurés par l'usine (pas par le modèle).
const { chromium, webkit } = require("playwright")
const fs = require("fs")
const BASE = process.env.BASE
const PAGES = JSON.parse(process.env.PAGES || '["/"]')
let AXE = ""
try {
  AXE = require("axe-core").source
} catch (e) {
  AXE = ""
}
const mesure = { pages: {}, axe: Boolean(AXE), webkit: true }
const fiche = (chemin) => (mesure.pages[chemin] = mesure.pages[chemin] || { console: [], a11y: [], webkit: [], chargement_ms: null })
const court = (t) => String(t).split(String.fromCharCode(10))[0].slice(0, 200)
async function parcourir(navigateur, nom, largeur, hauteur) {
  const contexte = await navigateur.newContext({ viewport: { width: largeur, height: hauteur }, locale: "fr-FR", timezoneId: "Europe/Paris" })
  const page = await contexte.newPage()
  let erreurs = []
  page.on("console", (m) => {
    // Une ressource d'un autre site (une police, un script externe) que le vérificateur ne joint pas n'est pas
    // une erreur de l'application : seules comptent celles de l'application elle-même.
    const origine = (m.location() || {}).url || ""
    if (m.type() === "error" && (!origine || origine.startsWith(BASE))) erreurs.push(court(m.text()))
  })
  page.on("pageerror", (e) => erreurs.push(court(e.message)))
  for (const chemin of PAGES) {
    erreurs = []
    const f = fiche(chemin)
    const cible = nom === "webkit" ? f.webkit : f.console
    try {
      const reponse = await page.goto(BASE + chemin, { waitUntil: "networkidle", timeout: 20000 })
      // Une page en erreur (un identifiant deviné qui n'existe pas en démo) n'est pas mesurée.
      if (reponse && reponse.status() >= 400) {
        f.ignoree = "HTTP " + reponse.status()
        continue
      }
      await page.waitForTimeout(500)
      if (nom === "bureau") {
        f.chargement_ms = await page.evaluate(() => {
          const n = performance.getEntriesByType("navigation")[0]
          return n ? Math.round(n.loadEventEnd || n.domContentLoadedEventEnd || n.duration) : null
        })
        if (AXE) {
          await page.evaluate(AXE)
          f.a11y = await page.evaluate(() => window.axe.run(document, { resultTypes: ["violations"] }).then((r) => r.violations
            .filter((v) => v.impact === "serious" || v.impact === "critical")
            .map((v) => ({ regle: v.id, impact: v.impact, elements: v.nodes.length, aide: v.help }))))
        }
      }
      for (const e of erreurs) if (!cible.includes(e)) cible.push(e)
    } catch (e) {
      cible.push("page impossible à charger : " + court(e.message))
    }
  }
  await contexte.close()
}
;(async () => {
  const c = await chromium.launch()
  await parcourir(c, "bureau", 1440, 900)
  await parcourir(c, "mobile", 390, 844)
  await c.close()
  try {
    const w = await webkit.launch()
    await parcourir(w, "webkit", 390, 844)
    await w.close()
  } catch (e) {
    mesure.webkit = false
    mesure.webkit_erreur = court(e.message)
  }
  fs.writeFileSync("/tmp/sorties/verif/budgets.json", JSON.stringify(mesure))
  console.log("@@ BUDGETS_OK")
})().catch((e) => console.log("budgets : " + court(e.message)))
`

// La refonte comparée à l'ancienne version, démarrée à côté (ANCIEN) : chaque page (capture entière, sur
// ordinateur et sur téléphone, comparée pixel par pixel dans le navigateur lui-même) et chaque route GET
// (code HTTP et JSON, clés triées). Les différences vont dans /tmp/sorties/verif/refonte.txt, avec les images
// et les réponses dans /tmp/sorties/verif/refonte/. Chaque différence a un identifiant (page:/chemin:format ou
// route:/api/...) que le vérificateur reprend pour l'expliquer.
export const REFONTE_JS = String.raw`// Une refonte comparée à l'ancienne version, par l'usine.
const { chromium } = require("playwright")
const fs = require("fs")
const ANCIEN = process.env.ANCIEN
const NOUVEAU = process.env.NOUVEAU
const PAGES = JSON.parse(process.env.PAGES || '["/"]')
const SORTIE = "/tmp/sorties/verif/refonte"
// Un nombre de pixels, pas une proportion : un mot changé dans un titre ne touche que 0,1 % d'une page entière.
// Deux rendus du même code, dans le même navigateur, sont identiques au pixel près.
const SEUIL = Number(process.env.SEUIL || 200)
const court = (t) => String(t).split(String.fromCharCode(10))[0].slice(0, 200)
const nomDe = (t) => (t.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "accueil").slice(0, 40)
// Les routes GET de docs/API.md (un paramètre devient 1), puis celles que cite la tâche : 10 au plus.
function routes() {
  const vues = new Set()
  const doc = fs.existsSync("docs/API.md") ? fs.readFileSync("docs/API.md", "utf8") : ""
  const texte = doc + " " + (process.env.TEXTE || "")
  for (const m of texte.matchAll(/GET\s+(\/api\/[A-Za-z0-9_\-/:{}.]*)/g)) {
    const r = m[1].replace(/:[A-Za-z_]+/g, "1").replace(/\{[A-Za-z_]+\}/g, "1").replace(/[.]+$/, "")
    if (r.length > 5) vues.add(r)
    if (vues.size >= 10) break
  }
  return [...vues]
}
function trier(v) {
  if (Array.isArray(v)) return v.map(trier)
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, trier(v[k])]))
  return v
}
const normer = (t) => {
  try {
    return JSON.stringify(trier(JSON.parse(t)))
  } catch (e) {
    return t
  }
}
// La différence de deux captures, calculée dans une page vide : la proportion de pixels qui changent, et une
// image où ils sont en rouge.
async function difference(calcul, a, b) {
  return calcul.evaluate(async ([x, y]) => {
    const charger = (b64) => new Promise((ok, ko) => {
      const i = new Image()
      i.onload = () => ok(i)
      i.onerror = ko
      i.src = "data:image/png;base64," + b64
    })
    const [i1, i2] = await Promise.all([charger(x), charger(y)])
    const w = Math.max(i1.width, i2.width)
    const h = Math.max(i1.height, i2.height)
    const lire = (img) => {
      const c = document.createElement("canvas")
      c.width = w
      c.height = h
      const g = c.getContext("2d")
      g.fillStyle = "#fff"
      g.fillRect(0, 0, w, h)
      g.drawImage(img, 0, 0)
      return g.getImageData(0, 0, w, h).data
    }
    const d1 = lire(i1)
    const d2 = lire(i2)
    const c = document.createElement("canvas")
    c.width = w
    c.height = h
    const g = c.getContext("2d")
    const sortie = g.createImageData(w, h)
    let n = 0
    for (let p = 0; p < d1.length; p += 4) {
      const ecart = Math.abs(d1[p] - d2[p]) + Math.abs(d1[p + 1] - d2[p + 1]) + Math.abs(d1[p + 2] - d2[p + 2])
      if (ecart > 48) {
        n++
        sortie.data[p] = 255
        sortie.data[p + 1] = 0
        sortie.data[p + 2] = 0
      } else {
        const gris = 210 + Math.round((d2[p] + d2[p + 1] + d2[p + 2]) / 17)
        sortie.data[p] = gris
        sortie.data[p + 1] = gris
        sortie.data[p + 2] = gris
      }
      sortie.data[p + 3] = 255
    }
    g.putImageData(sortie, 0, 0)
    return { pixels: n, ratio: n / (w * h), tailles: i1.width + "x" + i1.height + " avant, " + i2.width + "x" + i2.height + " après", image: c.toDataURL("image/png").split(",")[1] }
  }, [a.toString("base64"), b.toString("base64")])
}
;(async () => {
  fs.mkdirSync(SORTIE, { recursive: true })
  const lignes = []
  const ids = []
  let comparees = 0
  const navigateur = await chromium.launch()
  const calcul = await navigateur.newPage()
  for (const [format, largeur, hauteur] of [["bureau", 1440, 900], ["mobile", 390, 844]]) {
    const contexte = await navigateur.newContext({ viewport: { width: largeur, height: hauteur }, locale: "fr-FR", timezoneId: "Europe/Paris" })
    const page = await contexte.newPage()
    for (const [i, chemin] of PAGES.entries()) {
      const id = "page:" + chemin + ":" + format
      const prendre = async (base) => {
        const r = await page.goto(base + chemin, { waitUntil: "networkidle", timeout: 20000 })
        await page.waitForTimeout(800)
        return { statut: r ? r.status() : 0, png: await page.screenshot({ fullPage: true }) }
      }
      try {
        const a = await prendre(ANCIEN)
        const b = await prendre(NOUVEAU)
        comparees++
        if (a.statut !== b.statut) {
          ids.push(id)
          lignes.push(id + " : HTTP " + a.statut + " avant, " + b.statut + " après")
          continue
        }
        const d = await difference(calcul, a.png, b.png)
        if (d.pixels > SEUIL) {
          const base = SORTIE + "/" + (i + 1) + "-" + nomDe(chemin) + "-" + format
          fs.writeFileSync(base + "-avant.png", a.png)
          fs.writeFileSync(base + "-apres.png", b.png)
          fs.writeFileSync(base + "-difference.png", Buffer.from(d.image, "base64"))
          ids.push(id)
          lignes.push(id + " : " + d.pixels + " pixels diffèrent, " + (d.ratio * 100).toFixed(2) + " % de la page (" + d.tailles + ") : " + base + "-difference.png")
        }
      } catch (e) {
        lignes.push(id + " : comparaison impossible (" + court(e.message) + ")")
      }
    }
    await contexte.close()
  }
  await navigateur.close()
  for (const [i, route] of routes().entries()) {
    const id = "route:" + route
    try {
      const [a, b] = await Promise.all([ANCIEN, NOUVEAU].map((base) => fetch(base + route).then(async (r) => ({ statut: r.status, texte: await r.text() }))))
      comparees++
      if (a.statut !== b.statut) {
        ids.push(id)
        lignes.push(id + " : HTTP " + a.statut + " avant, " + b.statut + " après")
        continue
      }
      if (normer(a.texte) !== normer(b.texte)) {
        const base = SORTIE + "/route-" + (i + 1)
        fs.writeFileSync(base + "-avant.json", a.texte.slice(0, 200000))
        fs.writeFileSync(base + "-apres.json", b.texte.slice(0, 200000))
        ids.push(id)
        lignes.push(id + " : la réponse diffère (" + a.texte.length + " octets avant, " + b.texte.length + " après) : " + base + "-avant.json et " + base + "-apres.json")
      }
    } catch (e) {
      lignes.push(id + " : comparaison impossible (" + court(e.message) + ")")
    }
  }
  fs.writeFileSync("/tmp/sorties/verif/refonte.txt", lignes.length ? lignes.join(String.fromCharCode(10)) : "Aucune différence avec l'ancienne version.")
  console.log("@@ REFONTE_COMPAREES " + comparees)
  console.log("@@ REFONTE_DIFFERENCES " + ids.length)
  console.log("@@ REFONTE_IDS " + ids.join(" "))
})().catch((e) => console.log("refonte : " + court(e.message)))
`

// --- Les budgets de l'interface : un cliquet par page ---------------------------------------------------
// Une page ne peut pas faire pire que son meilleur résultat déjà fusionné : erreurs de console, défauts
// d'accessibilité graves, erreurs dans WebKit. Une page mesurée pour la première fois fixe son plancher. Le
// temps de chargement a un plafond absolu (autonomie.chargement_max_ms, 5 s par défaut).
export const chargementMax = (config) => Math.max(500, Math.round(Number(config?.autonomie?.chargement_max_ms) || 5000))
const cleBudgets = (projetId) => `budgets_${projetId}`
const tableau = (v) => (Array.isArray(v) ? v : [])

export function lirePlanchers(db, projetId) {
  try {
    const p = JSON.parse(lireReglage(db, cleBudgets(projetId)) ?? "null")
    return p && typeof p.pages === "object" && p.pages ? p : { pages: {} }
  } catch {
    return { pages: {} }
  }
}

// Les nombres d'une page mesurée (null : la page n'a pas été mesurée, une erreur HTTP par exemple).
export function comptes(f) {
  if (!f || f.ignoree) return null
  return { console: tableau(f.console).length, a11y: tableau(f.a11y).length, webkit: tableau(f.webkit).length }
}

const extraits = (liste) => tableau(liste).slice(0, 2).map((x) => `« ${String(x).slice(0, 140)} »`).join(" ; ")

// Ce qui dépasse le budget, en raisons de refus lisibles par l'agent qui code.
export function raisonsBudgets(mesure, planchers, { max = 5000 } = {}) {
  const raisons = []
  for (const [chemin, f] of Object.entries(mesure?.pages ?? {})) {
    const n = comptes(f)
    if (!n) continue
    const p = planchers?.pages?.[chemin]
    if (p) {
      if (n.console > p.console) raisons.push(`budget de l'interface : ${chemin} a ${n.console} erreur(s) dans la console du navigateur (${p.console} avant cette tâche) : ${extraits(f.console)}`)
      if (n.a11y > p.a11y) raisons.push(`budget de l'interface : ${chemin} a ${n.a11y} défaut(s) d'accessibilité graves (${p.a11y} avant) : ${tableau(f.a11y).slice(0, 3).map((v) => `${v.regle} (${v.aide}, ${v.elements} élément(s))`).join(" ; ")}`)
      if (n.webkit > p.webkit) raisons.push(`budget de l'interface : sur téléphone, dans WebKit (le moteur de Safari), ${chemin} a ${n.webkit} erreur(s) (${p.webkit} avant) : ${extraits(f.webkit)}`)
    }
    if (Number.isFinite(f.chargement_ms) && f.chargement_ms > max) raisons.push(`budget de l'interface : ${chemin} se charge en ${(f.chargement_ms / 1000).toFixed(1)} s (au plus ${(max / 1000).toFixed(1)} s)`)
  }
  return raisons
}

// Après une tâche validée : chaque page garde son meilleur résultat.
export function nouveauxPlanchers(mesure, planchers) {
  const pages = { ...(planchers?.pages ?? {}) }
  for (const [chemin, f] of Object.entries(mesure?.pages ?? {})) {
    const n = comptes(f)
    if (!n) continue
    const p = pages[chemin]
    pages[chemin] = p ? { console: Math.min(p.console, n.console), a11y: Math.min(p.a11y, n.a11y), webkit: Math.min(p.webkit, n.webkit) } : n
  }
  return { pages }
}

export const ecrirePlanchers = (db, projetId, planchers) => ecrireReglage(db, cleBudgets(projetId), JSON.stringify(planchers))

// Un résumé d'une ligne pour la PR et le journal.
export function resumeBudgets(mesure) {
  const pages = Object.entries(mesure?.pages ?? {}).filter(([, f]) => comptes(f))
  if (!pages.length) return ""
  const total = (k) => pages.reduce((s, [, f]) => s + comptes(f)[k], 0)
  const lent = Math.max(0, ...pages.map(([, f]) => Number(f.chargement_ms) || 0))
  return `${pages.length} page(s) mesurée(s) : ${total("console")} erreur(s) de console, ${total("a11y")} défaut(s) d'accessibilité graves${mesure.axe ? "" : " (axe-core absent : non mesurés)"}, ${mesure.webkit ? `${total("webkit")} erreur(s) dans WebKit` : "WebKit indisponible"}, chargement le plus lent ${(lent / 1000).toFixed(1)} s`
}

// --- La refonte et l'incident : ce que la porte en conclut -----------------------------------------------
export const idsRefonte = (m) => String(m?.REFONTE_IDS ?? "").split(/\s+/).filter((x) => /^(page|route):\/\S*$/.test(x))

// Une différence avec l'ancienne version doit être expliquée par le vérificateur (une heure, une donnée de
// démo tirée au sort…). Sinon, la refonte a changé le produit : refus.
export function raisonsRefonte({ marqueurs: m = {}, verdict = null }) {
  if (!("BASE_STARTED" in m) || !("REFONTE_COMPAREES" in m)) return []
  const expliquees = new Set(tableau(verdict?.differences_refonte).filter((d) => String(d?.explication ?? "").trim()).map((d) => String(d?.difference ?? "").trim().split(/\s/)[0]))
  return idsRefonte(m).filter((id) => !expliquees.has(id)).map((id) => `refonte : ${id} diffère de l'ancienne version, sans explication. Une refonte ne change rien à l'écran ni aux réponses de l'API : rétablis le comportement d'avant (les images et les réponses sont dans /tmp/sorties/verif/refonte du vérificateur).`)
}

// Un incident corrigé : au moins un des tests écrits par le vérificateur échoue sur l'ancienne version.
export const nomsTests = (v) => String(v ?? "").split(/\s+/).filter((f) => /^[\w.-]+\.cjs$/.test(f))
export function raisonsIncident({ marqueurs: m = {} }) {
  if (!("BASE_STARTED" in m) || !("INCIDENT_TESTES" in m)) return []
  const testes = nomsTests(m.INCIDENT_TESTES)
  if (!testes.length) return ["incident : aucun test n'a été écrit pour reproduire l'incident. La correction d'un incident de production doit être prouvée par un test qui échoue sur l'ancienne version et passe sur la nouvelle."]
  if (!nomsTests(m.INCIDENT_REPRODUIT).length) return [`incident : aucun des tests écrits (${testes.join(" ")}) n'échoue sur l'ancienne version. Rien ne prouve que l'incident est reproduit, donc corrigé : rends la correction observable par un test.`]
  return []
}
