// La boucle de vérification, écarts 3 à 6 :
//   3. des critères qui peuvent échouer, et un critère validé sans test dit « non prouvé » ;
//   4. la correction d'un incident de production prouvée par un test qui échoue sur l'ancienne version ;
//   5. une refonte comparée à l'ancienne version, écran par écran et route par route ;
//   6. les budgets de l'interface (console, accessibilité, chargement, WebKit) : aucun nouveau problème par page.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CONSEIL, criteresVagues, naturesDonnees, verifierPlan } from "../src/analyste.mjs"
import { ouvrirCouts } from "../src/couts.mjs"
import { ouvrirDb } from "../src/db.mjs"
import {
  BUDGETS_JS, REFONTE_JS, chargementMax, cleProbleme, connusApres, differencesNonExpliquees, ecrireConnus, gardeMesure, idsRefonte,
  incidentNonProuve, lireConnus, raisonsBudgets, reprendreMesure, resumeBudgets,
} from "../src/mesures.mjs"
import {
  ANCIENNE, LIBERER_ANCIENNE, comparerRefonte, consigneNature, criteresNonProuves, demarrerAncienne, minutesVerification, preparerAncienne,
  rejouerSurAncienne,
} from "../src/verification.mjs"

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
    "Chaque adhérent a son propre espace",
    "Le thème clair est proposé dans les réglages",
  ] }] }]
  const p = criteresVagues(lots)
  assert.equal(p.length, 2, "« son propre espace » et « thème clair » ne sont pas flous")
  assert.ok(p.every((x) => x.startsWith(CONSEIL)))
  assert.match(p[0], /T4 : critère trop vague pour pouvoir échouer : « L'interface est agréable et soignée »/)
  assert.match(p[1], /« Le formulaire fonctionne correctement »/)
  assert.deepEqual(criteresVagues(undefined), [])
})

test("l'analyste : un conseil seul ne bloque pas le dernier essai, et un premier essai correct n'est pas perdu", () => {
  const a = source("analyste.mjs")
  assert.match(a, /problemes\.length === 0 \|\| \(essai === 2 && problemes\.every\(\(x\) => String\(x\)\.startsWith\(CONSEIL\)\)\)/)
  assert.match(a, /if \(problemes\.every\(\(x\) => String\(x\)\.startsWith\(CONSEIL\)\)\) repli = \{ objet, tokens \}/)
  assert.match(a, /if \(repli\) return repli\n {2}throw new Error/)
  assert.equal(a.split("${REGLE_CRITERES} ${REGLE_NATURE}").length - 1, 3, "plan neuf, corrections et réorientation")
  assert.equal(a.split("...criteresVagues(").length - 1, 3)
  assert.equal(a.split("...naturesDonnees(").length - 1, 3)
})

test("la nature d'une tâche : seule « refonte » se donne par l'analyste ; « incident » reste lisible dans les anciens lots", () => {
  const plan = (nature) => ({ slug: "essai", nom: "Essai", lots: [{ nom: "L1", taches: [{ cle: "T1", titre: "t", description: "d", criteres: ["GET /api/x renvoie 200"], ...(nature === undefined ? {} : { nature }) }] }] })
  const nature = (p) => verifierPlan(p).filter((x) => x.includes("nature"))
  for (const n of [undefined, null, "refonte", "incident"]) assert.deepEqual(nature(plan(n)), [], `${n}`)
  assert.match(nature(plan("magique"))[0], /T1 : nature inconnue « magique »/)
  assert.deepEqual(naturesDonnees(plan("refonte").lots), [])
  assert.match(naturesDonnees(plan("incident").lots)[0], /T1 : nature « incident » : seule « refonte » se donne/)
})

