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
// tête (sortie tronquée) n'a pas d'horodatage : elle est ignorée. Le niveau se lit sur toutes les
// lignes, celles déjà envoyées comprises : une trace commencée avant reste une erreur.
const HORODATAGE = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z) (.*)$/
export function lignesNouvelles(sortie, depuis = null) {
  const seuil = depuis ? BigInt(nanos(depuis)) : null
  const lues = []
  for (const brute of String(sortie ?? "").split("\n")) {
    const m = HORODATAGE.exec(brute.replace(/\r$/, ""))
    if (m && m[2].trim()) lues.push({ horodatage: m[1], texte: m[2] })
  }
  const niveaux = niveauxDe(lues.map((l) => l.texte))
  return lues.map((l, i) => ({ ...l, niveau: niveaux[i] })).filter((l) => seuil === null || BigInt(nanos(l.horodatage)) > seuil)
}

// Les exceptions, telles que Python et Node les écrivent quand un programme plante :
//   Python  « Traceback (most recent call last): », puis les cadres (« File "/app/x.py", line 3 »)
//           et le code, en retrait, puis « ZeroDivisionError: division by zero » ;
//   Node    « TypeError: Cannot read properties of undefined (reading 'x') », puis la pile
//           (« at f (/app/server/index.js:3:9) »), en retrait.
// La classe se reconnaît à son nom en tête de ligne (« KeyError: 'plan' », « sqlite3.OperationalError: … »,
// « TypeError [ERR_INVALID_ARG_TYPE]: … ») ; au milieu d'une phrase, elle ne compte pas.
const TRACE_PYTHON = /^\s*Traceback \(most recent call last\):/
const CADRE_PYTHON = /^\s+File "[^"]*", line \d+/
const EXCEPTION = /^\s*(?:[A-Za-z_$][\w$]*\.)*[A-Z][\w$]*(?:Error|Exception)(?: \[[A-Z0-9_]+\])?(?::|$)/
// CRITICAL, en majuscules : le niveau le plus haut de logging (Python) et de gunicorn.
const CRITIQUE = /^\s*CRITICAL\b|\[CRITICAL\]|\bCRITICAL:/
const AVERTISSEMENT = /^\s*(?:\(node:\d+\) )?(?:\[[A-Z0-9]+\] )?(?:[A-Za-z_][\w]*\.)*[A-Z]\w*Warning(?::|$)|\b[A-Z]\w*Warning: /

// Le niveau d'une ligne : docker logs mêle la sortie et les erreurs, le texte seul le dit.
// precedent : le niveau de la ligne d'avant. Une ligne en retrait qui suit une erreur la continue
// (la pile d'une exception, l'objet d'une erreur Node sur plusieurs lignes).
export function niveauDe(texte, precedent = null) {
  const t = String(texte ?? "")
  if (/\b(error|erreur|exception|fatal|uncaught|unhandled|ECONNREFUSED|EACCES)\b|échec/i.test(t)) return "error"
  if (TRACE_PYTHON.test(t) || CADRE_PYTHON.test(t) || EXCEPTION.test(t) || CRITIQUE.test(t)) return "error"
  if (precedent === "error" && /^\s+\S/.test(t)) return "error"
  if (/\b(warn|warning|attention|avertissement|deprecated)\b/i.test(t) || AVERTISSEMENT.test(t)) return "warn"
  return "info"
}

// Le niveau de chaque ligne, dans l'ordre. Une trace Python est une erreur de bout en bout : de
// « Traceback » à la ligne de l'exception, la première qui n'est plus en retrait (son nom ne finit
// pas toujours par Error : « KeyboardInterrupt », « django.core.exceptions.ImproperlyConfigured: … »).
export function niveauxDe(textes) {
  let precedent = null
  let trace = false
  return textes.map((texte) => {
    let n
    if (trace) {
      n = "error"
      if (!/^\s/.test(texte)) trace = TRACE_PYTHON.test(texte)
    } else {
      n = niveauDe(texte, precedent)
      trace = TRACE_PYTHON.test(texte)
    }
    precedent = n
    return n
  })
}
