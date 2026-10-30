// Ce que la console et Slack montrent d'un projet : phases, questions à choix, décisions.
import { test } from "node:test"
import assert from "node:assert/strict"
import { attendDecision, etapeTache, ETAPES_TACHE, normaliserQuestions, phase, presenterDecision, reponsesEnTexte } from "../src/presentation.mjs"
import { ecartsEnCorrections, propositionsRecette } from "../src/recette.mjs"

const plan = { lots: [{ nom: "a", taches: [] }, { nom: "b", taches: [] }] }

test("la ligne de vie : chaque statut tombe dans une des cinq phases", () => {
  assert.equal(phase({ statut: "questions" }).cle, "comprendre")
  assert.equal(phase({ statut: "plan_a_valider", plan }).cle, "planifier")
  assert.equal(phase({ statut: "corrections", plan }).cle, "fabriquer")
  assert.equal(phase({ statut: "livre", plan }).cle, "recette")
  assert.equal(phase({ statut: "en_production", plan }).index, 4)
  // Un projet en échec ou arrêté garde la phase où il en était.
  assert.equal(phase({ statut: "echec" }).cle, "comprendre")
  assert.equal(phase({ statut: "echec", plan, lot_livre: 0 }).cle, "planifier")
  assert.equal(phase({ statut: "arrete", plan, lot_livre: 1 }).cle, "fabriquer")
  assert.equal(phase({ statut: "arrete", plan, lot_livre: 2 }).etat, "Arrêté")
})

test("l'usine attend l'humain sur une décision, des questions, un plan, une livraison", () => {
  assert.equal(attendDecision("fabrication", 1).quoi, "decision")
  assert.equal(attendDecision("questions").oui, true)
  assert.equal(attendDecision("plan_a_valider").quoi, "plan")
  assert.equal(attendDecision("fabrication").oui, false)
})

test("les questions : anciennes (phrases) et nouvelles (options) deviennent la même forme", () => {
  const q = normaliserQuestions([
    "Pour qui ?",
    { question: "Quelle adresse ?", options: ["Commune", { libelle: "Par commercial", detail: "plus personnel" }, ""], recommande: 0 },
    { question: "Hors limites", options: ["a"], recommande: 5 },
    { question: "" },
  ])
  assert.equal(q.length, 3)
  assert.deepEqual(q[0], { question: "Pour qui ?", options: [], recommande: null })
  assert.deepEqual(q[1].options, [{ libelle: "Commune", detail: "" }, { libelle: "Par commercial", detail: "plus personnel" }])
  assert.equal(q[1].recommande, 0)
  assert.equal(q[2].recommande, null, "une recommandation hors des options est ignorée")
})

test("les réponses partent en texte pour l'analyste : option, texte libre ou son choix", () => {
  const questions = [
    { question: "Quelle adresse ?", options: ["Commune", "Par commercial"], recommande: 1 },
    { question: "Quel nom ?", options: [] },
    { question: "Quelle couleur ?", options: ["Bleu", "Vert"], recommande: 0 },
  ]
  const t = reponsesEnTexte(questions, [{ option: 0 }, { libre: "Prospecta" }, { auChoix: true }])
  assert.match(t, /Quelle adresse \?\n→ Commune/)
  assert.match(t, /Quel nom \?\n→ Prospecta/)
  assert.match(t, /au choix de l'analyste \(il recommandait : Bleu\)/)
  // Un texte unique (réponse dans le fil) suit la liste des questions.
  assert.match(reponsesEnTexte(["Pour qui ?"], "les commerciaux"), /1\. Pour qui \?\n→ les commerciaux/)
})

test("une décision : la recommandée en premier, chaque option dit sa conséquence", () => {
  const options = [{ cle: "A", libelle: "Réessayer", detail: "" }, { cle: "B", libelle: "Accepter en l'état", detail: "" }, { cle: "C", libelle: "Abandonner", detail: "" }]
  const d = presenterDecision({ raison: "criteres", raisonTexte: "r", options, tache: { titre: "Ciblage", retours: "- le filtre par date ne s'applique pas\n- 2 tests échouent\n\n- trois\n- quatre" } })
  assert.equal(d.recommande, "A")
  assert.equal(d.options[0].cle, "A")
  assert.ok(d.options[0].recommande)
  assert.match(d.options.find((o) => o.cle === "B").consequence, /ajoutée telle quelle/)
  assert.match(d.options.find((o) => o.cle === "C").consequence, /continuent sans elle/)
  assert.deepEqual(d.vu, ["le filtre par date ne s'applique pas", "2 tests échouent", "trois"])
  // Le budget est un choix de la personne : pas de recommandation.
  const b = presenterDecision({ raison: "cout", raisonTexte: "r", options: [{ cle: "A", libelle: "Continuer", detail: "relever le budget" }] })
  assert.equal(b.recommande, null)
  assert.equal(b.options[0].consequence, "Relever le budget.")
})

test("les étapes d'une tâche suivent l'ordre de la machine", () => {
  assert.equal(ETAPES_TACHE.length, 6)
  assert.equal(etapeTache("en_cours"), 0)
  assert.equal(ETAPES_TACHE[etapeTache("verification")], "Essayé comme un visiteur")
  assert.equal(etapeTache("fusionnee"), 6)
})

test("la suite de la recette : on garde les points cochés et on ajoute une demande", () => {
  const recette = {
    persona: "Commerçant",
    scenarios: [{ titre: "Relancer", tenu: false, ecart: "pas de rappel" }, { titre: "Importer", tenu: true }],
    pyramide: [
      { nom: "Fonctionnel", note: 9 }, { nom: "Fiable", note: 8 }, { nom: "Utilisable", note: 7 },
      { nom: "Pratique", note: 5, pour_monter: "moins de clics" }, { nom: "Agréable", note: 4, pour_monter: "un écran vide accueillant" }, { nom: "Qui a du sens", note: 3, pour_monter: "montrer le progrès" },
    ],
  }
  const points = propositionsRecette(recette)
  assert.equal(points.length, 4)
  assert.equal(ecartsEnCorrections(recette), ecartsEnCorrections(recette, {}), "sans choix, rien ne change")
  const t = ecartsEnCorrections(recette, { garder: [1], ajout: "Un export CSV" })
  assert.doesNotMatch(t, /Relancer/, "le paragraphe des écarts disparaît s'il n'a plus de point")
  assert.match(t, /- Pratique \(5\/10\) : moins de clics/)
  assert.doesNotMatch(t, /Agréable/)
  assert.match(t, /- Un export CSV$/)
})