test("la nature d'une tâche est gardée en base", () => {
  const dossier = mkdtempSync(join(tmpdir(), "nature-"))
  try {
    const db = ouvrirDb(join(dossier, "usine.db"))
    assert.ok(db.prepare("PRAGMA table_info(taches)").all().map((c) => c.name).includes("nature"))
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
  assert.equal(criteresNonProuves({ verdict, criteres, cle: "T3", tests: ["T3-1.cjs", "T3-2-erreur.cjs"] }).length, 1)
  assert.deepEqual(criteresNonProuves({ verdict: null, criteres, cle: "T3", tests: [] }), [])
})

test("la PR dit les critères non prouvés et les budgets de l'interface", () => {
  const f = source("fabrique.mjs")
  assert.match(f, /Non prouvé\(s\) : validé\(s\) sans test/)
  assert.match(f, /Budgets de l'interface : \$\{v\.budgets\}/)
})

// --- L'ancienne version, à côté (écarts 4 et 5) --------------------------------------------------------
test("l'ancienne version se libère par son port seulement : jamais par nom, qui arrêterait la nouvelle", () => {
  assert.doesNotMatch(LIBERER_ANCIENNE, /pkill|killall/)
  assert.match(LIBERER_ANCIENNE, /fuser -k -n tcp 4101/)
  const prep = preparerAncienne("'origin/main'", { installer: "npm ci", construire: "npm run build", demarrer: "npm start" }).join("\n")
  assert.doesNotMatch(prep, /pkill|killall/)
  assert.match(prep, /git worktree add -q -f --detach \/travail\/verif\/base 'origin\/main'/)
  const dem = demarrerAncienne({ demarrer: "npm start" }).join("\n")
  assert.doesNotMatch(dem, /pkill|killall/)
  assert.match(dem, /PORT=4101 DATA_DIR=\/tmp\/verif-data-base PUBLIC_URL=http:\/\/localhost:4101 setsid bash -c 'npm start'/)
  assert.match(dem, /@@ BASE_PORT_OCCUPE/)
  assert.match(dem, /@@ BASE_STARTED/)
})

test("l'ordre du script : l'ancienne version prête avant la nouvelle, la refonte comparée avant le cliquet, l'incident rejoué après le tri des tests", () => {
  const v = source("verification.mjs")
  const position = (morceau) => {
    const i = v.indexOf(morceau, v.indexOf("export async function verifier("))
    assert.ok(i > 0, morceau)
    return i
  }
  const etapes = [
    "...(nature ? preparerAncienne(B, profil) : [])",
    "`(setsid bash -c ${q(profil.demarrer)} > /tmp/sorties/verif/app.log 2>&1 &)`",
    "...(nature ? demarrerAncienne(profil) : [])",
    "...(nature === \"refonte\" ? comparerRefonte(tache) : [])",
    "...rejouerCliquet({ minutes: plafond",
    "ecrireFichier(\"/tmp/sorties/verif/budgets.cjs\", BUDGETS_JS)",
    "trierTestsEcrits({ ref: B })",
    "...(nature === \"incident\" ? [...demarrerAncienne(profil), rejouerSurAncienne(tache.cle)] : [])",
    "...(nature ? [LIBERER_ANCIENNE,",
  ]
  for (let i = 1; i < etapes.length; i++) assert.ok(position(etapes[i - 1]) < position(etapes[i]), `${etapes[i - 1]} avant ${etapes[i]}`)
  assert.deepEqual([minutesVerification({ nature: null }), minutesVerification({ nature: "refonte" })], [45, 60])
})

test("une vérification coupée, une ancienne version absente ou une mesure qui n'a pas eu lieu : la vérification ne conclut pas", () => {
  const v = source("verification.mjs")
  assert.match(v, /if \("DELAI_DEPASSE" in m\) return \{ ok: false, infra: true,/)
  assert.match(v, /const ancienneAbsente = Boolean\(nature\) && "APP_STARTED" in m && \(!\("BASE_STARTED" in m\) \|\| "BASE_PORT_OCCUPE" in m\)/)
  assert.match(v, /nature === "refonte" && !\(Number\(m\.REFONTE_COMPAREES\) > 0\)\) \|\| \(nature === "incident" && !\("INCIDENT_TESTES" in m\)\)/)
  assert.match(v, /const codexEnPanne = \("APP_STARTED" in m && !verdict && m\.CODEX_CODE !== "0"\) \|\| ancienneAbsente \|\| mesureAbsente/)
  // Refonte non expliquée et incident non reproduit : une personne tranche, seulement quand tout le reste passe.
  assert.match(v, /if \(raisons\.length === 0 && verdict && nature === "refonte"\)/)
  assert.match(v, /if \(raisons\.length === 0 && verdict && nature === "incident"\)/)
})

// --- Écart 4 : un incident reproduit par un test -------------------------------------------------------
test("incident : seuls les tests d'incident sont relancés, deux fois, sur l'ancienne version", () => {
  const s = rejouerSurAncienne("T9")
  assert.ok(s.includes(`BASE=${ANCIENNE}`))
  assert.match(s, /case "\$n" in T9-incident\*\.cjs\) ;; \*\) continue ;; esac/)
  assert.match(s, /if ! BASE=\S+ timeout 90 node "\$f" > \S+ 2>&1 && ! BASE=\S+ timeout 90 node "\$f"/)
  assert.match(s, /echo "@@ INCIDENT_TESTES \$INC_T"; echo "@@ INCIDENT_REPRODUIT \$INC_R"/)
  assert.match(rejouerSurAncienne("T9; rm -rf /"), /case "\$n" in T9rm-rf-incident/, "une clé ne peut pas casser le script")
})

