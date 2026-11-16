// Les marqueurs d'un journal de travail : une ligne « @@ CLE valeur », CLE en majuscules, chiffres et
// soulignés. Les chiffres comptent : sans eux, les marqueurs du cliquet (E2E_NOUVEAUX, E2E_TOTAL,
// E2E_ECHECS) ne sont jamais lus, et aucun test de non-régression ne rejoint les produits.
// Les lignes qu'écrit le code d'un produit sont neutralisées avant (« (@@) », NEUTRALISER dans
// orchestrateur/src/profil.mjs) : il ne peut pas en imiter un.
export function marqueurs(journal) {
  const m = {}
  for (const ligne of String(journal ?? "").split("\n")) {
    const r = /^@@ ([A-Z0-9_]+)(?: (.*))?$/.exec(ligne.trim())
    if (r) m[r[1]] = (r[2] ?? "").trim()
  }
  return m
}
