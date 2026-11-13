// Les versions de l'usine : une étiquette « vX.Y.Z » sur GitHub est une version publiée.
//
// Le canal (CANAL_USINE dans .env) dit ce que le bouton « Mettre à jour l'usine » propose :
//   stable (par défaut) : la dernière version publiée, éprouvée avant d'être étiquetée ;
//   main                : chaque fusion, dès qu'elle arrive (le serveur de test de l'équipe).

export const CANAUX = ["stable", "main"]
export const canal = (valeur) => (CANAUX.includes(valeur) ? valeur : "stable")

const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/

// La plus haute version parmi des étiquettes ; les autres étiquettes (« v2-essai ») sont ignorées.
export function derniereVersion(etiquettes) {
  const versions = etiquettes.map((e) => String(e).trim()).filter((e) => VERSION.test(e))
  versions.sort((a, b) => {
    const [x, y] = [a, b].map((v) => VERSION.exec(v).slice(1).map(Number))
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  })
  return versions.at(-1) ?? null
}
