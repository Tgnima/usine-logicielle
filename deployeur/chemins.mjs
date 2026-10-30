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

// Les noms réservés aux adresses de l'usine elle-même : jamais celui d'un produit.
export const RESERVES = new Set(["mails", "console", "connexion", "usine-tableau", "apercu", "portier"])

// L'adresse d'un environnement est celle que l'usine lui donne, rien d'autre : un état souhaité
// ne peut pas prendre l'adresse de la console, du portail ou d'un autre produit.
export function hotesValides(s, base) {
  if (RESERVES.has(s?.produit)) return false
  if (!base) return /^[a-z0-9.-]+$/.test(s?.hote ?? "") && (!s?.hote_mails || /^[a-z0-9.-]+$/.test(s.hote_mails))
  const attendu = s.environnement === "apercu" ? `${s.produit}.apercu.${base}` : `${s.produit}.${base}`
  return s.hote === attendu && (!s.hote_mails || s.hote_mails === `mails.apercu.${base}`)
}

// Le sous-réseau du réseau Docker d'un produit : un /27 de PLAGE choisi d'après son nom
// (essai n : la case suivante, si celle-ci est prise). 2 048 produits tiennent dans un /16.
export function sousReseau(produit, essai = 0, plage = "10.231.0.0/16") {
  const [a, b] = plage.split(".").map(Number)
  let h = 0
  for (const c of String(produit)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const cas = (h + essai) % 2048
  return `${a}.${b}.${cas >> 3}.${(cas & 7) * 32}/27`
}
