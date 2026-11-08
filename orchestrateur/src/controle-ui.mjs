// Le contrôle automatique de l'interface d'un produit issu d'une brique : les règles du design
// system qu'un modèle n'a pas à juger, parce que du code les vérifie sans se tromper.
//
// Seules les lignes AJOUTÉES par la tâche sont lues (le diff), dans client/src : une tâche ne
// répond jamais du code des tâches précédentes. Un défaut refuse la tâche, avec la ligne et
// la correction attendue ; l'agent corrige à la tentative suivante.

const PALETTE_TAILWIND = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose"
const PROPRIETES_COULEUR = "bg|text|border|border-[trblxy]|ring|ring-offset|fill|stroke|from|via|to|outline|divide|decoration|shadow|caret|placeholder|accent"
const PROPRIETES_ESPACE = "p|px|py|pt|pr|pb|pl|ps|pe|m|mx|my|mt|mr|mb|ml|ms|me|gap|gap-x|gap-y|space-x|space-y|rounded|rounded-[trbl]{1,2}|text|leading|tracking"
const ICONES_INTERDITES = /from\s+["'](?:react-icons(?:\/[\w-]+)?|@heroicons\/[\w/-]+|@fortawesome\/[\w/-]+|@mui\/icons-material(?:\/[\w-]+)?|phosphor-react|@phosphor-icons\/[\w/-]+|@tabler\/icons(?:-react)?|react-feather|ionicons|@radix-ui\/react-icons)["']/

export const REGLES_UI = [
  {
    id: "couleur",
    // Un # après « / » ou « & » est une ancre d'adresse ou une entité HTML, pas une couleur.
    motif: /(?:(?<![\w/&])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b|(?<![\w/&])#(?=[0-9a-fA-F]{0,2}\d)[0-9a-fA-F]{3}\b|\b(?:rgba?|hsla?|oklch|oklab)\s*\()/,
    message: "couleur écrite en dur",
    correction: "utilise un jeton du brief (bg-primaire, text-doux, border-border, bg-muted…)",
  },
  {
    id: "palette",
    motif: new RegExp(`(?<![\\w-])(?:[\\w-]+:)*(?:${PROPRIETES_COULEUR})-(?:${PALETTE_TAILWIND})-\\d{2,3}\\b`),
    message: "couleur de la palette Tailwind, hors du brief",
    correction: "remplace-la par un jeton du brief (text-doux, bg-succes/10, border-border…)",
  },
  {
    id: "arbitraire",
    motif: new RegExp(`(?<![\\w-])-?(?:[\\w-]+:)*(?:${PROPRIETES_COULEUR}|${PROPRIETES_ESPACE})-\\[(?:#|rgb|hsl|oklch|-?\\d+(?:\\.\\d+)?(?:px|rem|em)\\])`),
    message: "valeur arbitraire de couleur, d'espacement ou de taille de texte",
    correction: "reste sur l'échelle du thème (p-4, gap-6, text-sm, rounded-lg…) ou sur un jeton",
  },
  {
    id: "icones",
    motif: ICONES_INTERDITES,
    message: "icônes d'une autre famille que Lucide",
    correction: "importe les icônes depuis lucide-react",
  },
]

// Les fichiers d'interface lus : le code de client/src (pas les feuilles de style, où vivent les jetons).
export const fichierInterface = (chemin) => /^client\/src\/.+\.(?:jsx?|tsx?)$/.test(chemin)

// Retire les commentaires d'une ligne (// … et /* … */ sur la même ligne), sans toucher aux adresses.
const sansCommentaire = (ligne) => ligne.replace(/\/\*.*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/, "$1")

// Les défauts des lignes ajoutées d'un diff unifié (git diff -U0). [{ fichier, ligne, regle, message, correction, extrait }]
export function defautsUi(diff, { max = 15 } = {}) {
  const defauts = []
  let fichier = null
  let numero = 0
  for (const brute of String(diff ?? "").split("\n")) {
    const entete = /^\+\+\+ (?:b\/)?(.+)$/.exec(brute)
    if (entete) {
      fichier = entete[1] === "/dev/null" ? null : entete[1]
      continue
    }
    const bloc = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(brute)
    if (bloc) {
      numero = Number(bloc[1])
      continue
    }
    if (!fichier || !fichierInterface(fichier)) continue
    if (brute.startsWith("+")) {
      const ligne = sansCommentaire(brute.slice(1))
      for (const r of REGLES_UI) {
        const m = r.motif.exec(ligne)
        if (m) defauts.push({ fichier, ligne: numero, regle: r.id, message: r.message, correction: r.correction, extrait: m[0].slice(0, 60) })
      }
      numero += 1
      if (defauts.length >= max) break
    }
  }
  return defauts.slice(0, max)
}

// Le marqueur « @@ UI_DEFAUTS [...] » relu côté usine : illisible ou absent, aucun défaut.
export function lireDefautsUi(texte) {
  try {
    const l = JSON.parse(texte ?? "[]")
    return Array.isArray(l) ? l.filter((d) => d && typeof d.fichier === "string" && typeof d.message === "string").slice(0, 15) : []
  } catch {
    return []
  }
}

export const decrireDefautUi =(d) => `interface : ${d.fichier}:${d.ligne} : ${d.message} (\`${d.extrait}\`) → ${d.correction}`

// Le script lancé dans l'atelier : il lit le diff sur l'entrée standard et écrit « @@ UI_DEFAUTS [...] ».
export const SCRIPT_CONTROLE_UI = `// Contrôle de l'interface (lignes ajoutées de client/src), écrit par l'usine.
const ICONES_INTERDITES = ${ICONES_INTERDITES}
const PALETTE_TAILWIND = ${JSON.stringify(PALETTE_TAILWIND)}
const PROPRIETES_COULEUR = ${JSON.stringify(PROPRIETES_COULEUR)}
const PROPRIETES_ESPACE = ${JSON.stringify(PROPRIETES_ESPACE)}
const REGLES_UI = [${REGLES_UI.map((r) => `{ id: ${JSON.stringify(r.id)}, motif: ${r.motif}, message: ${JSON.stringify(r.message)}, correction: ${JSON.stringify(r.correction)} }`).join(",\n  ")}]
const fichierInterface = ${fichierInterface}
const sansCommentaire = ${sansCommentaire}
${defautsUi}
let entree = ""
process.stdin.on("data", (d) => (entree += d))
process.stdin.on("end", () => console.log("@@ UI_DEFAUTS " + JSON.stringify(defautsUi(entree))))
`
