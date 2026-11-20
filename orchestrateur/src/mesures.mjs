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

// Les budgets de l'interface, page par page : chaque page de la tâche sur ordinateur (avec le chargement et
// l'accessibilité) et sur téléphone, dans Chromium puis dans WebKit. Une page neuve pour chaque adresse : une
// erreur tardive d'une page n'est jamais comptée sur la suivante. Chaque mesure dit si elle a vraiment eu lieu
// (console_mesure, a11y_mesure, webkit_mesure) : ce qui n'a pas été mesuré ne compte pas pour zéro.
// Résultat dans /tmp/sorties/verif/budgets.json.
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
const fiche = (chemin) => (mesure.pages[chemin] = mesure.pages[chemin] || { console: [], console_mesure: false, a11y: [], a11y_mesure: false, webkit: [], webkit_mesure: false, chargement_ms: null })
const court = (t) => String(t).split(String.fromCharCode(10))[0].slice(0, 200)
// Un chargement qui ne bloque pas sur une page qui écoute le serveur en continu : « load », puis le réseau
// calme s'il le devient en 5 s.
async function ouvrir(page, url) {
  const reponse = await page.goto(url, { waitUntil: "load", timeout: 20000 })
  await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(500)
  return reponse
}
async function parcourir(navigateur, nom, largeur, hauteur) {
  const contexte = await navigateur.newContext({ viewport: { width: largeur, height: hauteur }, locale: "fr-FR", timezoneId: "Europe/Paris" })
  for (const chemin of PAGES) {
    const f = fiche(chemin)
    const erreurs = []
    const page = await contexte.newPage()
    page.on("console", (m) => {
      // Une ressource d'un autre site (une police, un script externe) que le vérificateur ne joint pas n'est pas
      // une erreur de l'application : seules comptent celles de l'application elle-même.
      const origine = (m.location() || {}).url || ""
      if (m.type() === "error" && (!origine || origine.startsWith(BASE))) erreurs.push(court(m.text()))
    })
    page.on("pageerror", (e) => erreurs.push(court(e.message)))
    try {
      const reponse = await ouvrir(page, BASE + chemin)
      // Une page en erreur (un identifiant deviné qui n'existe pas en démo) n'est pas mesurée.
      if (reponse && reponse.status() >= 400) {
        f.ignoree = "HTTP " + reponse.status()
      } else {
        if (nom === "bureau") {
          // La page prête (DOMContentLoaded) : le temps de l'application, sans les images ni les polices d'autres sites.
          f.chargement_ms = await page.evaluate(() => {
            const n = performance.getEntriesByType("navigation")[0]
            return n ? Math.round(n.domContentLoadedEventEnd || n.loadEventEnd || n.duration) : null
          })
          if (AXE) {
            try {
              await page.evaluate(AXE)
              f.a11y = await page.evaluate(() => window.axe.run(document, { resultTypes: ["violations"] }).then((r) => r.violations
                .filter((v) => v.impact === "serious" || v.impact === "critical")
                .map((v) => ({ regle: v.id, impact: v.impact, elements: v.nodes.length, aide: v.help }))))
              f.a11y_mesure = true
            } catch (e) {
              f.a11y_erreur = court(e.message)
            }
          }
        }
        const cible = nom === "webkit" ? f.webkit : f.console
        for (const e of erreurs) if (!cible.includes(e)) cible.push(e)
        if (nom === "webkit") f.webkit_mesure = true
        if (nom === "bureau") f.console_mesure = true
      }
    } catch (e) {
      // Une page qui ne se charge pas : dite, mais rien n'est compté comme mesuré pour ce navigateur.
      f["injoignable_" + nom] = court(e.message)
    }
    await page.close().catch(() => {})
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
// ordinateur et sur téléphone, animations coupées, comparée pixel par pixel dans le navigateur lui-même) et
// chaque route GET (code HTTP et JSON, clés triées). Une page ou une route que l'ANCIENNE version ne donne pas
// est « impossible à comparer » (REFONTE_IMPOSSIBLES) ; que la NOUVELLE ne donne plus, c'est une différence.
// Les différences vont dans /tmp/sorties/verif/refonte.txt, avec les images et les réponses dans
// /tmp/sorties/verif/refonte/. Chaque différence a un identifiant (page:/chemin:format ou route:/api/...) que
// le vérificateur reprend pour l'expliquer.
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
// La différence de deux captures, calculée dans une page vide : le nombre de pixels qui changent, et une
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
  const impossibles = []
  let comparees = 0
  const navigateur = await chromium.launch()
  const calcul = await navigateur.newPage()
  for (const [format, largeur, hauteur] of [["bureau", 1440, 900], ["mobile", 390, 844]]) {
    // Un contexte par version : les cookies ne séparent pas les ports, une version ne doit pas lire ceux de l'autre.
    const options = { viewport: { width: largeur, height: hauteur }, locale: "fr-FR", timezoneId: "Europe/Paris" }
    const contextes = new Map([[ANCIEN, await navigateur.newContext(options)], [NOUVEAU, await navigateur.newContext(options)]])
    for (const [i, chemin] of PAGES.entries()) {
      const id = "page:" + chemin + ":" + format
      const prendre = async (base) => {
        const page = await contextes.get(base).newPage()
        try {
          const r = await page.goto(base + chemin, { waitUntil: "load", timeout: 20000 })
          await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {})
          await page.waitForTimeout(800)
          return { statut: r ? r.status() : 0, png: await page.screenshot({ fullPage: true, animations: "disabled", caret: "hide" }) }
        } finally {
          await page.close().catch(() => {})
        }
      }
      let a
      try {
        a = await prendre(ANCIEN)
      } catch (e) {
        impossibles.push(id)
        lignes.push(id + " : comparaison impossible, l'ancienne version ne donne pas cette page (" + court(e.message) + ")")
        continue
      }
      let b
      try {
        b = await prendre(NOUVEAU)
      } catch (e) {
        comparees++
        ids.push(id)
        lignes.push(id + " : la nouvelle version ne donne plus cette page (" + court(e.message) + ")")
        continue
      }
      comparees++
      if (a.statut !== b.statut) {
        ids.push(id)
        lignes.push(id + " : HTTP " + a.statut + " avant, " + b.statut + " après")
        continue
      }
      try {
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
        comparees--
        impossibles.push(id)
        lignes.push(id + " : comparaison des images impossible (" + court(e.message) + ")")
      }
    }
    for (const c of contextes.values()) await c.close()
  }
  await navigateur.close()
  // Une route qui répond en continu (un flux) ne bloque pas : 15 s au plus par réponse.
  const lire = (base, route) => fetch(base + route, { signal: AbortSignal.timeout(15000) }).then(async (r) => ({ statut: r.status, texte: await r.text() }))
  for (const [i, route] of routes().entries()) {
    const id = "route:" + route
    let a
    try {
      a = await lire(ANCIEN, route)
    } catch (e) {
      impossibles.push(id)
      lignes.push(id + " : comparaison impossible, l'ancienne version ne répond pas (" + court(e.message) + ")")
      continue
    }
    let b
    try {
      b = await lire(NOUVEAU, route)
    } catch (e) {
      comparees++
      ids.push(id)
      lignes.push(id + " : la nouvelle version ne répond plus (" + court(e.message) + ")")
      continue
    }
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
  }
  fs.writeFileSync("/tmp/sorties/verif/refonte.txt", lignes.length ? lignes.join(String.fromCharCode(10)) : "Aucune différence avec l'ancienne version.")
  console.log("@@ REFONTE_COMPAREES " + comparees)
  console.log("@@ REFONTE_DIFFERENCES " + ids.length)
  console.log("@@ REFONTE_IDS " + ids.join(" "))
  console.log("@@ REFONTE_IMPOSSIBLES " + impossibles.length)
})().catch((e) => console.log("refonte : " + court(e.message)))
`

// --- Les budgets de l'interface : un cliquet par page, par problème connu ---------------------------------
// Une page ne peut pas avoir de NOUVEAU problème : une erreur de console, un défaut d'accessibilité grave ou
// une erreur dans WebKit qu'elle n'avait pas déjà, ni devenir lente (plus de autonomie.chargement_max_ms, 5 s
// par défaut). Les problèmes déjà connus d'une page ne refusent rien : une erreur intermittente ne fait pas
// échouer une tâche au hasard. Une page mesurée pour la première fois fixe ce qui est connu. Les problèmes
// connus ne s'ajoutent qu'à la fusion d'une tâche, ou quand une personne accepte une PR (escalade.mjs).
export const chargementMax = (config) => Math.max(500, Math.round(Number(config?.autonomie?.chargement_max_ms) || 5000))
const cleConnus = (projetId) => `budgets_${projetId}`
const cleMesure = (tacheId) => `budgets_mesure_${tacheId}`
const tableau = (v) => (Array.isArray(v) ? v : [])
// Une erreur, à ses chiffres près (un identifiant, une heure) : la même erreur n'est pas « nouvelle ».
export const cleProbleme = (t) => String(t ?? "")
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "#id")
  .replace(/\b[0-9a-f]{12,}\b/gi, "#id")
  .replace(/\d+/g, "#").replace(/\s+/g, " ").trim().slice(0, 140)
const unique = (liste) => [...new Set(liste)]

export function lireConnus(db, projetId) {
  try {
    const p = JSON.parse(lireReglage(db, cleConnus(projetId)) ?? "null")
    return p && typeof p.pages === "object" && p.pages ? p : { pages: {} }
  } catch {
    return { pages: {} }
  }
}
export const ecrireConnus = (db, projetId, connus) => ecrireReglage(db, cleConnus(projetId), JSON.stringify(connus))

// La mesure de la dernière vérification d'une tâche : relue à sa fusion, ou si une personne accepte sa PR.
export const gardeMesure = (db, tacheId, mesure) => ecrireReglage(db, cleMesure(tacheId), JSON.stringify(mesure))
export function reprendreMesure(db, tacheId) {
  try {
    const m = JSON.parse(lireReglage(db, cleMesure(tacheId)) ?? "null")
    db.prepare("DELETE FROM reglages WHERE cle = ?").run(cleMesure(tacheId))
    return m && typeof m.pages === "object" ? m : null
  } catch {
    return null
  }
}

// Ce qu'une page a vraiment mesuré : null pour ce qui ne l'a pas été (axe absent, WebKit en panne, page injoignable).
export function problemes(f, { max = 5000 } = {}) {
  if (!f || f.ignoree) return null
  return {
    console: f.console_mesure ? unique(tableau(f.console).map(cleProbleme)) : null,
    a11y: f.a11y_mesure ? unique(tableau(f.a11y).map((v) => String(v?.regle ?? ""))) : null,
    webkit: f.webkit_mesure ? unique(tableau(f.webkit).map(cleProbleme)) : null,
    lent: Number.isFinite(f.chargement_ms) ? f.chargement_ms > max : null,
  }
}

const extraits = (liste) => liste.slice(0, 2).map((x) => `« ${String(x).slice(0, 140)} »`).join(" ; ")

// Les nouveaux problèmes, en raisons de refus lisibles par l'agent qui code.
export function raisonsBudgets(mesure, connus, { max = 5000 } = {}) {
  const raisons = []
  for (const [chemin, f] of Object.entries(mesure?.pages ?? {})) {
    const p = problemes(f, { max })
    const k = connus?.pages?.[chemin]
    if (!p || !k) continue
    if (p.console && Array.isArray(k.console)) {
      const neuves = tableau(f.console).filter((m) => !k.console.includes(cleProbleme(m)))
      if (neuves.length) raisons.push(`budget de l'interface : ${chemin} a ${neuves.length} nouvelle(s) erreur(s) dans la console du navigateur : ${extraits(neuves)}`)
    }
    if (p.a11y && Array.isArray(k.a11y)) {
      const neufs = tableau(f.a11y).filter((v) => !k.a11y.includes(String(v?.regle ?? "")))
      if (neufs.length) raisons.push(`budget de l'interface : ${chemin} a ${neufs.length} nouveau(x) défaut(s) d'accessibilité graves : ${neufs.slice(0, 3).map((v) => `${v.regle} (${v.aide}, ${v.elements} élément(s))`).join(" ; ")}`)
    }
    if (p.webkit && Array.isArray(k.webkit)) {
      const neuves = tableau(f.webkit).filter((m) => !k.webkit.includes(cleProbleme(m)))
      if (neuves.length) raisons.push(`budget de l'interface : sur téléphone, dans WebKit (le moteur de Safari), ${chemin} a ${neuves.length} nouvelle(s) erreur(s) : ${extraits(neuves)}`)
    }
    // Une page connue, qui se chargeait (sa console a été mesurée), et qui ne se charge plus.
    if (f.injoignable_bureau && Array.isArray(k.console)) raisons.push(`budget de l'interface : ${chemin} ne se charge plus en 20 s (${String(f.injoignable_bureau).slice(0, 140)})`)
    if (p.lent === true && k.lent === false) raisons.push(`budget de l'interface : ${chemin} se charge maintenant en ${(f.chargement_ms / 1000).toFixed(1)} s (au plus ${(max / 1000).toFixed(1)} s)`)
  }
  return raisons
}

