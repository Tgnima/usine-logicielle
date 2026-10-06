// Les règles codées de l'usine : ce sont elles, pas les modèles, qui décident.
import { test } from "node:test"
import assert from "node:assert/strict"
import { porte, pathspec } from "../src/verification.mjs"
import { verifierPlan, extraireJson } from "../src/analyste.mjs"
import { lireReponse, options } from "../src/escalade.mjs"
import { liberer } from "../src/fabrique.mjs"
import { ouvrirDb, taches } from "../src/db.mjs"

const tout = { INSTALL_OK: "", BUILD_OK: "", TESTS_PASSES: "12", TESTS_ECHECS: "0", APP_STARTED: "" }
const approuve = { decision: "approuve", criteres: [{ critere: "la page liste 50 contacts", ok: true, preuve: "50 lignes" }], problemes: [], resume: "ok" }

test("porte : tout est vert, la tâche passe", () => {
  assert.deepEqual(porte({ marqueurs: tout, verdict: approuve, plancher: 10 }), [])
})

test("porte : zéro test n'est jamais un succès", () => {
  assert.match(porte({ marqueurs: { ...tout, TESTS_PASSES: "0" }, verdict: approuve }).join(), /zéro test/)
})

test("porte : le cliquet refuse une baisse du nombre de tests", () => {
  assert.match(porte({ marqueurs: tout, verdict: approuve, plancher: 15 }).join(), /a baissé/)
})

test("porte : un test qui échoue, un build cassé, une app qui ne démarre pas", () => {
  assert.match(porte({ marqueurs: { ...tout, TESTS_ECHECS: "1" }, verdict: approuve }).join(), /échouent/)
  const { BUILD_OK, ...sansBuild } = tout
  assert.match(porte({ marqueurs: sansBuild, verdict: approuve }).join(), /build/)
  const { APP_STARTED, ...sansApp } = tout
  assert.match(porte({ marqueurs: sansApp, verdict: approuve }).join(), /ne démarre pas/)
})

test("porte : un critère non observé suffit à refuser, même si le modèle « approuve »", () => {
  const v = { ...approuve, criteres: [...approuve.criteres, { critere: "export CSV", ok: false, preuve: "404" }] }
  assert.match(porte({ marqueurs: tout, verdict: v }).join(), /export CSV/)
})

test("porte : pas de verdict, verdict sans critère, refus sans motif", () => {
  assert.match(porte({ marqueurs: tout, verdict: null }).join(), /verdict lisible/)
  assert.match(porte({ marqueurs: tout, verdict: { ...approuve, criteres: [] } }).join(), /aucun critère/)
  assert.match(porte({ marqueurs: tout, verdict: { ...approuve, decision: "refuse" } }).join(), /refuse/)
})

test("pathspec : motifs glob et chemins simples", () => {
  assert.equal(pathspec(["Dockerfile", ".usine/**"]), "'Dockerfile' ':(glob).usine/**'")
})

const planValide = {
  nom: "Prospect", slug: "prospect", resume: "…",
  lots: [{ nom: "Socle", objectif: "…", taches: [
    { cle: "T1", titre: "a", description: "b", criteres: ["c"], depend_de: [] },
    { cle: "T2", titre: "a", description: "b", criteres: ["c"], depend_de: ["T1"] },
  ] }],
}

test("verifierPlan : un plan valide, et ses défauts", () => {
  assert.deepEqual(verifierPlan(planValide), [])
  assert.match(verifierPlan({ ...planValide, slug: "Pas Bon" }).join(), /slug/)
  const avant = structuredClone(planValide)
  avant.lots[0].taches[0].depend_de = ["T2"]
  assert.match(verifierPlan(avant).join(), /T1 dépend de T2/)
  const sansCritere = structuredClone(planValide)
  sansCritere.lots[0].taches[1].criteres = []
  assert.match(verifierPlan(sansCritere).join(), /aucun critère/)
  assert.deepEqual(verifierPlan({ questions: ["Pour qui ?"], lots: [] }), [])
})

test("extraireJson : JSON entouré de texte ou de ```", () => {
  assert.deepEqual(extraireJson('Voici :\n```json\n{"a": {"b": 1}}\n```'), { a: { b: 1 } })
})

test("lireReponse : lettre, lettre + consigne, texte libre", () => {
  assert.deepEqual(lireReponse("A", ["A", "B", "C"]), { choix: "A", texte: "" })
  assert.deepEqual(lireReponse("**b**", ["A", "B", "C"]), { choix: "B", texte: "" })
  assert.deepEqual(lireReponse("c - trop long", ["A", "C"]), { choix: "C", texte: "trop long" })
  assert.deepEqual(lireReponse("Utilise une table séparée", ["A", "C"]), { choix: "A", texte: "Utilise une table séparée" })
  assert.equal(lireReponse("B", ["A", "C"])?.choix, "A") // B indisponible : lu comme consigne libre
})

