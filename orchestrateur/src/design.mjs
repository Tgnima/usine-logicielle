// Le design d'un produit : le brief (dans le plan, écrit dans docs/DESIGN.md) et
// la grille « anti-IA-slop », la même pour l'analyste, les agents et le relecteur
// design. Objectif : un produit qui a l'air pensé par une équipe, pas généré.

export const GRILLE_DESIGN = [
  "Une identité tenue : la palette et la typographie du brief (docs/DESIGN.md), pas de couleurs ajoutées au hasard.",
  "Pas de dégradés décoratifs, d'effets « verre », d'ombres lourdes ni d'arrondis exagérés ; une profondeur sobre.",
  "Pas d'emojis comme icônes ni de pictos « étincelles IA » ; des icônes d'une seule famille, ou aucune.",
  "Pas de textes génériques (« Bienvenue dans X », « Boostez votre productivité », lorem ipsum) : des textes précis, utiles, du métier.",
  "Une hiérarchie nette : un titre de page, une action principale par écran, des actions secondaires plus discrètes.",
  "Une grille et des espacements réguliers (échelle de 4/8 px), des alignements propres ; pas tout centré.",
  "Les nombres alignés à droite dans les tableaux, des formats français (1 234,50 €, 3 oct. 2026), des unités claires.",
  "Chaque écran a un état vide utile (ce qu'on peut faire et le bouton pour le faire), un état de chargement et un état d'erreur.",
  "Contraste lisible (niveau AA), textes d'au moins 14 px, zones cliquables confortables ; utilisable au clavier.",
  "Responsive réel : rien ne déborde à 390 px de large ; les tableaux deviennent des listes ou défilent proprement.",
  "Pas de fausses données de vitrine (faux témoignages, faux logos clients, chiffres inventés présentés comme réels).",
  "Cohérence d'un écran à l'autre : mêmes composants (client/src/ui), mêmes libellés, même ton.",
]

export const grilleEnTexte = () => GRILLE_DESIGN.map((r, i) => `${i + 1}. ${r}`).join("\n")

// La partie du schéma de plan que l'analyste remplit.
export const SCHEMA_DESIGN = `"design": {
    "intention": "L'impression que doit donner le produit, en 2 phrases (à qui il parle, ce qu'il doit inspirer)",
    "references": ["2 ou 3 produits réels dont l'esthétique est une bonne référence"],
    "palette": { "primaire": "#RRGGBB", "accent": "#RRGGBB", "fond": "#RRGGBB", "surface": "#RRGGBB", "texte": "#RRGGBB", "doux": "#RRGGBB", "succes": "#RRGGBB", "alerte": "#RRGGBB", "danger": "#RRGGBB" },
    "typographie": { "titres": "une police (Google Fonts permis) ou system-ui", "texte": "…" },
    "ton": "Comment le produit parle (tutoiement ou vouvoiement, registre, longueur des phrases)",
    "parcours_cle": ["Les 3 à 5 moments du parcours qui doivent être irréprochables"],
    "a_eviter": ["Ce qui trahirait un produit générique dans ce domaine"]
  }`

const HEX = /^#[0-9a-fA-F]{6}$/
const PALETTE_DEFAUT = { primaire: "#1f2937", accent: "#2563eb", fond: "#f6f7f9", surface: "#ffffff", texte: "#111827", doux: "#6b7280", succes: "#15803d", alerte: "#b45309", danger: "#b91c1c" }

// Les problèmes du brief (vide = acceptable). Un plan sans brief reste accepté (ancien format).
export function verifierDesign(design) {
  if (!design) return []
  const p = []
  if (!design.intention) p.push("design.intention manquant")
  for (const cle of Object.keys(PALETTE_DEFAUT)) if (!HEX.test(design.palette?.[cle] ?? "")) p.push(`design.palette.${cle} doit être une couleur #RRGGBB`)
  return p
}

export const palette = (design) => Object.fromEntries(Object.entries(PALETTE_DEFAUT).map(([k, v]) => [k, HEX.test(design?.palette?.[k] ?? "") ? design.palette[k] : v]))

// Les jetons de couleur et de police pour la brique (client/src/styles.css).
export function jetonsCss(design) {
  const p = palette(design)
  const police = (nom) => (nom && !/system/i.test(nom) ? `"${String(nom).replace(/["\\]/g, "")}", ` : "")
  return `@theme {
  --color-primaire: ${p.primaire};
  --color-accent: ${p.accent};
  --color-fond: ${p.fond};
  --color-surface: ${p.surface};
  --color-texte: ${p.texte};
  --color-doux: ${p.doux};
  --color-succes: ${p.succes};
  --color-alerte: ${p.alerte};
  --color-danger: ${p.danger};
  --font-titres: ${police(design?.typographie?.titres)}system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-texte: ${police(design?.typographie?.texte)}system-ui, -apple-system, "Segoe UI", sans-serif;
}`
}

export function designEnMarkdown(plan) {
  const d = plan.design
  if (!d) return `# Design : ${plan.nom}\n\nPas de brief : suivre la grille ci-dessous et les composants de client/src/ui.\n\n## Grille\n\n${grilleEnTexte()}\n`
  const p = palette(d)
  return [
    `# Design : ${plan.nom}`,
    "",
    d.intention,
    "",
    ...(d.references?.length ? ["## Références", "", ...d.references.map((r) => `- ${r}`), ""] : []),
    "## Palette (jetons Tailwind : bg-primaire, text-doux…)",
    "",
    ...Object.entries(p).map(([k, v]) => `- **${k}** : \`${v}\``),
    "",
    "## Typographie",
    "",
    `- Titres : ${d.typographie?.titres ?? "system-ui"} (classe \`font-titres\`)`,
    `- Texte : ${d.typographie?.texte ?? "system-ui"} (classe \`font-texte\`)`,
    "",
    ...(d.ton ? ["## Ton", "", d.ton, ""] : []),
    ...(d.parcours_cle?.length ? ["## Parcours clé (irréprochables)", "", ...d.parcours_cle.map((x) => `- ${x}`), ""] : []),
    ...(d.a_eviter?.length ? ["## À éviter", "", ...d.a_eviter.map((x) => `- ${x}`), ""] : []),
    "## Grille (vérifiée sur captures d'écran à chaque tâche)",
    "",
    grilleEnTexte(),
    "",
  ].join("\n")
}
