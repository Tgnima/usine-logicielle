// Ce qui se passe au démarrage du serveur (jamais dans les tests, qui utilisent
// creerApp() directement) :
//   - les erreurs vers Sentry et le pouls vers PostHog (server/observabilite.js), d'abord :
//     une erreur pendant le remplissage de démo part aussi ;
//   - en mode démo (DEMO=1) et si la base est vide, la remplir de données fictives ;
//   - lancer les tâches de fond (un planificateur d'envois, par exemple).
// Ce fichier est fait pour être complété par les tâches : appelle ici tes
// fonctions de server/actions/, ne mets pas la logique elle-même.
import { demarrerObservabilite } from "./observabilite.js"

export async function auDemarrage() {
  demarrerObservabilite()
  // Les compteurs métier du pouls (toutes les 5 min) : des nombres seulement, jamais un texte,
  // un nom ou une adresse. Exemple, avec ajouterPouls importé de ./observabilite.js :
  //   ajouterPouls(() => ({ envois_en_attente: compterEnvoisEnAttente() }))
  if (process.env.DEMO === "1") {
    // Exemple : if (compterContacts() === 0) semerContactsDemo()
  }
  // Exemple : setInterval(() => traiterEnvois(maintenant()).catch(console.error), 5_000).unref()
}
