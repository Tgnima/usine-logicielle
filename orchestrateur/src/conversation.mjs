// Répondre dans le fil d'un projet, comme dans une conversation. Le message est
// aiguillé selon le moment du projet :
//   - une décision attendue (escalade)   -> « A », « B », « C », ou une consigne (= A)
//   - des questions de l'analyste        -> ses réponses
//   - un plan à valider                  -> une correction du plan
//   - un produit livré ou en production  -> une demande de correction (l'analyste enquête)
//   - pendant la fabrication             -> une remarque transmise aux agents des tâches suivantes
import { noter, obtenir } from "./db.mjs"
import { corrigerPlan, repondreQuestions } from "./pipeline.mjs"
import { demanderCorrections } from "./livraison.mjs"
import { lireReponse, resoudre } from "./escalade.mjs"

export async function repondreDansLeFil(ctx, projetId, texte, par) {
  const { db } = ctx
  const projet = obtenir(db, "projets", projetId)
  if (!projet || !texte.trim()) return null

  const escalade = db.prepare("SELECT * FROM escalades WHERE projet_id = ? AND statut = 'ouverte' ORDER BY id DESC LIMIT 1").get(projetId)
  if (escalade) {
    const r = lireReponse(texte, JSON.parse(escalade.options).map((o) => o.cle))
    if (r) {
      const res = await resoudre(ctx, escalade.id, { ...r, par })
      return res.ok ? null : res.message
    }
  }
  switch (projet.statut) {
    case "questions":
      return (await repondreQuestions(ctx, projetId, texte, par)).ok ? ":speech_balloon: Réponses transmises à l'analyste, il reprend le plan." : null
    case "plan_a_valider":
      return (await corrigerPlan(ctx, projetId, texte, par)).ok ? ":memo: Correction du plan transmise à l'analyste." : null
    case "livre":
    case "en_production":
      demanderCorrections(ctx, projetId, texte, par).catch((e) => console.error(e))
      return null // demanderCorrections répond elle-même dans le fil
    case "analyse":
    case "corrections":
      return ":hourglass_flowing_sand: L'analyste travaille déjà sur ce projet : renvoie ton message quand il aura répondu."
    case "creation":
    case "fabrication":
    case "bloque":
      // Les décisions sont relues par chaque agent avant sa tâche (consigne de fabrique.mjs).
      db.prepare("INSERT INTO decisions (projet_id, question, reponse, par) VALUES (?, ?, ?, ?)").run(projetId, "Remarque", texte, par)
      noter(db, { projet: projetId, type: "remarque", message: `${par} : ${texte}` })
      return ":memo: Noté : les agents en tiendront compte dans les tâches suivantes. Pour changer le plan lui-même, attends la livraison et demande une correction."
    default:
      return `Ce projet est « ${projet.statut} » : il n'attend pas de réponse.`
  }
}
