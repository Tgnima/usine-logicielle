// Les chemins d'une application joignables SANS connexion. Toute l'application est
// derrière la page de connexion de l'usine (le portier), sauf :
//   - les chemins de l'usine : santé, pages et API publiques, liens historiques des emails ;
//   - ceux que le produit déclare dans son usine.json : { "chemins_publics": ["/api/t/*", "/merci"] }
//     (un lien envoyé par email à un prospect, par exemple ; il n'a pas de compte).
// Une déclaration trop large (« / », « /* », « /api/* »…) est refusée : on ne rend jamais
// toute l'application publique par ce biais.

export const CHEMINS_PUBLICS = ["/api/health", "/public/*", "/api/public/*", "/t/*", "/desinscription/*"]

const TROP_LARGES = new Set(["/", "/*", "/api", "/api/*", "/api/", "/assets/*", "/index.html"])

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