test("options : « accepter en l'état » seulement s'il y a une PR à fusionner", () => {
  assert.deepEqual(options("criteres", true).map((o) => o.cle), ["A", "B", "C"])
  assert.deepEqual(options("criteres", false).map((o) => o.cle), ["A", "C"])
  assert.deepEqual(options("budget").map((o) => o.cle), ["A", "C"])
})

test("liberer : une tâche part quand ses dépendances sont fusionnées ou abandonnées", () => {
  const db = ouvrirDb(":memory:")
  db.prepare("INSERT INTO projets (prompt) VALUES ('x')").run()
  const ins = db.prepare("INSERT INTO taches (projet_id, cle, lot, titre, description, criteres, depend_de, statut) VALUES (1, ?, 1, 't', 'd', '[]', ?, ?)")
  ins.run("T1", "[]", "fusionnee")
  ins.run("T2", '["T1"]', "attente")
  ins.run("T3", '["T2"]', "attente")
  ins.run("T4", '["T1"]', "attente")
  db.prepare("UPDATE taches SET statut = 'abandonnee' WHERE cle = 'T4'").run()
  liberer(db, 1)
  const s = Object.fromEntries(taches(db, 1).map((t) => [t.cle, t.statut]))
  assert.deepEqual(s, { T1: "fusionnee", T2: "prete", T3: "attente", T4: "abandonnee" })
})

test("choixProduction : défauts du contrat, choix de la personne, valeurs inconnues ramenées au plus sûr", async () => {
  const { choixProduction } = await import("../src/livraison.mjs")
  const config = { production: { donnees: "demo", emails: "captures", horloge: "acceleree", destinataires_autorises: [] } }
  assert.deepEqual(choixProduction(config), { donnees: "demo", emails: "captures", horloge: "acceleree", acces: "protege", destinataires_autorises: [] })
  const c = choixProduction(config, { emails: "reels" }, { donnees: "vide", destinataires_autorises: "moi@exemple.fr, @equipe.fr, pas-une-adresse" })
  assert.deepEqual(c, { donnees: "vide", emails: "reels", horloge: "acceleree", acces: "protege", destinataires_autorises: ["moi@exemple.fr", "@equipe.fr"] })
  assert.equal(choixProduction(config, { acces: "n'importe quoi" }).acces, "protege") // protégé sauf choix explicite
  assert.equal(choixProduction(config, { emails: "n'importe quoi", donnees: "?" }).emails, "captures")
})

test("aiguiller : sans produit livré, nouveau ; un produit cité par son nom, correction ; sinon on demande", async () => {
  const { aiguiller } = await import("../src/aiguillage.mjs")
  const cle = process.env.AI_GATEWAY_API_KEY
  delete process.env.AI_GATEWAY_API_KEY
  const db = ouvrirDb(":memory:")
  assert.deepEqual(await aiguiller(db, "Une app de réservation"), { type: "nouveau" })
  db.prepare("INSERT INTO projets (prompt, nom, slug, statut) VALUES ('app SDR', 'Prospecta', 'prospecta', 'en_production')").run()
  assert.deepEqual(await aiguiller(db, "Dans Prospecta les mails ne partent pas"), { type: "correction", projetId: 1 })
  assert.equal((await aiguiller(db, "l'ancienne production ne marche pas")).type, "incertain")
  if (cle) process.env.AI_GATEWAY_API_KEY = cle
})

test("porte sécurité : un secret dans le code est toujours refusé", () => {
  assert.match(porte({ marqueurs: { ...tout, SECRETS_TROUVES: "1", SECRETS_FICHIERS: "server/llm.js " }, verdict: approuve }).join(), /secret.*server\/llm\.js/)
})

test("porte sécurité : refus seulement si la PR AJOUTE une faille grave de dépendance", () => {
  assert.deepEqual(porte({ marqueurs: { ...tout, VULN_GRAVES: "2", VULN_GRAVES_MAIN: "2" }, verdict: approuve }), [])
  assert.match(porte({ marqueurs: { ...tout, VULN_GRAVES: "3", VULN_GRAVES_MAIN: "2" }, verdict: approuve }).join(), /ajoute 1 faille/)
  assert.deepEqual(porte({ marqueurs: { ...tout, VULN_GRAVES: "?" }, verdict: approuve }), []) // audit indisponible : pas bloquant
  // En ligne, le code est en lecture seule : une écriture au démarrage empêcherait l'aperçu de démarrer.
  assert.match(porte({ marqueurs: { ...tout, ECRIT_DANS_CODE: "./dist/robots.txt " }, verdict: approuve }).join(), /écrit dans son propre code \(\.\/dist\/robots\.txt\)/)
  assert.deepEqual(porte({ marqueurs: { ...tout, ECRIT_DANS_CODE: "" }, verdict: approuve }), [])
})

