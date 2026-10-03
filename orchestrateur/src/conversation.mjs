// Répondre dans le fil d'un projet, comme dans une conversation. Le message est
// aiguillé selon le moment du projet :
//   - une décision attendue (escalade)   -> « A », « B », « C », ou une consigne (= A)
//   - des questions de l'analyste        -> ses réponses
//   - un plan à valider                  -> une correction du plan
//   - un produit livré ou en production  -> une demande de correction (l'analyste enquête)
//   - pendant la fabrication             -> mise en file, envoyée à l'analyste à la fin du lot
import { noter, obtenir } from "./db.mjs"
import { corrigerPlan, repondreQuestions } from "./pipeline.mjs"
import { demanderCorrections, mettreEnFile } from "./livraison.mjs"
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
    case "creation":
    case "fabrication":
    case "bloque": {
      // Pendant la fabrication : la demande attend la fin du lot, puis part seule chez l'analyste.
      const n = mettreEnFile(db, projetId, texte, par)
      noter(db, { projet: projetId, type: "remarque", message: `En file (${n}) : ${par} : ${texte}` })
      return `:inbox_tray: Bien reçu. La fabrication est en cours : ta demande ${n > 1 ? `(${n} en attente) ` : ""}partira automatiquement chez l'analyste dès la fin du lot, sans que tu aies à la renvoyer.`
    }
    default:
      return `Ce projet est « ${projet.statut} » : il n'attend pas de réponse.`
  }
}
