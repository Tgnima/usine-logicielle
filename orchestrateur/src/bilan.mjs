// Des chiffres honnêtes pour le bilan de la semaine (page Visibilité, « 7 derniers jours ») :
//   - un taux ne se montre qu'avec son effectif (« 12 sur 15 essais »), et ne se compare à la semaine
//     d'avant qu'avec assez d'essais des deux côtés (sous SEUIL_COMPARAISON : « trop peu pour comparer ») ;
//   - les échecs (mises en ligne, projets en échec) se regroupent par cause normalisée, sans
//     identifiant ni sha, avec une classe : passager (réseau, GitHub), environnement (mémoire, disque),
//     configuration (clé, compte) ou code. Un échec passager suivi d'une réussite ne compte plus.
// Des fonctions pures : ni base, ni fichier, ni horloge.

// --- Comparer deux semaines ----------------------------------------------------------------
export const SEUIL_COMPARAISON = 10

// actuel et avant : { n, sur } (par exemple 12 fonctions ajoutées sur 15 essais). Le taux est arrondi ;
// sans essai, il est null. comparable : assez d'essais des deux côtés ; ecart en points sinon null.
export function comparerTaux(actuel, avant, seuil = SEUIL_COMPARAISON) {
  const lire = (x) => {
    const n = Math.max(0, Number(x?.n) || 0)
    const sur = Math.max(0, Number(x?.sur) || 0)
    return { n, sur, pct: sur ? Math.round((n / sur) * 100) : null }
  }
  const a = lire(actuel)
  const b = lire(avant)
  const comparable = a.sur >= seuil && b.sur >= seuil
  return { actuel: a, avant: b, comparable, ecart: comparable ? a.pct - b.pct : null, seuil }
}

// --- La classe d'un échec ------------------------------------------------------------------
export const CLASSES = ["passager", "environnement", "configuration", "code"]