// À la fusion (ou à l'acceptation d'une personne) : ce que la tâche a mesuré rejoint ce qui est connu. Ce
// qu'elle n'a pas mesuré (WebKit en panne, axe absent) est oublié : la tâche a pu y ajouter un problème, que
// la prochaine mesure apprendra au lieu de le reprocher à la tâche suivante.
export function connusApres(mesure, connus, { max = 5000 } = {}) {
  const pages = { ...(connus?.pages ?? {}) }
  for (const [chemin, f] of Object.entries(mesure?.pages ?? {})) {
    const p = problemes(f, { max })
    if (!p) continue
    const k = pages[chemin] ?? {}
    const fusion = (cle) => (p[cle] === null ? undefined : unique([...tableau(k[cle]), ...p[cle]]))
    const lent = p.lent === null ? undefined : Boolean(k.lent) || p.lent
    pages[chemin] = Object.fromEntries(Object.entries({ console: fusion("console"), a11y: fusion("a11y"), webkit: fusion("webkit"), lent }).filter(([, v]) => v !== undefined))
  }
  return { pages }
}

// Les pages qu'une fusion n'a pas mesurées : oubliées, pour être réapprises à la prochaine mesure.
export function oublierPages(connus, chemins) {
  const pages = { ...(connus?.pages ?? {}) }
  for (const c of chemins ?? []) delete pages[c]
  return { pages }
}

