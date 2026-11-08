// Le design d'un produit : le brief (dans le plan, écrit dans docs/DESIGN.md) et
// la grille « anti-IA-slop », la même pour l'analyste, les agents et le relecteur
// design. Objectif : un produit qui a l'air pensé par une équipe, pas généré.
//
// Le brief devient les jetons de la brique (jetonsCss) : les couleurs, les polices, l'arrondi
// et, s'il est donné, le thème sombre. Les composants shadcn/ui de la brique (client/src/ui)
// lisent ces jetons : un produit n'a pas d'autres couleurs que celles de son brief.

export const GRILLE_DESIGN = [
  "Une identité tenue : la palette et la typographie du brief (docs/DESIGN.md), pas de couleurs ajoutées au hasard ; une seule couleur d'accent sur des neutres.",
  "Pas de dégradés décoratifs, d'effets « verre », d'ombres lourdes ni d'arrondis exagérés ; une profondeur sobre (bordures fines plutôt qu'ombres).",
  "Pas d'emojis comme icônes ni de pictos « étincelles IA » ; des icônes Lucide (lucide-react) seulement, ou aucune.",
  "Pas de textes génériques (« Bienvenue dans X », « Boostez votre productivité », lorem ipsum) : des textes précis, utiles, du métier.",
  "Une hiérarchie nette : un titre de page, une action principale par écran, des actions secondaires plus discrètes (ou dans un menu).",
  "Une grille et des espacements réguliers (échelle de 4/8 px), des alignements propres ; pas tout centré.",
  "Les nombres alignés à droite dans les tableaux, des formats français (1 234,50 €, 3 oct. 2026), des unités claires.",
  "Chaque écran a un état vide utile (ce qu'on peut faire et le bouton pour le faire), un état de chargement et un état d'erreur ; chaque action confirme son résultat.",
  "Contraste lisible (niveau AA), textes d'au moins 14 px, zones cliquables confortables ; utilisable au clavier, focus visible.",
  "Responsive réel : rien ne déborde à 390 px de large ; les tableaux deviennent des listes ou défilent proprement.",
  "Pas de fausses données de vitrine (faux témoignages, faux logos clients, chiffres inventés présentés comme réels).",
  "Cohérence d'un écran à l'autre : les composants du kit (client/src/ui, page /kit), mêmes libellés, même ton ; pas de cartes dans des cartes, pas un badge sur chaque information.",
]

export const grilleEnTexte = () => GRILLE_DESIGN.map((r, i) => `${i + 1}. ${r}`).join("\n")

// La partie du schéma de plan que l'analyste remplit.
export const SCHEMA_DESIGN = `"design": {
    "intention": "L'impression que doit donner le produit, en 2 phrases (à qui il parle, ce qu'il doit inspirer)",
    "references": ["2 ou 3 produits réels dont l'esthétique est une bonne référence"],
    "palette": { "primaire": "#RRGGBB", "accent": "#RRGGBB", "fond": "#RRGGBB", "surface": "#RRGGBB", "texte": "#RRGGBB", "doux": "#RRGGBB", "succes": "#RRGGBB", "alerte": "#RRGGBB", "danger": "#RRGGBB" },
    "palette_sombre": "null, ou la même palette pour le thème sombre, si le public en profite (usage le soir, outil ouvert toute la journée)",
    "arrondi": "l'arrondi des composants en px, de 4 (net, dense) à 12 (doux) ; 8 par défaut",
    "typographie": { "titres": "une police (Google Fonts permis) ou system-ui", "texte": "…" },
    "ton": "Comment le produit parle (tutoiement ou vouvoiement, registre, longueur des phrases)",
    "parcours_cle": ["Les 3 à 5 moments du parcours qui doivent être irréprochables"],
    "a_eviter": ["Ce qui trahirait un produit générique dans ce domaine"]
  }`

const HEX = /^#[0-9a-fA-F]{6}$/
const PALETTE_DEFAUT = { primaire: "#1f2937", accent: "#2563eb", fond: "#f6f7f9", surface: "#ffffff", texte: "#111827", doux: "#6b7280", succes: "#15803d", alerte: "#b45309", danger: "#b91c1c" }
const ARRONDI_DEFAUT = 8
const BLANC = "#ffffff"
const NOIR = "#111827"

// Le contraste WCAG entre deux couleurs #RRGGBB (de 1 à 21).
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
export const contraste = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}
// Le texte posé sur une couleur (un bouton principal) : blanc ou presque noir, le plus lisible.
export const texteSur = (fond) => (contraste(BLANC, fond) >= contraste(NOIR, fond) ? BLANC : NOIR)

// Les paires qui doivent rester lisibles (AA, 4,5) : sans elles, un brief donne un produit illisible.
const PAIRES = [["texte", "fond"], ["texte", "surface"], ["doux", "surface"]]
function problemesPalette(pal, nom) {
  const p = []
  for (const cle of Object.keys(PALETTE_DEFAUT)) if (!HEX.test(pal?.[cle] ?? "")) p.push(`design.${nom}.${cle} doit être une couleur #RRGGBB`)
  if (p.length) return p
  for (const [a, b] of PAIRES) {
    const c = contraste(pal[a], pal[b])
    if (c < 4.5) p.push(`design.${nom} : « ${a} » sur « ${b} » n'est pas lisible (contraste ${c.toFixed(1)}, il faut au moins 4,5)`)
  }
  for (const cle of ["primaire", "danger"]) {
    const c = contraste(texteSur(pal[cle]), pal[cle])
    if (c < 4.5) p.push(`design.${nom}.${cle} : aucun texte n'y est lisible (contraste ${c.toFixed(1)}) ; fonce-la ou éclaircis-la`)
  }
  return p
}

