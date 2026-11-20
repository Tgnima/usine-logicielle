// La boucle de vérification, écarts 3 à 6 :
//   3. des critères qui peuvent échouer, et un critère validé sans test dit « non prouvé » ;
//   4. la correction d'un incident de production prouvée par un test qui échoue sur l'ancienne version ;
//   5. une refonte comparée à l'ancienne version, écran par écran et route par route ;
//   6. les budgets de l'interface (console, accessibilité, chargement, WebKit), en cliquet par page.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONSEIL, criteresVagues, verifierPlan } from "../src/analyste.mjs"
import { ouvrirCouts } from "../src/couts.mjs"
import { ouvrirDb } from "../src/db.mjs"
import {
  BUDGETS_JS, REFONTE_JS, chargementMax, ecrirePlanchers, idsRefonte, lirePlanchers, nouveauxPlanchers, raisonsBudgets, raisonsIncident,
  raisonsRefonte, resumeBudgets,
} from "../src/mesures.mjs"
import { ANCIENNE, comparerRefonte, consigneNature, criteresNonProuves, demarrerAncienne, porte, rejouerSurAncienne } from "../src/verification.mjs"

const source = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")

// --- Écart 3 : des critères qui peuvent échouer ----------------------------------------------------------
test("un critère flou, sans rien de mesurable, est signalé à l'analyste comme un conseil", () => {
  const lots = [{ taches: [{ cle: "T4", criteres: [
    "L'interface est agréable et soignée",
    "Le formulaire fonctionne correctement",
    "Le parcours clé tient en 3 actions",
    "Sur /contacts, le bouton « Ajouter » fonctionne",
    "POST /api/segments avec un nom vide renvoie 400",
    "Le résultat s'affiche dès la saisie, sans recharger",
  ] }] }]
  const p = criteresVagues(lots)
  assert.equal(p.length, 2)
  assert.ok(p.every((x) => x.startsWith(CONSEIL)))
  assert.match(p[0], /T4 : critère trop vague pour pouvoir échouer : « L'interface est agréable et soignée »/)
  assert.match(p[1], /« Le formulaire fonctionne correctement »/)
  assert.deepEqual(criteresVagues(undefined), [])
})

test("le dernier essai de l'analyste n'est pas bloqué par un conseil seul ; les règles des critères sont dans les trois consignes", () => {
  const a = source("analyste.mjs")
  assert.match(a, /problemes\.length === 0 \|\| \(essai === 2 && problemes\.every\(\(x\) => String\(x\)\.startsWith\(CONSEIL\)\)\)/)
  assert.equal(a.split("${REGLE_CRITERES} ${REGLE_NATURE}").length - 1, 3, "plan neuf, corrections et réorientation")
  assert.equal(a.split("...criteresVagues(").length - 1, 3)
})

test("la nature d'une tâche : seule « refonte » se donne dans un plan", () => {
  const plan = (nature) => ({ slug: "essai", nom: "Essai", lots: [{ nom: "L1", taches: [{ cle: "T1", titre: "t", description: "d", criteres: ["GET /api/x renvoie 200"], ...(nature === undefined ? {} : { nature }) }] }] })
  const nature = (p) => verifierPlan(p).filter((x) => x.includes("nature"))
  assert.deepEqual(nature(plan(undefined)), [])
  assert.deepEqual(nature(plan(null)), [])
  assert.deepEqual(nature(plan("refonte")), [])
  assert.match(nature(plan("magique"))[0], /T1 : nature inconnue « magique »/)
})

test("la nature d'une tâche est gardée en base", () => {
  const dossier = mkdtempSync(join(tmpdir(), "nature-"))
  try {
    const db = ouvrirDb(join(dossier, "usine.db"))
    const colonnes = db.prepare("PRAGMA table_info(taches)").all().map((c) => c.name)
    assert.ok(colonnes.includes("nature"))
    ouvrirDb(join(dossier, "usine.db")).close() // une seconde ouverture ne réajoute rien
    assert.match(source("creation.mjs"), /VALUES \(\?, \?, \?, \?, \?, \?, \?, \?, 'attente', \?\)"\)/)
    assert.match(source("creation.mjs"), /NATURES\.includes\(t\.nature\) \? t\.nature : null/)
    db.close()
  } finally {
    rmSync(dossier, { recursive: true, force: true })
  }
})

test("un critère validé sans test est « non prouvé », avec la raison du vérificateur ou sans", () => {
  const criteres = ["Sur /contacts, 50 contacts s'affichent", "POST /api/contacts sans email renvoie 400", "Le tableau est lisible sur mobile", "La page /aide s'affiche"]
  const verdict = { criteres: [
    { critere: "1. Sur /contacts, 50 contacts s’affichent.", ok: true },
    { critere: criteres[1], ok: true },
    { critere: criteres[2], ok: true, sans_test: "un jugement visuel, vu sur les captures" },
    { critere: criteres[3], ok: false },
  ] }
  const r = criteresNonProuves({ verdict, criteres, cle: "T3", tests: ["T3-1.cjs", "T3-21.cjs", "T31-2.cjs"] })
  // T3-1 prouve le critère 1 (citation retrouvée malgré le numéro, l'apostrophe et le point) ; T3-21 et T31-2 ne prouvent pas le 2.
  assert.deepEqual(r, [
    { critere: criteres[1], raison: "" },
    { critere: criteres[2], raison: "un jugement visuel, vu sur les captures" },
  ])
  // Un test nommé T3-2-erreur.cjs prouve le critère 2 ; un critère refusé n'est jamais dit « non prouvé ».
  assert.equal(criteresNonProuves({ verdict, criteres, cle: "T3", tests: ["T3-1.cjs", "T3-2-erreur.cjs"] }).length, 1)
  assert.deepEqual(criteresNonProuves({ verdict: null, criteres, cle: "T3", tests: [] }), [])
})

test("la PR dit les critères non prouvés et les budgets de l'interface", () => {
  const f = source("fabrique.mjs")
  assert.match(f, /Non prouvé\(s\) : validé\(s\) sans test/)
  assert.match(f, /Budgets de l'interface : \$\{v\.budgets\}/)
})

// --- Écart 4 : un incident reproduit par un test -------------------------------------------------------
const tout = { INSTALL_OK: "", BUILD_OK: "", APP_STARTED: "", TESTS_PASSES: "12", TESTS_ECHECS: "0" }
const valide = { decision: "approuve", criteres: [{ critere: "GET /api/x renvoie 200", ok: true }], resume: "ok" }
const raisonsDe = (m, verdict, nature) => porte({ marqueurs: { ...tout, ...m }, verdict, criteres: ["GET /api/x renvoie 200"], nature })

test("incident : au moins un test écrit par le vérificateur échoue sur l'ancienne version", () => {
  assert.deepEqual(raisonsDe({ BASE_STARTED: "", INCIDENT_TESTES: "T9-incident.cjs T9-1.cjs", INCIDENT_REPRODUIT: "T9-incident.cjs" }, valide, "incident"), [])
  const aucun = raisonsDe({ BASE_STARTED: "", INCIDENT_TESTES: "T9-incident.cjs", INCIDENT_REPRODUIT: "" }, valide, "incident")
  assert.match(aucun[0], /aucun des tests écrits \(T9-incident\.cjs\) n'échoue sur l'ancienne version/)
  const sansTest = raisonsDe({ BASE_STARTED: "", INCIDENT_TESTES: "", INCIDENT_REPRODUIT: "" }, valide, "incident")
  assert.match(sansTest[0], /aucun test n'a été écrit pour reproduire l'incident/)
  // Sans ancienne version démarrée, la porte ne conclut rien sur l'incident (verifier() passe la main à une personne).
  assert.deepEqual(raisonsDe({ INCIDENT_TESTES: "T9-1.cjs" }, valide, "incident"), [])
  // Une tâche ordinaire n'est pas concernée.
  assert.deepEqual(raisonsDe({ BASE_STARTED: "", INCIDENT_TESTES: "T9-1.cjs", INCIDENT_REPRODUIT: "" }, valide, null), [])
  assert.deepEqual(raisonsIncident({ marqueurs: {} }), [])
})

test("incident : une correction demandée pour un incident marque sa première tâche ; la boucle et le pilote le disent", () => {
  assert.match(source("livraison.mjs"), /if \(incident && r\.lot\.taches\?\.length\) r\.lot\.taches\[0\] = \{ \.\.\.r\.lot\.taches\[0\], nature: "incident" \}/)
  assert.match(source("pilote.mjs"), /corriger\(ctx, projetId, texteCorrection\(d, maintenant\), PAR_PILOTE, \{ incident: true \}\)/)
  assert.match(source("fabrique.mjs"), /Cette tâche corrige un INCIDENT de production\. Commence par un test qui le reproduit/)
})

test("incident : les tests sont relancés deux fois sur l'ancienne version avant de dire qu'ils la font échouer", () => {
  const s = rejouerSurAncienne()
  assert.ok(s.includes(`BASE=${ANCIENNE}`))
  assert.match(s, /if ! BASE=\S+ timeout 90 node "\$f" > \S+ 2>&1 && ! BASE=\S+ timeout 90 node "\$f"/)
  assert.match(s, /echo "@@ INCIDENT_TESTES \$E2E_NEUFS"; echo "@@ INCIDENT_REPRODUIT \$INC_R"/)
})

// --- Écart 5 : une refonte comparée à l'ancienne version ----------------------------------------------
test("refonte : chaque différence avec l'ancienne version est expliquée par le vérificateur", () => {
  const m = { BASE_STARTED: "", REFONTE_COMPAREES: "6", REFONTE_DIFFERENCES: "2", REFONTE_IDS: "page:/contacts:bureau route:/api/contacts" }
  const r = raisonsDe(m, valide, "refonte")
  assert.equal(r.length, 2)
  assert.match(r[0], /refonte : page:\/contacts:bureau diffère de l'ancienne version, sans explication/)
  const explique = { ...valide, differences_refonte: [{ difference: "page:/contacts:bureau (bureau)", explication: "l'heure affichée en haut" }, { difference: "route:/api/contacts", explication: "  " }] }
  assert.deepEqual(raisonsDe(m, explique, "refonte").map((x) => x.split(" diffère")[0]), ["refonte : route:/api/contacts"], "une explication vide n'explique rien")
  assert.deepEqual(raisonsRefonte({ marqueurs: { REFONTE_IDS: "page:/x:bureau" }, verdict: null }), [], "sans ancienne version démarrée, rien n'est conclu ici")
  assert.deepEqual(idsRefonte({ REFONTE_IDS: "page:/a:bureau  route:/api/b pasunid page:x" }), ["page:/a:bureau", "route:/api/b"])
})

test("refonte et incident : l'ancienne version démarre à côté, sur son port et ses données", () => {
  const s = demarrerAncienne("'origin/main'", { installer: "npm ci", construire: "npm run build", demarrer: "npm start" }).join("\n")
  assert.match(s, /git worktree add -q -f --detach \/travail\/verif\/base 'origin\/main'/)
  assert.match(s, /PORT=4101 DATA_DIR=\/tmp\/verif-data-base PUBLIC_URL=http:\/\/localhost:4101 setsid bash -c 'npm start'/)
  assert.match(s, /@@ BASE_STARTED/)
  const c = comparerRefonte({ titre: "Réorganiser /contacts", description: "Rien ne change.", criteres: JSON.stringify(["GET /api/contacts renvoie la même liste"]) }).join("\n")
  assert.match(c, /ANCIEN=http:\/\/localhost:4101 NOUVEAU=http:\/\/localhost:4100/)
  assert.match(c, /refonte\.cjs/)
  assert.match(consigneNature({ nature: "refonte" }), /REFONTE.*differences_refonte/s)
  assert.match(consigneNature({ cle: "T9", nature: "incident" }), /T9-incident\.cjs/)
  assert.equal(consigneNature({ nature: null }), "")
})

// --- Écart 6 : les budgets de l'interface --------------------------------------------------------------
const mesure = (pages) => ({ axe: true, webkit: true, pages })
const page = (console = 0, a11y = 0, webkit = 0, chargement_ms = 100) => ({
  console: Array.from({ length: console }, (_, i) => `erreur ${i + 1}`),
  a11y: Array.from({ length: a11y }, (_, i) => ({ regle: `regle-${i + 1}`, impact: "serious", elements: 2, aide: "Une aide" })),
  webkit: Array.from({ length: webkit }, (_, i) => `webkit ${i + 1}`),
  chargement_ms,
})

test("budgets : une page ne fait pas pire que son meilleur résultat ; une première mesure fixe le plancher", () => {
  const planchers = { pages: { "/": { console: 0, a11y: 1, webkit: 0 } } }
  assert.deepEqual(raisonsBudgets(mesure({ "/": page(0, 1, 0), "/neuve": page(3, 2, 1) }), planchers), [], "le plancher tient ; une page neuve ne bloque pas")
  const r = raisonsBudgets(mesure({ "/": page(2, 2, 1) }), planchers)
  assert.equal(r.length, 3)
  assert.match(r[0], /\/ a 2 erreur\(s\) dans la console du navigateur \(0 avant cette tâche\) : « erreur 1 » ; « erreur 2 »/)
  assert.match(r[1], /2 défaut\(s\) d'accessibilité graves \(1 avant\) : regle-1 \(Une aide, 2 élément\(s\)\)/)
  assert.match(r[2], /WebKit \(le moteur de Safari\)/)
  // Une page en erreur HTTP n'est pas mesurée.
  assert.deepEqual(raisonsBudgets(mesure({ "/": { ...page(9, 9, 9), ignoree: "HTTP 404" } }), planchers), [])
})

test("budgets : le temps de chargement a un plafond absolu, réglable", () => {
  assert.equal(chargementMax({}), 5000)
  assert.equal(chargementMax({ autonomie: { chargement_max_ms: 8000 } }), 8000)
  assert.equal(chargementMax({ autonomie: { chargement_max_ms: 10 } }), 500)
  const r = raisonsBudgets(mesure({ "/lente": page(0, 0, 0, 7200) }), { pages: {} }, { max: 5000 })
  assert.deepEqual(r, ["budget de l'interface : /lente se charge en 7.2 s (au plus 5.0 s)"])
})

test("budgets : une tâche validée garde, page par page, le meilleur résultat ; lu et écrit en réglage", () => {
  const avant = { pages: { "/": { console: 2, a11y: 1, webkit: 0 }, "/autre": { console: 0, a11y: 0, webkit: 0 } } }
  const apres = nouveauxPlanchers(mesure({ "/": page(1, 3, 0), "/neuve": page(1, 0, 2), "/cassee": { ...page(), ignoree: "HTTP 500" } }), avant)
  assert.deepEqual(apres, { pages: { "/": { console: 1, a11y: 1, webkit: 0 }, "/autre": { console: 0, a11y: 0, webkit: 0 }, "/neuve": { console: 1, a11y: 0, webkit: 2 } } })
  const dossier = mkdtempSync(join(tmpdir(), "budgets-"))
  try {
    const db = ouvrirDb(join(dossier, "usine.db"))
    ouvrirCouts(db)
    assert.deepEqual(lirePlanchers(db, 7), { pages: {} })
    ecrirePlanchers(db, 7, apres)
    assert.deepEqual(lirePlanchers(db, 7), apres)
    db.close()
  } finally {
    rmSync(dossier, { recursive: true, force: true })
  }
  assert.match(resumeBudgets(mesure({ "/": page(1, 2, 0, 1500), "/b": page(0, 0, 3, 400) })), /^2 page\(s\) mesurée\(s\) : 1 erreur\(s\) de console, 2 défaut\(s\) d'accessibilité graves, 3 erreur\(s\) dans WebKit, chargement le plus lent 1\.5 s$/)
  assert.match(resumeBudgets({ axe: false, webkit: false, pages: { "/": page() } }), /axe-core absent : non mesurés\), WebKit indisponible/)
})

test("les scripts de mesure sont du JavaScript valide, sans rien que la consigne pourrait couper", () => {
  const dossier = mkdtempSync(join(tmpdir(), "mesures-"))
  try {
    for (const [nom, script] of [["budgets", BUDGETS_JS], ["refonte", REFONTE_JS]]) {
      const f = join(dossier, `${nom}.cjs`)
      writeFileSync(f, script)
      execFileSync(process.execPath, ["--check", f])
      assert.ok(!script.includes("`") && !script.includes("${"), `${nom} : ni accent grave ni dollar accolade`)
    }
    assert.match(REFONTE_JS, /GET\\s\+\(\\\/api\\\//, "les barres obliques inverses de l'expression sont gardées")
    assert.match(BUDGETS_JS, /require\("axe-core"\)\.source/)
    assert.match(BUDGETS_JS, /webkit\.launch\(\)/)
  } finally {
    rmSync(dossier, { recursive: true, force: true })
  }
})

test("le vérificateur a WebKit et axe-core ; le budget de chargement est dans la configuration d'exemple", () => {
  const d = readFileSync(new URL("../../verificateur/Dockerfile", import.meta.url), "utf8")
  assert.match(d, /npx playwright install --with-deps chromium webkit/)
  assert.match(d, /axe-core@latest/)
  assert.match(readFileSync(new URL("../../usine.config.example.yml", import.meta.url), "utf8"), /chargement_max_ms: 5000/)
})