test("incident : prouvé si un test d'incident échoue sur l'ancienne version ; sinon une personne décide", () => {
  assert.equal(incidentNonProuve({ marqueurs: { INCIDENT_TESTES: "T9-incident.cjs", INCIDENT_REPRODUIT: "T9-incident.cjs" } }), null)
  assert.match(incidentNonProuve({ marqueurs: { INCIDENT_TESTES: "T9-incident.cjs", INCIDENT_REPRODUIT: "" } }), /aucun des tests d'incident \(T9-incident\.cjs\) n'échoue sur l'ancienne version/)
  assert.match(incidentNonProuve({ marqueurs: { INCIDENT_TESTES: "", INCIDENT_REPRODUIT: "" } }), /aucun test qui reproduit l'incident/)
  assert.equal(incidentNonProuve({ marqueurs: {} }), null, "sans rejeu, verifier() conclut à une vérification incomplète")
})

test("incident : la boucle et le pilote le disent ; la première tâche le porte, sauf une refonte ; l'analyste le sait", () => {
  assert.match(source("livraison.mjs"), /if \(incident && r\.lot\.taches\?\.length && !r\.lot\.taches\[0\]\.nature\) r\.lot\.taches\[0\] = \{ \.\.\.r\.lot\.taches\[0\], nature: "incident" \}/)
  assert.match(source("livraison.mjs"), /\n {6}ctx,\n {6}\/\/ Une correction d.incident[^\n]*\n {6}incident,/)
  assert.match(source("analyste.mjs"), /contexte\.incident \? "\\nCette demande vient d'un INCIDENT de production : la PREMIÈRE tâche du lot corrige l'incident lui-même/)
  assert.match(source("pilote.mjs"), /corriger\(ctx, projetId, texteCorrection\(d, maintenant\), PAR_PILOTE, \{ incident: true \}\)/)
  assert.match(source("fabrique.mjs"), /Cette tâche corrige un INCIDENT de production\. Commence par un test qui le reproduit/)
})

// --- Écart 5 : une refonte comparée à l'ancienne version ----------------------------------------------
test("refonte : une différence que le vérificateur n'explique pas, où qu'il cite son identifiant, part à une personne", () => {
  const m = { REFONTE_COMPAREES: "6", REFONTE_DIFFERENCES: "3", REFONTE_IDS: "page:/contacts:bureau route:/api/contacts page:/:mobile" }
  assert.deepEqual(differencesNonExpliquees({ marqueurs: m, verdict: null }), ["page:/contacts:bureau", "route:/api/contacts", "page:/:mobile"])
  const verdict = { differences_refonte: [
    { difference: "« page:/contacts:bureau » (l'heure en haut)", explication: "l'heure affichée" },
    { difference: "`route:/api/contacts`", explication: "l'identifiant de démo" },
    { difference: "page:/:mobile", explication: "  " },
  ] }
  assert.deepEqual(differencesNonExpliquees({ marqueurs: m, verdict }), ["page:/:mobile"], "une explication vide n'explique rien")
  assert.deepEqual(differencesNonExpliquees({ marqueurs: { REFONTE_IDS: "page:/x:bureau" }, verdict: null }), [], "sans comparaison, rien n'est conclu ici")
  assert.deepEqual(idsRefonte({ REFONTE_IDS: "page:/a:bureau  route:/api/b pasunid page:x" }), ["page:/a:bureau", "route:/api/b"])
})

test("refonte : la comparaison passe la tâche et le texte ; la consigne demande d'arrêter l'application par son port", () => {
  const c = comparerRefonte({ titre: "Réorganiser /contacts", description: "Rien ne change.", criteres: JSON.stringify(["GET /api/contacts renvoie la même liste"]) }).join("\n")
  assert.match(c, /ANCIEN=http:\/\/localhost:4101 NOUVEAU=http:\/\/localhost:4100/)
  for (const nature of ["refonte", "incident"]) assert.match(consigneNature({ cle: "T9", nature }), /arrête-la par son port \(`fuser -k -n tcp 4100`\), jamais par son nom/)
  assert.match(consigneNature({ nature: "refonte" }), /differences_refonte.*part à une personne/s)
  assert.match(consigneNature({ cle: "T9", nature: "incident" }), /T9-incident\.cjs.*crée ses propres données/s)
  assert.equal(consigneNature({ nature: null }), "")
  // Les animations sont coupées, les routes ont un délai, une page que l'ancienne version ne donne pas est « impossible ».
  assert.match(REFONTE_JS, /animations: "disabled", caret: "hide"/)
  assert.match(REFONTE_JS, /AbortSignal\.timeout\(15000\)/)
  assert.match(REFONTE_JS, /@@ REFONTE_IMPOSSIBLES/)
})

// --- Écart 6 : les budgets de l'interface --------------------------------------------------------------
const mesure = (pages, extra = {}) => ({ axe: true, webkit: true, pages, ...extra })
const page = ({ console = [], a11y = [], webkit = [], chargement_ms = 100, mesures = true } = {}) => ({
  console, console_mesure: mesures, a11y: a11y.map((regle) => ({ regle, impact: "serious", elements: 2, aide: "Une aide" })), a11y_mesure: mesures,
  webkit, webkit_mesure: mesures, chargement_ms,
})

test("budgets : une page ne peut pas avoir de nouveau problème ; ses problèmes connus ne refusent rien", () => {
  const connus = { pages: { "/": { console: [cleProbleme("API : 503 sur la tuile 12")], a11y: ["color-contrast"], webkit: [], lent: false } } }
  // La même erreur, à ses chiffres près, et le même défaut : connus, pas de refus. Une page jamais mesurée non plus.
  assert.deepEqual(raisonsBudgets(mesure({ "/": page({ console: ["API : 503 sur la tuile 47"], a11y: ["color-contrast"] }), "/neuve": page({ console: ["x"] }) }), connus), [])
  const r = raisonsBudgets(mesure({ "/": page({ console: ["API : 503 sur la tuile 47", "TypeError: x is undefined"], a11y: ["color-contrast", "image-alt"], webkit: ["Erreur WebKit"] }) }), connus)
  assert.equal(r.length, 3)
  assert.match(r[0], /\/ a 1 nouvelle\(s\) erreur\(s\) dans la console du navigateur : « TypeError: x is undefined »/)
  assert.match(r[1], /1 nouveau\(x\) défaut\(s\) d'accessibilité graves : image-alt \(Une aide, 2 élément\(s\)\)/)
  assert.match(r[2], /WebKit \(le moteur de Safari\)/)
  // Une page en erreur HTTP n'est pas mesurée.
  assert.deepEqual(raisonsBudgets(mesure({ "/": { ...page({ console: ["y"] }), ignoree: "HTTP 404" } }), connus), [])
})

test("budgets : ce qui n'a pas été mesuré ne compte ni pour zéro ni pour un refus", () => {
  const connus = { pages: { "/": { console: [], a11y: ["region"], webkit: ["a"], lent: false } } }
  // WebKit en panne, axe absent : leurs listes vides ne refusent rien et ne changent pas ce qui est connu.
  const sans = mesure({ "/": { ...page({ console: [] }), a11y_mesure: false, webkit_mesure: false } }, { axe: false, webkit: false })
  assert.deepEqual(raisonsBudgets(sans, connus), [])
  assert.deepEqual(connusApres(sans, connus).pages["/"], { console: [], a11y: ["region"], webkit: ["a"], lent: false })
  // Une métrique jamais mesurée jusqu'ici ne refuse pas sa première mesure.
  assert.deepEqual(raisonsBudgets(mesure({ "/": page({ a11y: ["image-alt"] }) }), { pages: { "/": { console: [] } } }), [])
})

test("budgets : le chargement lent est un problème comme un autre ; le plafond se règle", () => {
  assert.equal(chargementMax({}), 5000)
  assert.equal(chargementMax({ autonomie: { chargement_max_ms: 8000 } }), 8000)
  assert.equal(chargementMax({ autonomie: { chargement_max_ms: 10 } }), 500)
  const connus = { pages: { "/rapide": { console: [], lent: false }, "/lente": { console: [], lent: true } } }
  const r = raisonsBudgets(mesure({ "/rapide": page({ chargement_ms: 7200 }), "/lente": page({ chargement_ms: 9000 }) }), connus, { max: 5000 })
  assert.deepEqual(r, ["budget de l'interface : /rapide se charge maintenant en 7.2 s (au plus 5.0 s)"])
})

test("budgets : à la fusion, ce qu'une tâche a mesuré rejoint les problèmes connus ; jamais avant", () => {
  const avant = { pages: { "/": { console: ["a"], a11y: ["region"], webkit: [], lent: false } } }
  const apres = connusApres(mesure({ "/": page({ console: ["b"], a11y: ["region"] }), "/neuve": page({ webkit: ["w"] }), "/cassee": { ...page(), ignoree: "HTTP 500" } }), avant)
  assert.deepEqual(apres, { pages: {
    "/": { console: ["a", "b"], a11y: ["region"], webkit: [], lent: false },
    "/neuve": { console: [], a11y: [], webkit: ["w"], lent: false },
  } })
  const dossier = mkdtempSync(join(tmpdir(), "budgets-"))
  try {
    const db = ouvrirDb(join(dossier, "usine.db"))
    ouvrirCouts(db)
    assert.deepEqual(lireConnus(db, 7), { pages: {} })
    ecrireConnus(db, 7, apres)
    assert.deepEqual(lireConnus(db, 7), apres)
    // La mesure d'une tâche, gardée pour sa fusion ou l'acceptation d'une personne, se reprend une seule fois.
    gardeMesure(db, 42, mesure({ "/": page() }))
    assert.ok(reprendreMesure(db, 42).pages["/"])
    assert.equal(reprendreMesure(db, 42), null)
    db.close()
  } finally {
    rmSync(dossier, { recursive: true, force: true })
  }
  // La vérification ne l'écrit jamais : la fabrique à la fusion, l'escalade quand une personne accepte la PR.
  assert.doesNotMatch(source("verification.mjs"), /ecrireConnus/)
  assert.match(source("fabrique.mjs"), /if \(v\.mesureBudgets\) ecrireConnus\(db, projet\.id, connusApres\(v\.mesureBudgets, lireConnus\(db, projet\.id\), \{ max: chargementMax\(config\) \}\)\)/)
  assert.match(source("escalade.mjs"), /const mesure = reprendreMesure\(db, tache\.id\)\n {6}if \(mesure\) ecrireConnus\(/)
})

test("budgets : le résumé de la PR dit ce qui n'a pas été mesuré", () => {
  assert.match(resumeBudgets(mesure({ "/": page({ console: ["e"], a11y: ["x", "y"], chargement_ms: 1500 }), "/b": page({ webkit: ["1", "2", "3"], chargement_ms: 400 }) })), /^2 page\(s\) mesurée\(s\) : 1 erreur\(s\) de console, 2 défaut\(s\) d'accessibilité graves, 3 erreur\(s\) dans WebKit, chargement le plus lent 1\.5 s$/)
  assert.match(resumeBudgets({ axe: false, webkit: false, pages: { "/": page() } }), /accessibilité non mesurée \(axe-core absent\), WebKit indisponible/)
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
    assert.match(BUDGETS_JS, /const page = await contexte\.newPage\(\)/, "une page neuve par adresse")
    assert.match(BUDGETS_JS, /waitUntil: "load"/, "pas d'attente sans fin d'un réseau calme")
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