// Dans l'ordre : le serveur à court de place ou de mémoire d'abord (un code 137 n'est pas un bug) ;
// puis les signes certains d'un produit qui ne démarre pas (même avec un 502 devant) ; puis le passager
// (une limite de débit de GitHub répond 403, c'est passager) ; puis la configuration. Sinon : le code.
const MOTIFS = [
  ["environnement", /\benospc\b|no space left|disque (?:plein|saturé)|disk (?:is )?full|\benomem\b|cannot allocate memory|out of memory|heap out of memory|oom-?kill|mémoire dépassée|code de sortie 137|exit(?:ed)?(?: with)? code 137|\bemfile\b|too many open files|cannot connect to the docker daemon|docker daemon (?:is not running|not responding)/i],
  ["code", /\/api\/health|l'(?:aperçu|application) ne (?:répond|démarre) pas|ne démarre pas|\b(?:syntax|type|reference|range)error\b|cannot find module|err_module_not_found|npm err! code elifecycle|test\(s\) échouent|\beacces\b/i],
  ["passager", /\betimedout\b|\beconnreset\b|\beconnrefused\b|\beai_again\b|\benotfound\b|\bepipe\b|socket hang up|fetch failed|network (?:error|is unreachable)|réseau (?:injoignable|indisponible)|timed out|délai dépassé|the operation was aborted|aborterror|\b50[234]\b|bad gateway|service unavailable|gateway time-?out|remote: internal server error|rate limit|too many requests|\b429\b|overloaded|\b529\b|usage limit|limite d'usage|temporarily|temporairement|try again later|réessaie plus tard|redémarré pendant|interrompu \d+ fois|n'a pas appliqué/i],
  ["configuration", /\b40[13]\b|unauthori[sz]ed|forbidden|bad credentials|invalid (?:api[ -]?)?key|invalid x-api-key|authentication (?:failed|error|required)|not logged in|please run \/login|credit balance|insufficient (?:credit|funds|quota)|billing|\b402\b|payment required|resource not accessible by integration|permission denied \(publickey\)|token (?:expired|invalid)|jeton (?:expiré|invalide|manquant|refusé)|clé (?:api )?(?:invalide|refusée|manquante)|coffre verrouillé|manquant : |n'est configuré|not configured/i],
]

export function classeEchec(message) {
  const t = String(message ?? "").split("\n")[0]
  return MOTIFS.find(([, motif]) => motif.test(t))?.[0] ?? "code"
}

// --- La signature d'un échec -----------------------------------------------------------------
// Ce qui dit « où » plutôt que « pourquoi » : retiré, la cause reste.
const PREFIXES = [
  /^(?:uncaught )?(?:error|erreur)\s*:\s*/i,
  /^livraison du lot \d+ à réessayer\s*:\s*/i,
  /^aperçu du lot \d+ en échec\s*:\s*/i,
  /^mise en production (?:en échec|refusée)\s*:\s*/i,
  /^pull request de livraison impossible\s*:\s*/i,
  /^push impossible\s*:\s*/i,
  /^réorientation\s*:\s*/i,
  /^vidéo de présentation\s*:\s*/i,
  /^command failed\s*:\s*/i,
]
export const SIGNATURE_MAX = 80
const echapperRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// La cause d'un échec, la même d'une fois sur l'autre : la première ligne (la suite est une pile
// d'appels), sans ce qui change à chaque fois (sha, numéros, adresses, chemins de fichier avec leur
// ligne, noms des conteneurs) ni le nom du produit (retirer : son slug, son nom). Les codes HTTP
// (4xx, 5xx) restent : 401 et 502 ne sont pas la même cause.
export function signatureEchec(message, { retirer = [] } = {}) {
  let t = String(message ?? "").split("\n")[0]
  for (let tour = 0; tour < 3; tour++) for (const p of PREFIXES) t = t.replace(p, "")
  t = t
    .replace(/https?:\/\/[^\s'")]+/gi, "une adresse")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "une adresse IP")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "")
    .replace(/\b(?:le conteneur )?usine-(?:apercu|prod)-[a-z0-9-]+\b/gi, "l'application")
    .replace(/\busine\/[a-z0-9-]+(?::[\w.-]+)?/gi, "l'image")
  for (const nom of retirer.filter((x) => typeof x === "string" && x.length >= 3)) t = t.replace(new RegExp(`(?<![\\w-])${echapperRegex(nom)}(?![\\w-])`, "gi"), "")
  t = t
    .replace(/(?:\(|\b)node:[a-z_/]+:\d+(?::\d+)?\)?/gi, "")
    .replace(/[\w./-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|py)(?::\d+){1,2}/gi, "un fichier")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/gi, "")
    .replace(/#\d+/g, "")
    // Les nombres deviennent N (une tâche T4 ou T5, 15 ou 20 min : la même cause), sauf un code HTTP.
    .replace(/\b([45]\d\d)\b/g, "\u0001$1")
    .replace(/\u0001?\d+(?:[.,]\d+)*/g, (m) => (m.startsWith("\u0001") ? m.slice(1) : "N"))
    .replace(/[`*]/g, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+([,.)])/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/[\s:;,.-]+$/, "")
    .replace(/^[\s:;,.-]+/, "")
    .trim()
  if (!t) return "autre"
  return t.length > SIGNATURE_MAX ? `${t.slice(0, SIGNATURE_MAX - 1).trimEnd()}…` : t
}

export const classerEchec = (message, options = {}) => ({ classe: classeEchec(message), signature: signatureEchec(message, options) })

// --- Les échecs de la semaine, par cause ---------------------------------------------------------
// echecs : [{ message, le (ms), projet (id ou null), nom (pour la liste), retirer ([slug, nom]), actuel }] ;
// reussites : [{ le (ms), projet (id ou null) }]. Un échec passager suivi d'une réussite du même projet
// (de n'importe quel projet pour un échec de l'usine elle-même) ne compte plus : il est seulement compté
// dans passageres (aujourdhui : son jour, par jour(le), est celui d'aujourd'hui). Un échec « actuel »
// (toujours en échec, comme le dit statut.json) n'est jamais effacé. texte(message) : le message dit avec
// les mots de l'usine avant d'en tirer la cause montrée (la classe, elle, se lit sur le message d'origine).
export function regrouperEchecs(echecs, reussites = [], { jour = (le) => new Date(le).toISOString().slice(0, 10), aujourdhui = null, texte = (s) => s } = {}) {
  const groupes = new Map()
  const passageres = { aujourdhui: 0, semaine: 0 }
  for (const e of echecs) {
    const classe = classeEchec(e.message)
    const suivi = !e.actuel && reussites.some((r) => r.le > e.le && (e.projet === null || e.projet === undefined || r.projet === e.projet))
    if (classe === "passager" && suivi) {
      passageres.semaine += 1
      if (aujourdhui && jour(e.le) === aujourdhui) passageres.aujourdhui += 1
      continue
    }
    const cause = signatureEchec(texte(String(e.message ?? "")), { retirer: e.retirer ?? [] })
    const cle = `${classe}|${cause}`
    const g = groupes.get(cle) ?? { classe, cause, n: 0, projets: [], dernier: 0 }
    g.n += 1
    g.dernier = Math.max(g.dernier, e.le)
    if (e.nom && !g.projets.includes(e.nom)) g.projets.push(e.nom)
    groupes.set(cle, g)
  }
  const liste = [...groupes.values()].sort((a, b) => b.n - a.n || b.dernier - a.dernier || a.cause.localeCompare(b.cause, "fr"))
  return { total: liste.reduce((s, g) => s + g.n, 0), groupes: liste, passageres }
}
