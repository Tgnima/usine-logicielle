// L'heure du produit. En mode démo, le temps peut s'écouler plus vite
// (DEMO_VITESSE_HORLOGE=1440 : un jour passe en une minute), pour montrer en
// quelques minutes ce qui prend des jours (relances, échéances…).
// Toujours passer par maintenant() plutôt que Date.now() pour la logique métier.
const depart = Date.now()
const vitesse = () => Math.max(1, Number(process.env.DEMO_VITESSE_HORLOGE ?? 1))

export function maintenant() {
  return new Date(depart + (Date.now() - depart) * vitesse())
}

// Combien de millisecondes réelles pour une durée « produit ».
export function dureeReelle(msProduit) {
  return msProduit / vitesse()
}
