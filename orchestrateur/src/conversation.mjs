// Répondre dans le fil d'un projet, comme dans une conversation. Le message est
// aiguillé selon le moment du projet :
//   - une décision attendue (escalade)   -> « A », « B », « C », ou une consigne (= A)
//   - des questions de l'analyste        -> ses réponses
//   - un plan à valider                  -> une correction du plan
//   - un produit livré ou en production  -> une demande de correction (l'analyste enquête)
//   - pendant la fabrication             -> mise en file, envoyée à l'analyste à la livraison
//                                           (ou tout de suite avec une réorientation)
import { noter, obtenir } from "./db.mjs"
import { corrigerPlan, repondreQuestions } from "./pipeline.mjs"
import { demanderCorrections, mettreEnFile } from "./livraison.mjs"
import { lireReponse, resoudre } from "./escalade.mjs"

export async function repondreDansLeFil(ctx, projetId, texte, par) {
  const { db } = ctx
  const projet = obtenir(db, "projets", projetId)
  if (!projet || !texte.trim()) return null

  const choix = choisirEscalade(db, projetId, texte)
  if (choix?.ambigu) return choix.ambigu
  if (choix) {
    const r = lireReponse(choix.texte, JSON.parse(choix.escalade.options).map((o) => o.cle))
    if (r) {
      const res = await resoudre(ctx, choix.escalade.id, { ...r, par })
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
    case "reorientation":
      return ":twisted_rightwards_arrows: Ce projet est en réorientation : l'analyste refait la suite du plan. Tu pourras le corriger en répondant ici dès qu'il arrive."
    case "analyse":
    case "corrections":
    case "creation":
    case "fabrication":
    case "bloque": {
      // Pendant la fabrication : la demande attend que tous les lots soient livrés, puis part
      // seule chez l'analyste. Pour changer de direction sans attendre : la réorientation.
      const n = mettreEnFile(db, projetId, texte, par)
      noter(db, { projet: projetId, type: "remarque", message: `En file (${n}) : ${par} : ${texte}` })
      return `:inbox_tray: Bien reçu. La fabrication est en cours : ta demande ${n > 1 ? `(${n} en attente) ` : ""}partira automatiquement chez l'analyste quand tous les lots seront livrés, sans que tu aies à la renvoyer.\nPour changer de direction maintenant : \`/usine reorienter ${projetId} : <la nouvelle direction>\` (ou « Changer de direction » dans la console). La fabrication s'arrête après la tâche en cours et l'analyste refait la suite du plan ; ta demande part avec.`
    }
    default:
      return `Ce projet est « ${projet.statut} » : il n'attend pas de réponse.`
  }
}

// Plusieurs décisions peuvent attendre en même temps (une tâche bloquée, la durée du projet…) :
// une réponse sans précision ne doit pas partir sur la mauvaise. On demande laquelle, et on
// accepte « T30 A … », « budget A », « coût A » ou « #4 A ».
const NOMS = { budget: "la durée du projet", cout: "le budget du projet", livraison: "le déploiement de l'aperçu", verificateur: "le vérificateur", infrastructure: "l'infrastructure" }
export function choisirEscalade(db, projetId, texte) {
  const ouvertes = db.prepare("SELECT e.*, t.cle AS tache FROM escalades e LEFT JOIN taches t ON t.id = e.tache_id WHERE e.projet_id = ? AND e.statut = 'ouverte' ORDER BY e.id").all(projetId)
  if (!ouvertes.length) return null
  if (ouvertes.length === 1) return { escalade: ouvertes[0], texte }
  const m = String(texte).trim().match(/^(T\d+|budget|durée|duree|co[uû]t|livraison|#\d+)(?=$|[\s:,.—–-])[\s:,.—–-]*/i)
  if (m) {
    const cle = m[1].toLowerCase()
    const e = ouvertes.find((x) => (x.tache && x.tache.toLowerCase() === cle) || `#${x.id}` === cle
      || (["budget", "durée", "duree"].includes(cle) && x.raison === "budget") || (/^co[uû]t$/.test(cle) && x.raison === "cout") || (cle === "livraison" && x.raison === "livraison"))
    if (e) return { escalade: e, texte: String(texte).trim().slice(m[0].length) }
  }
  const ligne = (e) => e.tache ? `• *${e.tache}* (${e.raison === "criteres" ? "critères non tenus" : e.raison}) : réponds « ${e.tache} A … », « ${e.tache} B » ou « ${e.tache} C »` : `• *${NOMS[e.raison] ?? e.raison}* : réponds « ${e.raison === "cout" ? "coût" : e.raison === "budget" ? "budget" : `#${e.id}`} A » ou « … C »`
  return { ambigu: `:point_up: ${ouvertes.length} décisions attendent sur ce projet ; précise laquelle :\n${ouvertes.map(ligne).join("\n")}\nTu peux aussi utiliser les boutons de chaque message, ou la console.` }
}
