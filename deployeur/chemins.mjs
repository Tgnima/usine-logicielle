// Les chemins d'une application joignables SANS connexion. Toute l'application est
// derrière la page de connexion de l'usine (le portier), sauf :
//   - les chemins de l'usine : santé, pages et API publiques, liens historiques des emails ;
//   - ceux que le produit déclare dans son usine.json : { "chemins_publics": ["/api/t/*", "/merci"] }
//     (un lien envoyé par email à un prospect, par exemple ; il n'a pas de compte).
// Une déclaration trop large (« / », « /* », « /api/* »…) est refusée : on ne rend jamais
// toute l'application publique par ce biais.

export const CHEMINS_PUBLICS = ["/api/health", "/public/*", "/api/public/*", "/t/*", "/desinscription/*"]

// (« /assets/* » reste permis : ce sont les fichiers statiques de la page, sans aucune donnée.)
const TROP_LARGES = new Set(["/", "/*", "/api", "/api/*", "/api/", "/index.html"])

export function cheminsDeclares(contenu) {
  let j
  try {
    j = JSON.parse(String(contenu ?? ""))
  } catch {
    return { chemins: [], refuses: [] }
  }
  const liste = Array.isArray(j?.chemins_publics) ? j.chemins_publics.slice(0, 20) : []
  const chemins = []
  const refuses = []
  for (const c of liste) {
    const ok = typeof c === "string"
      && /^\/[A-Za-z0-9._~\-/]*\*?$/.test(c) // un chemin simple, éventuellement terminé par *
      && !c.includes("..") && !c.startsWith("/_portier")
      && !TROP_LARGES.has(c) && c.replace(/\*$/, "").replace(/\/$/, "").length >= 3
    ;(ok ? chemins : refuses).push(String(c))
  }
  return { chemins: [...new Set(chemins)], refuses }
}

// Les domaines personnalisés d'un produit (domaines/<slug>.json du dépôt d'état) :
// de vrais noms de domaine, jamais une adresse de l'usine, 5 au plus, et une adresse
// ne sert qu'un seul produit (le premier qui la déclare).
export function domainesValides(fichiers, base, max = 5) {
  const pris = new Set()
  const resultat = {}
  for (const f of fichiers) {
    if (!/^[a-z0-9-]{3,24}$/.test(f?.produit ?? "") || !Array.isArray(f.hotes)) continue
    resultat[f.produit] = f.hotes
      .map((h) => String(h).toLowerCase())
      .filter((h) => /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h) && !(base && (h === base || h.endsWith(`.${base}`))) && !pris.has(h) && pris.add(h))
      .slice(0, max)
  }
  return resultat
}
