// La pyramide de l'expérience (Stephen P. Anderson) : la grille de qualité de l'usine,
// du bas (le produit marche) vers le haut (il compte pour la personne). On ne saute
// pas d'étage : un produit agréable mais peu fiable ne vaut rien.
//
// Entre « Utilisable » et « Pratique » passe le gouffre : la plupart des produits s'arrêtent
// en dessous. L'usine vise au-dessus. La recette note chaque étage sur le produit fini, le
// rapport montre l'étage atteint, et les lots de corrections visent l'étage suivant.

export const NIVEAUX = [
  { cle: "fonctionnel", nom: "Fonctionnel", devise: "marche comme prévu", critere: "chaque parcours va au bout, sans erreur ni page blanche ; les fonctions promises existent vraiment." },
  { cle: "fiable", nom: "Fiable", devise: "disponible et exact", critere: "les données sont justes et cohérentes d'un écran à l'autre, rien ne se perd au rechargement, une erreur est expliquée avec la marche à suivre." },
  { cle: "utilisable", nom: "Utilisable", devise: "s'utilise sans difficulté", critere: "lisible, utilisable sur mobile et au clavier ; chaque écran a ses états vide, chargement et erreur." },
  { cle: "pratique", nom: "Pratique", devise: "marche comme je pense", critere: "l'action principale saute aux yeux en moins de 5 secondes ; le parcours clé tient en 3 actions ou moins ; des valeurs par défaut intelligentes ; aucune aide nécessaire." },
  { cle: "agreable", nom: "Agréable", devise: "un moment qu'on a envie de montrer", critere: "au moins un moment « waouh » sur le parcours clé (résultat immédiat et bien présenté, aperçu en direct, transition soignée, texte qui parle le métier) ; l'accueil donne envie de continuer." },
  { cle: "sens", nom: "Qui a du sens", devise: "compte pour la personne", critere: "le produit montre la valeur obtenue (temps gagné, argent, risque évité, progrès), avec les mots de son utilisateur." },
]

// La note à partir de laquelle un étage est tenu, et le premier étage au-dessus du gouffre.
export const SEUIL = 7
export const GOUFFRE = NIVEAUX.findIndex((n) => n.cle === "pratique")

export const pyramideEnTexte = () => NIVEAUX.map((n, i) => `${i + 1}. ${n.nom} (${n.devise}) : ${n.critere}${i === GOUFFRE - 1 ? "\n   ---- le gouffre : la plupart des produits s'arrêtent ici ----" : ""}`).join("\n")

// Pour l'analyste et les agents : ce que l'usine attend au-dessus du gouffre.
export const REGLE_PYRAMIDE = `Vise au-dessus du gouffre de la pyramide de l'expérience. Les trois premiers étages (fonctionnel, fiable, utilisable) sont le minimum. Ce qui fait la différence :
- Pratique : ${NIVEAUX[3].critere}
- Agréable : ${NIVEAUX[4].critere}
- Qui a du sens : ${NIVEAUX[5].critere}`

// Le schéma que la recette remplit (une entrée par étage, dans l'ordre).
export const SCHEMA_PYRAMIDE = `"pyramide": [${NIVEAUX.map((n) => `{"cle": "${n.cle}", "note": 0, "observe": "…", "pour_monter": "…"}`).join(", ")}]`

const borne = (x) => (Number.isFinite(Number(x)) ? Math.max(0, Math.min(10, Math.round(Number(x)))) : null)

// La réponse du modèle, remise dans l'ordre des étages (null si elle est absente ou vide).
export function normaliserPyramide(brut) {
  if (!Array.isArray(brut) || !brut.length) return null
  const niveaux = NIVEAUX.map((n, i) => {
    const x = brut.find((b) => b?.cle === n.cle) ?? (brut[i]?.cle ? {} : brut[i] ?? {})
    return { cle: n.cle, nom: n.nom, note: borne(x.note), observe: String(x.observe ?? "").slice(0, 400), pour_monter: String(x.pour_monter ?? "").slice(0, 400) }
  })
  return niveaux.some((n) => n.note !== null) ? niveaux : null
}

// L'étage atteint : le plus haut tenu sans trou en dessous (-1 : aucun).
export function etageAtteint(niveaux) {
  let i = -1
  for (const n of niveaux ?? []) {
    if ((n.note ?? 0) < SEUIL) break
    i++
  }
  return i
}

// L'étage à travailler ensuite : le premier qui n'est pas tenu (null : tout est tenu).
export function prochainEtage(niveaux) {
  const i = etageAtteint(niveaux) + 1
  return niveaux && i < niveaux.length ? niveaux[i] : null
}

const barre = (note) => (note === null ? "·····" : "▰".repeat(Math.round(note / 2)) + "▱".repeat(5 - Math.round(note / 2)))

// La pyramide en lignes (du sommet vers la base), pour Slack et le Markdown.
export function pyramideEnLignes(niveaux, { gras = (t) => `*${t}*` } = {}) {
  if (!niveaux) return []
  const atteint = etageAtteint(niveaux)
  const lignes = []
  for (let i = niveaux.length - 1; i >= 0; i--) {
    const n = niveaux[i]
    const texte = `${barre(n.note)} ${n.note ?? "?"}/10 · ${n.nom}`
    lignes.push(`${i <= atteint ? "✅" : "⬜"} ${i === atteint ? gras(texte) : texte}`)
    if (i === GOUFFRE) lignes.push("┄┄┄┄┄ le gouffre ┄┄┄┄┄")
  }
  return lignes
}

// La phrase qui résume : l'étage atteint, et le gouffre franchi ou non.
export function verdictPyramide(niveaux) {
  if (!niveaux) return ""
  const i = etageAtteint(niveaux)
  const suivant = prochainEtage(niveaux)
  if (i < 0) return `Aucun étage tenu : le socle « ${NIVEAUX[0].nom} » est à reprendre.`
  const debut = `Étage atteint : ${NIVEAUX[i].nom}${i >= GOUFFRE ? " (gouffre franchi)" : " (sous le gouffre)"}.`
  return suivant ? `${debut} Étage suivant : ${suivant.nom}${suivant.pour_monter ? `, ${suivant.pour_monter}` : ""}` : `${debut} Toute la pyramide est tenue.`
}

// Les étages à faire monter, en demande de corrections : à partir du premier non tenu, trois au plus.
export function pyramideEnCorrections(niveaux) {
  if (!niveaux) return ""
  const debut = etageAtteint(niveaux) + 1
  const aMonter = niveaux.slice(debut).filter((n) => (n.note ?? 0) < SEUIL && n.pour_monter).slice(0, 3)
  if (!aMonter.length) return ""
  return [
    "La pyramide de l'expérience (notée sur le produit fini) : fais monter le produit d'un étage, en commençant par le plus bas, sans casser ce qui marche :",
    ...aMonter.map((n) => `- ${n.nom} (${n.note ?? "?"}/10) : ${n.pour_monter}`),
  ].join("\n")
}
