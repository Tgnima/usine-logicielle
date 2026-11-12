// Ce que le déployeur dit de chaque produit à PostHog et à Sentry : l'état jugé par la sonde
// (sonde.mjs), les déploiements, les journaux des conteneurs. Fonctions pures, sans Docker ni
// réseau : testées par test/observation.test.mjs. Le déployeur (server.mjs) envoie le résultat
// par le module commun (commun/observabilite.mjs).
import { nanos } from "../commun/observabilite.mjs"

// Un événement etat_produit pour chaque produit toutes les 5 min, et à chaque changement d'état.
export const PERIODE_ETAT_MS = 5 * 60_000

// Les propriétés d'un état : ce que la sonde a mesuré. La raison est écrite par la sonde
// elle-même (« répond en 40 ms », « arrêté (exited, code de sortie 1) »), jamais par le produit.
export function proprietesEtat(cle, p) {
  const [environnement, produit] = cle.split("/")
  return {
    produit,
    environnement,
    etat: p.etat,
    raison: p.raison ?? null,
    version: p.version ?? null,
    deploiement: p.deploiement ?? null,
    http_code: p.http?.code ?? null,
    http_ms: p.http?.ms ?? null,
    docker_etat: p.docker?.etat ?? null,
    redemarrages_30_min: p.docker?.redemarrages_30_min ?? null,
    oom: p.docker?.oom ?? null,
  }
}

// memoire : Map clé -> { etat, vu (fois de suite), confirme, envoye_le }, gardée d'une sonde à l'autre.
// Renvoie les événements etat_produit à envoyer, et les incidents : un produit dont l'état
// confirmé devient « panne ». Confirmé : vu deux sondes de suite, comme les alertes Slack
// (sante.mjs) ; une minute de silence passagère ne réveille personne.
// produits null (Docker injoignable) : rien n'est conclu, la mémoire est gardée.
export function suivreEtats(memoire, produits, maintenant = Date.now()) {
  const evenements = []
  const incidents = []
  if (!produits) return { evenements, incidents }
  for (const [cle, p] of Object.entries(produits)) {
    const m = memoire.get(cle) ?? { etat: null, vu: 0, confirme: null, envoye_le: 0 }
    const change = m.etat !== p.etat
    const vu = change ? 1 : m.vu + 1
    let confirme = m.confirme
    if (vu >= 2 && confirme !== p.etat) {
      if (p.etat === "panne") incidents.push(proprietesEtat(cle, p))
      confirme = p.etat
    }
    let envoye = m.envoye_le
    if (change || maintenant - m.envoye_le >= PERIODE_ETAT_MS) {
      evenements.push({ ...proprietesEtat(cle, p), changement: change, precedent: change ? m.etat : null })
      envoye = maintenant
    }
    memoire.set(cle, { etat: p.etat, vu, confirme, envoye_le: envoye })
  }
  // Un produit retiré n'est plus suivi.
  for (const cle of [...memoire.keys()]) if (!(cle in produits)) memoire.delete(cle)
  return { evenements, incidents }
}

// L'événement d'un déploiement : réussi, en échec, ou abandonné (interrompu trop souvent).
// La raison d'un échec : sa première ligne seulement (la suite peut contenir le journal du produit).
export function proprietesDeploiement(s, resultat, { debut = null, fin = Date.now(), reprise = false, couleur = null, erreur = null } = {}) {
  return {
    produit: s.produit,
    environnement: s.environnement === "apercu" ? "apercu" : "production",
    resultat,
    version: String(s.sha ?? "").slice(0, 12) || null,
    duree_s: typeof debut === "number" ? Math.round((fin - debut) / 100) / 10 : null,
    reprise: Boolean(reprise),
    couleur,
    acces: s.acces ?? "protege",
    donnees: s.donnees ?? null,
    emails: s.emails ?? null,
    raison: erreur ? String(erreur.message ?? erreur).split("\n")[0].slice(0, 200) : null,
  }
}

// docker logs --timestamps : « 2026-11-10T10:00:00.123456789Z texte ». Les lignes plus récentes
// que depuis (l'horodatage de la dernière ligne déjà envoyée), dans l'ordre. Une ligne coupée en
// tête (sortie tronquée) n'a pas d'horodatage : elle est ignorée.
const HORODATAGE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z) (.*)$/
export function lignesNouvelles(sortie, depuis = null) {
  const seuil = depuis ? BigInt(nanos(depuis)) : null
  const lignes = []
  for (const brute of String(sortie ?? "").split("\n")) {
    const m = HORODATAGE.exec(brute.replace(/\r$/, ""))
    if (!m || !m[2].trim()) continue
    if (seuil !== null && BigInt(nanos(m[1])) <= seuil) continue
    lignes.push({ horodatage: m[1], texte: m[2], niveau: niveauDe(m[2]) })
  }
  return lignes
}

// Le niveau d'une ligne : docker logs mêle la sortie et les erreurs, le texte seul le dit.
export function niveauDe(texte) {
  if (/\b(error|erreur|exception|fatal|uncaught|unhandled|ECONNREFUSED|EACCES)\b|échec/i.test(texte)) return "error"
  if (/\b(warn|warning|attention|avertissement|deprecated)\b/i.test(texte)) return "warn"
  return "info"
}
