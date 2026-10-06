// Le lien entre les pages du site (server/contenu.js) et le serveur protégé
// (server/index.js) : titre et description par page, liste pour le plan du site.
import { PAGES } from "./contenu.js"

export function meta(chemin) {
  const page = PAGES.find((p) => p.chemin === chemin) ?? PAGES.find((p) => p.chemin === "/")
  return page ? { titre: page.titre, description: page.description } : null
}

export const pages = () => PAGES.map((p) => p.chemin)

// Facultatif : les chemins à ne pas faire indexer (robots.txt), par exemple ["/admin"].
export const interdits = () => []
