// Les pièces jointes d'une demande (maquettes, captures, cahier des charges en PDF ou en
// Markdown, notes en texte brut),
// déposées dans la console. Gardées dans data/pieces/<projet>/, lues par l'analyste
// (outil Read de Claude Code) et copiées dans le dépôt du produit (docs/maquettes/),
// où les agents les retrouvent.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { q } from "./travaux.mjs"

export const PIECES_MAX = 3
export const TAILLE_MAX = 2 * 1024 * 1024 // 2 Mo par pièce
const TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "application/pdf": "pdf" }
// Les premiers octets de chaque format : on ne se fie pas au type annoncé.
const SIGNATURES = { png: [0x89, 0x50, 0x4e, 0x47], jpg: [0xff, 0xd8, 0xff], webp: [0x52, 0x49, 0x46, 0x46], pdf: [0x25, 0x50, 0x44, 0x46] }

const dossier = (config, projetId) => join(config.dataDir, "pieces", String(projetId))
const nomSur = (nom) => String(nom ?? "piece").normalize("NFD").replace(/\p{M}/gu, "").replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "piece"

// Contrôle les pièces envoyées ({ nom, type, base64 }) ; renvoie les fichiers à écrire. Lève une erreur claire.
// Le texte (Markdown, texte brut) : reconnu à l'extension (Windows n'annonce souvent aucun type
// pour un .md), puis contrôlé : de l'UTF-8 valide, sans octet nul (pas un binaire renommé).
const TEXTES = { md: "md", markdown: "md", txt: "txt", csv: "csv" }
const extensionTexte = (nom) => TEXTES[/\.([a-z0-9]+)$/i.exec(String(nom ?? ""))?.[1]?.toLowerCase()]
function estDuTexte(contenu) {
  if (contenu.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(contenu)
    return true
  } catch {
    return false
  }
}

export function verifierPieces(pieces, { max = PIECES_MAX } = {}) {
  if (pieces === undefined || pieces === null) return []
  if (!Array.isArray(pieces)) throw new Error("Pièces jointes illisibles.")
  if (pieces.length > max) throw new Error(`${max} pièces jointes au plus.`)
  return pieces.map((p, i) => {
    const ext = TYPES[p?.type] ?? extensionTexte(p?.nom)
    if (!ext) throw new Error(`« ${p?.nom ?? "?"} » : formats acceptés PNG, JPEG, WebP, PDF, Markdown (.md), texte (.txt) ou tableau (.csv).`)
    const contenu = Buffer.from(String(p.base64 ?? ""), "base64")
    if (!contenu.length) throw new Error(`« ${p.nom} » est vide.`)
    if (contenu.length > TAILLE_MAX) throw new Error(`« ${p.nom} » dépasse 2 Mo.`)
    if (SIGNATURES[ext] && !SIGNATURES[ext].every((o, k) => contenu[k] === o)) throw new Error(`« ${p.nom} » n'est pas un vrai fichier ${ext.toUpperCase()}.`)
    if (!SIGNATURES[ext] && !estDuTexte(contenu)) throw new Error(`« ${p.nom} » n'est pas un fichier texte (UTF-8).`)
    return { nom: `${i + 1}-${nomSur(p.nom)}.${ext}`, contenu }
  })
}

export function enregistrerPieces(config, projetId, fichiers) {
  if (!fichiers.length) return
  const d = dossier(config, projetId)
  mkdirSync(d, { recursive: true })
  for (const f of fichiers) writeFileSync(join(d, f.nom), f.contenu)
}

export function listerPieces(config, projetId) {
  const d = dossier(config, projetId)
  if (!existsSync(d)) return []
  return readdirSync(d).filter((f) => /^\d-[\w-]+\.(png|jpg|webp|pdf|md|txt|csv)$/.test(f)).sort().map((f) => ({ nom: f, chemin: join(d, f), taille: statSync(join(d, f)).size }))
}

// Les lignes bash qui recréent les pièces dans un dossier de l'atelier (binaire, via base64).
export function scriptPieces(config, projetId, cible) {
  const pieces = listerPieces(config, projetId)
  if (!pieces.length) return []
  return [`mkdir -p ${q(cible)}`, ...pieces.map((p) => `printf '%s' ${q(readFileSync(p.chemin).toString("base64"))} | base64 -d > ${q(`${cible}/${p.nom}`)}`)]
}
