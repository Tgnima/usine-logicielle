// Ce que la console et Slack montrent d'un projet, en langage produit : la phase où il en
// est, s'il attend une décision humaine, les questions de l'analyste avec leurs options,
// et pour chaque décision la recommandation de l'usine et la conséquence de chaque choix.
// Des fonctions pures : aucune décision n'est prise ici, on ne fait que présenter.

// --- La ligne de vie ------------------------------------------------------------------

export const PHASES = [
  { cle: "comprendre", nom: "Comprendre" },
  { cle: "planifier", nom: "Planifier" },
  { cle: "fabriquer", nom: "Fabriquer" },
  { cle: "recette", nom: "Recette" },
  { cle: "en_ligne", nom: "En ligne" },
]

// Le statut technique → la phase, et ce qu'on en dit en une ligne.
const PAR_STATUT = {
  analyse: ["comprendre", "L'analyste étudie la demande"],
  questions: ["comprendre", "L'analyste a des questions"],
  plan_a_valider: ["planifier", "Le plan attend ta validation"],
  reorientation: ["planifier", "L'analyste refait la suite du plan"],
  creation: ["fabriquer", "Préparation du dépôt et du socle"],
  fabrication: ["fabriquer", "Fabrication en cours"],
  corrections: ["fabriquer", "Un lot de corrections est en cours"],
  bloque: ["fabriquer", "Fabrication arrêtée sur une décision"],
  livre: ["recette", "Prêt à mettre en ligne"],
  mise_en_production: ["en_ligne", "Mise en ligne en cours"],
  en_production: ["en_ligne", "En ligne"],
}

// La phase d'un projet. Un projet en échec, arrêté ou abandonné garde la phase où il en était
// (d'après son plan et ses lots livrés), avec un état qui le dit.
export function phase({ statut, plan = null, lot_livre = 0, lots = 0 }) {
  const connu = PAR_STATUT[statut]
  let cle = connu?.[0]
  if (!cle) cle = !plan?.lots?.length ? "comprendre" : lot_livre && lot_livre >= (lots || plan.lots.length) ? "recette" : lot_livre ? "fabriquer" : "planifier"
  const index = PHASES.findIndex((p) => p.cle === cle)
  const etat = connu?.[1] ?? { echec: "En échec", arrete: "Arrêté", abandonne: "Abandonné" }[statut] ?? statut
  return { cle, nom: PHASES[index].nom, index, etat }
}

// L'usine attend-elle l'humain ? (le seul signal qui compte pour lui)
export function attendDecision(statut, escaladesOuvertes = 0) {
  if (escaladesOuvertes > 0) return { oui: true, quoi: "decision" }
  if (statut === "questions") return { oui: true, quoi: "questions" }
  if (statut === "plan_a_valider") return { oui: true, quoi: "plan" }
  if (statut === "livre") return { oui: true, quoi: "livre" }
  if (statut === "echec") return { oui: true, quoi: "echec" }
  return { oui: false, quoi: null }
}

// --- Les questions de l'analyste --------------------------------------------------------

// L'analyste rend ses questions en objets ({ question, options, recommande }) ; les plans plus
// anciens, en simples phrases. Les deux formes deviennent la même.
export function normaliserQuestions(questions) {
  return (Array.isArray(questions) ? questions : []).map((q) => {
    if (typeof q === "string") return { question: q, options: [], recommande: null }
    const options = (Array.isArray(q?.options) ? q.options : [])
      .map((o) => (typeof o === "string" ? { libelle: o, detail: "" } : { libelle: String(o?.libelle ?? ""), detail: String(o?.detail ?? "") }))
      .filter((o) => o.libelle.trim())
      .slice(0, 4)
    const r = Number.isInteger(q?.recommande) && q.recommande >= 0 && q.recommande < options.length ? q.recommande : null
    return { question: String(q?.question ?? ""), options, recommande: r }
  }).filter((q) => q.question.trim())
}

export const texteQuestion = (q) => (typeof q === "string" ? q : String(q?.question ?? ""))

