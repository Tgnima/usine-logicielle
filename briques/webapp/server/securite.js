// La sécurité de base de chaque produit. Fichier protégé : l'usine le restaure
// s'il est modifié par une tâche. Le portier de l'usine (connexion) et Caddy
// (HTTPS) protègent déjà l'accès ; ceci protège le produit lui-même.
//   - en-têtes de sécurité (CSP, anti-cadres, anti-reniflage, permissions) ;
//   - limitation des requêtes par adresse (429 au-delà) ;
//   - erreurs : jamais de détail technique vers le visiteur.

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ")

export function entetes() {
  return (_req, res, next) => {
    res.set({
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "SAMEORIGIN",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "Cross-Origin-Opener-Policy": "same-origin",
    })
    next()
  }
}

// Une fenêtre glissante simple, en mémoire : assez pour une application d'une instance.
export function limiter({ fenetreMs = 60_000, max = 300 } = {}) {
  const compteurs = new Map()
  setInterval(() => {
    const limite = Date.now() - fenetreMs
    for (const [cle, t] of compteurs) if (t.debut < limite) compteurs.delete(cle)
  }, fenetreMs).unref()
  return (req, res, next) => {
    const cle = req.ip ?? "?"
    const maintenant = Date.now()
    let t = compteurs.get(cle)
    if (!t || maintenant - t.debut > fenetreMs) compteurs.set(cle, (t = { debut: maintenant, n: 0 }))
    t.n += 1
    if (t.n > max) {
      res.set("Retry-After", String(Math.ceil((t.debut + fenetreMs - maintenant) / 1000)))
      return res.status(429).json({ erreur: "Trop de requêtes : réessaie dans un instant." })
    }
    next()
  }
}

// Les erreurs : le message d'une erreur métier (statut < 500) est montré ; une
// panne (500) est journalisée en entier et le visiteur ne voit qu'un message neutre.
export function gestionErreurs() {
  // eslint-disable-next-line no-unused-vars
  return (error, req, res, _next) => {
    const statut = Number(error.status ?? error.statusCode ?? 500)
    if (error.type === "entity.too.large") return res.status(413).json({ erreur: "Requête trop volumineuse." })
    if (error.type === "entity.parse.failed") return res.status(400).json({ erreur: "JSON invalide." })
    if (statut >= 500) {
      console.error(`${req.method} ${req.originalUrl} :`, error)
      return res.status(500).json({ erreur: "Une erreur interne est survenue." })
    }
    res.status(statut).json({ erreur: error.message })
  }
}