// Les problèmes du brief (vide = acceptable). Un plan sans brief reste accepté (ancien format).
export function verifierDesign(design) {
  if (!design) return []
  const p = []
  if (!design.intention) p.push("design.intention manquant")
  p.push(...problemesPalette(design.palette, "palette"))
  if (design.palette_sombre) p.push(...problemesPalette(design.palette_sombre, "palette_sombre"))
  if (design.arrondi !== undefined && design.arrondi !== null && !(Number.isInteger(Number(design.arrondi)) && Number(design.arrondi) >= 0 && Number(design.arrondi) <= 16)) p.push("design.arrondi doit être un nombre de px entre 0 et 16")
  return p
}

const completer = (pal) => Object.fromEntries(Object.entries(PALETTE_DEFAUT).map(([k, v]) => [k, HEX.test(pal?.[k] ?? "") ? pal[k] : v]))
export const palette = (design) => completer(design?.palette)
export const paletteSombre = (design) => (design?.palette_sombre && typeof design.palette_sombre === "object" ? completer(design.palette_sombre) : null)
export const arrondi = (design) => {
  const n = Number(design?.arrondi)
  return design?.arrondi !== undefined && design?.arrondi !== null && Number.isInteger(n) && n >= 0 && n <= 16 ? n : ARRONDI_DEFAUT
}

const variablesCouleurs = (p, retrait) =>
  [
    ...Object.entries(p).map(([k, v]) => `--color-${k}: ${v};`),
    `--color-sur-primaire: ${texteSur(p.primaire)};`,
    `--color-sur-accent: ${texteSur(p.accent)};`,
    `--color-sur-danger: ${texteSur(p.danger)};`,
  ].map((l) => `${retrait}${l}`).join("\n")

// Les jetons du brief pour la brique (client/src/styles.css, à la place de « /* JETONS */ »).
export function jetonsCss(design) {
  const p = palette(design)
  const sombre = paletteSombre(design)
  const police = (nom) => (nom && !/system/i.test(nom) ? `"${String(nom).replace(/["\\]/g, "")}", ` : "")
  return `@theme {
${variablesCouleurs(p, "  ")}
  --radius: ${arrondi(design)}px;
  --font-titres: ${police(design?.typographie?.titres)}system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-texte: ${police(design?.typographie?.texte)}system-ui, -apple-system, "Segoe UI", sans-serif;
}${sombre ? `

/* Le thème sombre du brief, suivi selon le réglage de l'appareil. */
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
${variablesCouleurs(sombre, "    ")}
  }
}` : ""}`
}

export function designEnMarkdown(plan) {
  const d = plan.design
  const kit = [
    "## Composants (le kit d'interface)",
    "",
    "- Les composants de `client/src/ui` (shadcn/ui sur Radix, aux jetons du brief) : `Coque`, `Page`, `Carte`, `Bouton`, `Champ`, `Tableau`, `Statistique`, `Badge`, `EtatVide`, `Chargement`, `Erreur`, `toast` (dans `ui/index.jsx`), et `Dialog`, `Sheet`, `DropdownMenu`, `Select`, `Tabs`, `Tooltip`, `Popover`, `Skeleton`, `Checkbox`, `Switch` (chacun dans son fichier de `ui/shadcn/`).",
    "- La page `/kit` les montre tous aux couleurs du produit. Un nouvel écran n'invente pas de composant : il réutilise le kit, ou l'enrichit (et `/kit` avec).",
    "- Icônes : `lucide-react` seulement.",
    "",
  ]
  if (!d) return [`# Design : ${plan.nom}`, "", "Pas de brief : suivre la grille ci-dessous et les composants de client/src/ui.", "", ...kit, "## Grille", "", grilleEnTexte(), ""].join("\n")
  const p = palette(d)
  const sombre = paletteSombre(d)
  return [
    `# Design : ${plan.nom}`,
    "",
    d.intention,
    "",
    ...(d.references?.length ? ["## Références", "", ...d.references.map((r) => `- ${r}`), ""] : []),
    "## Palette (jetons Tailwind : bg-primaire, text-doux… ou bg-primary, text-muted-foreground…)",
    "",
    ...Object.entries(p).map(([k, v]) => `- **${k}** : \`${v}\``),
    "",
    ...(sombre ? ["## Thème sombre (suivi selon le réglage de l'appareil)", "", ...Object.entries(sombre).map(([k, v]) => `- **${k}** : \`${v}\``), ""] : []),
    "## Forme",
    "",
    `- Arrondi : ${arrondi(d)} px (\`rounded-lg\` ; \`rounded-md\` et \`rounded-sm\` en dérivent)`,
    "- Bordures fines (`border-border`), ombres rares et légères",
    "",
    "## Typographie",
    "",
    `- Titres : ${d.typographie?.titres ?? "system-ui"} (classe \`font-titres\`)`,
    `- Texte : ${d.typographie?.texte ?? "system-ui"} (classe \`font-texte\`)`,
    "",
    ...kit,
    ...(d.ton ? ["## Ton", "", d.ton, ""] : []),
    ...(d.parcours_cle?.length ? ["## Parcours clé (irréprochables)", "", ...d.parcours_cle.map((x) => `- ${x}`), ""] : []),
    ...(d.a_eviter?.length ? ["## À éviter", "", ...d.a_eviter.map((x) => `- ${x}`), ""] : []),
    "## Grille (vérifiée sur captures d'écran à chaque tâche)",
    "",
    grilleEnTexte(),
    "",
  ].join("\n")
}
