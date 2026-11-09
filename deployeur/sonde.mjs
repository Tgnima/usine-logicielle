// La sonde des produits : chaque minute, l'état réel de chaque application en ligne
// (aperçus et productions), jugé produit par produit. Ces fonctions sont pures, testées
// sans Docker (test/sonde.test.mjs). Le déployeur, seul à joindre Docker et les réseaux
// des produits, les appelle et publie le résultat dans sante.json (champ « applications »).

// Les seuls champs lus par docker inspect : l'environnement d'un conteneur contient ses
// secrets, il n'est jamais demandé.
export const FORMAT_INSPECT = "{{.Name}}\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}\t{{.RestartCount}}\t{{.State.StartedAt}}\t{{.State.ExitCode}}\t{{.State.OOMKilled}}\t{{.Config.Image}}"

// Une ligne par conteneur. Les lignes d'erreur (un conteneur disparu entre docker ps et
// docker inspect) n'ont pas le bon nombre de champs : elles sont ignorées.
export function lireInspect(sortie) {
  return String(sortie ?? "").split("\n").flatMap((ligne) => {
    const champs = ligne.replace(/\r$/, "").split("\t")
    if (champs.length !== 8) return []
    const [nom, etat, sante, redemarrages, demarre_le, code, oom, image] = champs
    if (!nom || !etat) return []
    return [{ nom: nom.replace(/^\//, ""), etat, sante: sante || null, redemarrages: Number(redemarrages) || 0, demarre_le: demarre_le || null, code_sortie: Number(code) || 0, oom: oom === "true", image: image || null }]
  })
}

// usine-apercu-<slug> -> apercu/<slug> ; usine-prod-<slug>-blue|green -> production/<slug>.
// Les clés sont celles de statut.json.
export function cleDuConteneur(nom) {
  const apercu = /^usine-apercu-([a-z0-9-]+)$/.exec(nom ?? "")
  if (apercu) return `apercu/${apercu[1]}`
  const production = /^usine-prod-([a-z0-9-]+)-(?:blue|green)$/.exec(nom ?? "")
  return production ? `production/${production[1]}` : null
}

// usine-produit-<slug>:<12 premiers caractères du sha> : la version qui tourne vraiment.
export function versionDeLImage(image) {
  const m = /^usine-produit-[a-z0-9-]+:([0-9a-f]{7,40})$/.exec(image ?? "")
  return m ? m[1] : null
}

// Les redémarrages récents d'un conteneur, à partir de son compteur Docker (RestartCount).
// historique : Map nom -> [{ t, n }]. Un compteur qui baisse veut dire un conteneur recréé
// sous le même nom : les anciens relevés ne comptent plus.
export const FENETRE_REDEMARRAGES_MS = 30 * 60_000
export function noterRedemarrages(historique, nom, n, t) {
  const points = (historique.get(nom) ?? []).filter((p) => t - p.t <= FENETRE_REDEMARRAGES_MS && p.n <= n)
  points.push({ t, n })
  historique.set(nom, points)
  return n - points[0].n
}

export const SEUIL_BOUCLE = 3
export const LENT_MS = 3_000
// Au-delà, un déploiement « en cours » est un déploiement bloqué (construction : 20 min au plus,
// git : 15 min, santé : 90 s, plus la sauvegarde) : le produit est de nouveau jugé.
export const DEPLOIEMENT_BLOQUE_MS = 45 * 60_000

// Le jugement d'un produit : { etat: ok|alerte|panne|inconnu, raison, boucle? }, ou null s'il
// n'y a rien à juger (aucun conteneur, et aucun n'est attendu).
//   environnement  apercu ou production ;
//   attendu        statut.json nomme un conteneur pour ce produit (Caddy le sert) ;
//   deploiement    l'état du dernier déploiement (ok, en_cours, echec) ; depuis_ms : son âge ;
//   conteneur      le conteneur relevé (lireInspect), ou null ; nouveau : true s'il est celui
//                  qu'un déploiement en cours est en train de démarrer ; demarre_apres_demande :
//                  true s'il a démarré après la dernière demande de déploiement ;
//   http           { code, ms } de /api/health (code null : pas de réponse), ou null ;
//   recents        les redémarrages des 30 dernières minutes ; en_boucle : déjà jugé en boucle
//                  au relevé précédent (il le reste tant qu'il redémarre encore) ;
//   construction   un autre déploiement construit en ce moment (serveur à 1 processeur chargé).
export function jugerProduit({ environnement = "production", attendu = false, deploiement = null, depuis_ms = 0, conteneur = null, http = null, recents = 0, en_boucle = false, construction = false }) {
  const enCours = deploiement === "en_cours"
  const bloque = enCours && depuis_ms > DEPLOIEMENT_BLOQUE_MS
  // Le conteneur qu'un déploiement remplace ou démarre n'est pas jugé ; l'ancienne couleur
  // d'une production, qui sert encore les visiteurs pendant la construction, l'est. Un aperçu
  // arrêté pendant son déploiement vient de docker rm -f (ou n'a pas encore démarré) :
  // avec --restart unless-stopped, il ne s'arrête pas seul.
  if (enCours && !bloque) {
    if (!conteneur || conteneur.nouveau) return { etat: "inconnu", raison: "déploiement en cours" }
    if (environnement === "apercu" && conteneur.etat !== "running" && conteneur.etat !== "restarting") return { etat: "inconnu", raison: "déploiement en cours" }
  }
  const suite = [deploiement === "echec" ? "dernier déploiement en échec" : null, bloque ? `déploiement bloqué depuis ${Math.round(depuis_ms / 60_000)} min` : enCours ? "déploiement en cours" : null].filter(Boolean)
  const avec = (raison) => [raison, ...suite].join(" · ")
  if (!conteneur) {
    if (attendu) return { etat: "panne", raison: avec("conteneur absent") }
    // Un premier déploiement en échec : rien n'a jamais été servi, et la livraison l'a déjà annoncé.
    if (deploiement === "echec") return { etat: "alerte", raison: "pas en ligne : dernier déploiement en échec, aucun conteneur" }
    return null
  }
  if (conteneur.etat === "restarting" || recents >= SEUIL_BOUCLE || (en_boucle && recents > 0)) {
    return { etat: "panne", raison: avec(`redémarre en boucle (${recents} redémarrage(s) en 30 min, ${conteneur.redemarrages} au total)`), boucle: true }
  }
  if (conteneur.etat !== "running") {
    return { etat: "panne", raison: avec(`arrêté (${conteneur.etat}, code de sortie ${conteneur.code_sortie}${conteneur.oom ? ", mémoire dépassée" : ""})`) }
  }
  // Un aperçu dont le déploiement a échoué n'a pas d'adresse : Caddy ne sert rien.
  if (deploiement === "echec" && !attendu) return { etat: "panne", raison: "pas en ligne : dernier déploiement en échec, le conteneur tourne mais n'est pas servi" }
  if (!http?.code) {
    // Sous la charge d'une construction, un produit au repos peut rester muet : on le signale sans crier à la panne.
    return construction ? { etat: "alerte", raison: avec("ne répond pas à /api/health pendant une construction sur le serveur") } : { etat: "panne", raison: avec("ne répond pas à /api/health") }
  }
  if (http.code >= 300 && http.code < 400) return { etat: "alerte", raison: avec(`/api/health redirige (${http.code})`) }
  if (http.code < 200 || http.code >= 400) return { etat: "panne", raison: avec(`/api/health répond ${http.code}`) }
  if (deploiement === "echec") {
    // En production, la nouvelle couleur en échec est toujours supprimée : celle qui répond est la précédente.
    // Un aperçu est recréé sous le même nom : s'il a démarré après la demande, c'est la version en échec.
    const nouvelle = environnement === "apercu" && conteneur.demarre_apres_demande
    return { etat: "alerte", raison: nouvelle ? "dernier déploiement en échec : cette version a démarré trop lentement, elle répond maintenant" : "dernier déploiement en échec : la version précédente reste en ligne" }
  }
  if (bloque) return { etat: "alerte", raison: avec(`répond en ${http.ms} ms`) }
  if (conteneur.sante === "unhealthy") return { etat: "alerte", raison: avec("Docker le dit en mauvaise santé") }
  if (recents > 0) return { etat: "alerte", raison: avec(`a redémarré ${recents} fois en 30 min`) }
  if (http.ms > LENT_MS) return construction ? { etat: "ok", raison: avec(`lent pendant une construction : /api/health en ${http.ms} ms`) } : { etat: "alerte", raison: avec(`lent : /api/health en ${http.ms} ms`) }
  return { etat: "ok", raison: avec(`répond en ${http.ms} ms`) }
}

// Le conteneur qui représente un produit : celui que statut.json nomme. S'il en nomme un qui a
// disparu, aucun (une autre couleur restée là ne sert pas les visiteurs) ; s'il n'en nomme
// aucun, celui qui tourne, sinon le premier.
export function conteneurActif(siens, nomAttendu) {
  if (nomAttendu) return siens.find((c) => c.nom === nomAttendu) ?? null
  return siens.find((c) => c.etat === "running") ?? siens[0] ?? null
}

// Les conteneurs qu'un inspect n'a pas décrits : partis entre docker ps et docker inspect
// (« No such object: <nom> », nom exact), ou inconnus (inspect coupé, démon injoignable). Un
// seul inconnu suffit pour que le relevé ne vaille rien : on ne conclut jamais « absent » d'un échec.
export function inspectIncomplet(noms, conteneurs, sortie) {
  const decrits = new Set(conteneurs.map((c) => c.nom))
  const partis = new Set([...String(sortie ?? "").matchAll(/No such (?:object|container): ([^\s]+)/g)].map((m) => m[1]))
  return noms.some((n) => !decrits.has(n) && !partis.has(n))
}
