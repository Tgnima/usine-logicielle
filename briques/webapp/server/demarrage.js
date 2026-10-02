// Ce qui se passe au démarrage du serveur (jamais dans les tests, qui utilisent
// creerApp() directement) :
//   - en mode démo (DEMO=1) et si la base est vide, la remplir de données fictives ;
//   - lancer les tâches de fond (un planificateur d'envois, par exemple).
// Ce fichier est fait pour être complété par les tâches : appelle ici tes
// fonctions de server/actions/, ne mets pas la logique elle-même.

export async function auDemarrage() {
  if (process.env.DEMO === "1") {
    // Exemple : if (compterContacts() === 0) semerContactsDemo()
  }
  // Exemple : setInterval(() => traiterEnvois(maintenant()).catch(console.error), 5_000).unref()
}
