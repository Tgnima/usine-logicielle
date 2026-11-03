// Les jetons à essayer, dans l'ordre, pour lire le dépôt de l'usine (sa mise à jour).
//
// D'abord la connexion GitHub de la console (celle qui sert déjà à l'état et aux produits),
// puis le jeton du serveur (.env), et enfin sans jeton : le dépôt de l'usine peut être public.
// Un jeton du serveur expiré ou révoqué ne bloque donc plus la mise à jour.
export function jetonsMiseAJour({ console: jetonConsole = null, serveur = null } = {}) {
  return [...new Set([jetonConsole, serveur].filter(Boolean)), null]
}

// D'où vient un jeton, pour le journal (jamais le jeton lui-même).
export function origineJeton(jeton, { console: jetonConsole = null, serveur = null } = {}) {
  if (!jeton) return "sans jeton"
  if (jeton === jetonConsole) return "connexion GitHub de la console"
  if (jeton === serveur) return "jeton du serveur"
  return "jeton inconnu"
}