// Un résumé d'une ligne pour la PR.
export function resumeBudgets(mesure) {
  const pages = Object.entries(mesure?.pages ?? {}).filter(([, f]) => !f.ignoree)
  if (!pages.length) return ""
  const total = (cle, drapeau) => pages.filter(([, f]) => f[drapeau]).reduce((s, [, f]) => s + tableau(f[cle]).length, 0)
  const lent = Math.max(0, ...pages.map(([, f]) => Number(f.chargement_ms) || 0))
  return `${pages.length} page(s) mesurée(s) : ${total("console", "console_mesure")} erreur(s) de console, ${mesure.axe ? `${total("a11y", "a11y_mesure")} défaut(s) d'accessibilité graves` : "accessibilité non mesurée (axe-core absent)"}, ${mesure.webkit ? `${total("webkit", "webkit_mesure")} erreur(s) dans WebKit` : "WebKit indisponible"}, chargement le plus lent ${(lent / 1000).toFixed(1)} s`
}

// --- La refonte et l'incident : ce que l'usine en conclut ------------------------------------------------
export const idsRefonte = (m) => String(m?.REFONTE_IDS ?? "").split(/\s+/).filter((x) => /^(page|route):\/\S*$/.test(x))
// L'identifiant cité par le vérificateur, où qu'il soit dans son texte (entre « », entre accents graves…).
const idsCites = (texte) => [...String(texte ?? "").matchAll(/(?:page|route):\/[^\s«»"'`,;)]*/g)].map((m) => m[0].replace(/[.:]+$/, ""))

// Les différences avec l'ancienne version que le vérificateur n'a pas expliquées (une heure, une donnée de
// démo tirée au sort…). Une vraie différence, il la met dans ses problèmes : refus. Une différence ni expliquée
// ni signalée : une personne regarde les images.
export function differencesNonExpliquees({ marqueurs: m = {}, verdict = null }) {
  if (!("REFONTE_COMPAREES" in m)) return []
  const expliquees = new Set(tableau(verdict?.differences_refonte).filter((d) => String(d?.explication ?? "").trim()).flatMap((d) => idsCites(d?.difference)))
  return idsRefonte(m).filter((id) => !expliquees.has(id))
}

// Un incident est-il prouvé ? Les tests d'incident du vérificateur (T<n>-incident*.cjs) sont relancés sur
// l'ancienne version : au moins un doit y échouer. Renvoie null s'il est prouvé, sinon pourquoi.
export const nomsTests = (v) => String(v ?? "").split(/\s+/).filter((f) => /^[\w.-]+\.cjs$/.test(f))
export function incidentNonProuve({ marqueurs: m = {} }) {
  if (!("INCIDENT_TESTES" in m)) return null
  const testes = nomsTests(m.INCIDENT_TESTES)
  if (!testes.length) return "le vérificateur n'a écrit aucun test qui reproduit l'incident"
  if (!nomsTests(m.INCIDENT_REPRODUIT).length) return `aucun des tests d'incident (${testes.join(" ")}) n'échoue sur l'ancienne version : l'incident n'est pas reproduit, peut-être parce qu'il ne se produit pas en démonstration`
  return null
}