test("santé : le pire état l'emporte ; durée de vie d'un aperçu lisible", async () => {
  const { resumeEtat } = await import("../src/sante.mjs")
  assert.equal(resumeEtat([{ etat: "ok" }, { etat: "inconnu" }]), "ok")
  assert.equal(resumeEtat([{ etat: "ok" }, { etat: "alerte" }]), "alerte")
  assert.equal(resumeEtat([{ etat: "alerte" }, { etat: "panne" }]), "panne")
  const { decrireApercu } = await import("../src/cycle.mjs")
  assert.equal(decrireApercu({ lot_livre: 0 }), "—")
  assert.equal(decrireApercu({ lot_livre: 1, apercu_retire: 1 }), "retiré")
  assert.equal(decrireApercu({ lot_livre: 1, apercu_garde: 1 }), "gardé")
  assert.equal(decrireApercu({ lot_livre: 1, apercu_expire_le: new Date(Date.now() + 3.2 * 86_400_000).toISOString() }), "expire dans 3 j")
  assert.equal(decrireApercu({ lot_livre: 1, apercu_expire_le: new Date(Date.now() + 5 * 3600_000).toISOString() }), "expire dans 5 h")
})

test("porte : une régression ou un défaut grave de design refuse la tâche", () => {
  assert.match(porte({ marqueurs: tout, verdict: { ...approuve, regressions: ["contacts-1 : la liste est vide"] } }).join(), /régression.*contacts-1/)
  assert.match(porte({ marqueurs: tout, verdict: approuve, design: { graves: [{ ecran: "contacts (mobile)", defaut: "le tableau déborde", correction: "liste empilée" }], mineurs: [] } }).join(), /design : contacts \(mobile\) : le tableau déborde → liste empilée/)
  assert.deepEqual(porte({ marqueurs: tout, verdict: approuve, design: { graves: [], mineurs: [{ defaut: "espacement" }] } }), [])
})

test("design : brief vérifié, jetons et document produits", async () => {
  const { verifierDesign, jetonsCss, designEnMarkdown } = await import("../src/design.mjs")
  assert.deepEqual(verifierDesign(undefined), [])
  assert.match(verifierDesign({ intention: "x", palette: { primaire: "rouge" } }).join(), /primaire/)
  const design = { intention: "Sobre et précis", palette: { primaire: "#0f766e", accent: "#2563eb", fond: "#f8fafc", surface: "#ffffff", texte: "#0f172a", doux: "#64748b", succes: "#15803d", alerte: "#b45309", danger: "#b91c1c" }, typographie: { titres: "Inter" } }
  assert.deepEqual(verifierDesign(design), [])
  assert.match(jetonsCss(design), /--color-primaire: #0f766e;/)
  assert.match(jetonsCss(design), /--font-titres: "Inter", system-ui/)
  assert.match(designEnMarkdown({ nom: "Essai", design }), /## Grille/)
})

test("suivi : un seul message, avec l'avancement et les 6 dernières étapes", async () => {
  const { ajouterEtape, texteSuivi } = await import("../src/suivi.mjs")
  const { ouvrirCouts } = await import("../src/couts.mjs")
  const db = ouvrirDb(":memory:")
  ouvrirCouts(db)
  db.prepare("INSERT INTO projets (prompt, nom, statut, plan, lot_livre) VALUES ('x', 'Essai', 'fabrication', ?, 0)").run(JSON.stringify({ lots: [{ nom: "Socle", taches: [] }, { nom: "Suite", taches: [] }] }))
  const ins = db.prepare("INSERT INTO taches (projet_id, cle, lot, titre, description, criteres, statut) VALUES (1, ?, 1, ?, 'd', '[]', ?)")
  ins.run("T1", "Liste", "fusionnee")
  ins.run("T2", "Fiche", "verification")
  for (let i = 1; i <= 8; i++) ajouterEtape(db, 1, `étape ${i}`)
  const t = texteSuivi(db, 1)
  assert.match(t, /Fabrication de Essai\* · lot 1\/2 : Socle/)
  assert.match(t, /1\/2 tâches/)
  assert.match(t, /En cours : \*T2\* · Fiche \(en vérification\)/)
  assert.doesNotMatch(t, /étape 2\b/)
  assert.match(t, /étape 8/)
})