// Les réponses, mises en texte pour l'analyste. Une réponse par question : le libellé de
// l'option choisie, un texte libre, ou « au choix de l'analyste » (on lui rappelle alors son
// option recommandée). Un texte unique (réponse dans le fil) suit la liste des questions.
export function reponsesEnTexte(questions, reponses) {
  const qs = normaliserQuestions(questions)
  if (!Array.isArray(reponses)) return `${qs.map((q, i) => `${i + 1}. ${q.question}`).join("\n")}\n→ ${reponses}`
  return qs.map((q, i) => {
    const r = reponses[i]
    let texte
    if (r && typeof r === "object") {
      if (r.libre) texte = String(r.libre)
      else if (Number.isInteger(r.option) && q.options[r.option]) texte = q.options[r.option].libelle
      else if (r.auChoix) texte = q.recommande !== null ? `au choix de l'analyste (il recommandait : ${q.options[q.recommande].libelle})` : "au choix de l'analyste"
      else texte = ""
    } else texte = String(r ?? "")
    return `${q.question}\n→ ${texte || "(pas de réponse)"}`
  }).join("\n")
}

// --- Les décisions (escalades) ----------------------------------------------------------

// La recommandation de l'usine, par du code : selon la raison, pas selon un modèle.
// Le budget et la durée sont des choix de la personne : pas de recommandation.
const RECOMMANDATIONS = {
  criteres: ["A", "Deux méthodes n'ont pas suffi. Une consigne de ta part donne à l'agent ce qui lui manque, sans perdre le travail fait."],
  verificateur: ["A", "Le contrôle n'a pas pu juger la fonction : c'est l'outil de contrôle qui a échoué, pas forcément le code. On réessaie avant de trancher."],
  infrastructure: ["A", "Un problème d'infrastructure, pas de code : un nouvel essai une fois le problème passé."],
  livraison: ["A", "Le déploiement de l'aperçu a échoué ; le code est déjà fusionné, il suffit de redéployer."],
}

// La décision prête à afficher : ce qui bloque en une phrase, ce que le contrôle a vu,
// la recommandation et la conséquence de chaque option.
export function presenterDecision({ raison, raisonTexte, options, tache = null }) {
  const nom = tache?.titre ? `« ${tache.titre} »` : "cette fonction"
  const [recommande, pourquoi] = RECOMMANDATIONS[raison] ?? [null, null]
  const consequence = (o) => {
    if (raison === "criteres" || raison === "verificateur" || raison === "infrastructure") {
      if (o.cle === "A") return `L'usine reprend ${nom}${raison === "criteres" ? " avec ta consigne, en priorité" : ""}.`
      if (o.cle === "B") return `${nom[0].toUpperCase()}${nom.slice(1)} est ajoutée telle quelle, bien que le contrôle l'ait refusée.`
      if (o.cle === "C") return `${nom[0].toUpperCase()}${nom.slice(1)} est retirée du plan ; les fonctions qui en dépendent continuent sans elle.`
    }
    return o.detail ? `${o.detail[0].toUpperCase()}${o.detail.slice(1)}.` : ""
  }
  const titre = {
    criteres: tache ? `${tache.titre} : le contrôle la refuse encore` : "Une fonction est refusée par le contrôle",
    verificateur: tache ? `${tache.titre} : le contrôle n'a pas pu juger` : "Le contrôle n'a pas pu juger",
    infrastructure: "Un problème d'infrastructure bloque la fabrication",
    livraison: "L'aperçu n'a pas pu être mis en ligne",
    cout: "Le budget du projet est atteint",
    budget: "La durée maximale du projet est atteinte",
  }[raison] ?? `Décision attendue${tache ? ` sur ${tache.titre}` : ""}`
  // Ce que le contrôle a vu : les premiers motifs du dernier refus, sans le détail technique.
  const vu = String(tache?.retours ?? "").split("\n").map((l) => l.replace(/^[-•*\s]+/, "").trim()).filter(Boolean).slice(0, 3)
  const opts = options.map((o) => ({ ...o, consequence: consequence(o), recommande: o.cle === recommande }))
  // L'option recommandée vient en premier.
  opts.sort((a, b) => Number(b.recommande) - Number(a.recommande))
  return { titre, raison: raisonTexte, vu, recommande, pourquoi, options: opts }
}

// --- La fabrication racontée ---------------------------------------------------------------

// Les étapes d'une tâche, nommées pour l'utilisateur, dans l'ordre de la machine : agent,
// contrôle local, relecture sécurité, vérificateur, relecture design, fusion.
export const ETAPES_TACHE = ["Écrit", "Testé", "Relu (sécurité)", "Essayé comme un visiteur", "Relu (design)", "Ajouté au produit"]

export function etapeTache(statut) {
  if (statut === "fusionnee") return ETAPES_TACHE.length
  if (statut === "verification") return 3
  if (statut === "en_cours") return 0
  return -1
}
