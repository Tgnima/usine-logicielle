// L'observabilité de l'orchestrateur (module commun : commun/observabilite.mjs).
//   - ses erreurs vers Sentry : console.error et les exceptions non attrapées (brancherProcessus) ;
//   - un battement de cœur par minute : le seul moniteur cron du plan gratuit de Sentry ;
//   - chaque ligne du journal (noter, db.mjs) devient un événement PostHog « journal » : le type,
//     le projet, la tâche, et ce qu'ils ont consommé (table consommations). Jamais le texte du message.
// Les clés sont des secrets (sentry_dsn, posthog_token : secrets.sh) ; sans elles, rien ne part.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { creerObservabilite } from "../../commun/observabilite.mjs"
import { secret } from "./config.mjs"

// La version de l'usine, telle que le déployeur la publie (sante.json), relue toutes les 5 min.
let version = { valeur: null, lue_le: 0 }
function versionUsine() {
  if (Date.now() - version.lue_le > 5 * 60_000) {
    let valeur = version.valeur
    try {
      valeur = JSON.parse(readFileSync(join(process.env.ETAT_DIR ?? "/app/etat", "sante.json"), "utf8")).mise_a_jour?.version ?? valeur
    } catch {}
    version = { valeur, lue_le: Date.now() }
  }
  return version.valeur
}

export const obs = creerObservabilite({
  sentryDsn: secret("sentry_dsn"),
  posthogJeton: secret("posthog_token"),
  posthogHote: process.env.POSTHOG_HOTE || "eu.i.posthog.com",
  service: "usine-orchestrateur",
  environnement: process.env.USINE_ENVIRONNEMENT || "production",
  version: versionUsine,
})

export const MONITEUR = "usine-orchestrateur"

// Au démarrage : les erreurs du processus, puis un battement tout de suite et chaque minute.
export function demarrerObservabilite() {
  obs.brancherProcessus()
  if (!obs.actif.sentry && !obs.actif.posthog) return console.log("Observabilité : pas de clé Sentry ni PostHog, rien n'est envoyé.")
  console.log(`Observabilité : ${[obs.actif.sentry && "Sentry (erreurs, battement de cœur)", obs.actif.posthog && "PostHog (journal)"].filter(Boolean).join(", ")}.`)
  if (!obs.actif.sentry) return
  const battre = () => obs.battement(MONITEUR).catch(() => {})
  battre()
  setInterval(battre, 60_000).unref()
}

// Les propriétés de l'événement d'une ligne du journal : des identifiants et des nombres, rien
// d'autre. Le cumul de la tâche (sinon du projet) : appels aux modèles, leur durée, l'équivalent API.
export function proprietesJournal(db, { projet = null, tache = null, type }) {
  const p = { type: String(type), projet: projet ?? null, tache: tache ?? null }
  try {
    if (projet) {
      const ligne = db.prepare("SELECT slug, statut FROM projets WHERE id = ?").get(projet)
      if (ligne) Object.assign(p, { produit: ligne.slug ?? null, statut_projet: ligne.statut })
    }
    if (tache) {
      const t = db.prepare("SELECT cle, lot, statut, tentative FROM taches WHERE id = ?").get(tache)
      if (t) Object.assign(p, { tache_cle: t.cle, lot: t.lot, statut_tache: t.statut, tentative: t.tentative })
    }
    const [colonne, id] = tache ? ["tache_id", tache] : projet ? ["projet_id", projet] : [null, null]
    if (colonne) {
      const c = db.prepare(`SELECT COUNT(*) AS appels, COALESCE(SUM(duree_s), 0) AS duree_s, SUM(cout_api_usd) AS cout_api_usd, COALESCE(SUM(entree + sortie), 0) AS jetons FROM consommations WHERE ${colonne} = ?`).get(id)
      Object.assign(p, { portee: tache ? "tache" : "projet", appels: c.appels, duree_modeles_s: Math.round(c.duree_s * 10) / 10, cout_api_usd: c.cout_api_usd === null ? null : Math.round(c.cout_api_usd * 10_000) / 10_000, jetons: c.jetons })
    }
  } catch {} // une base sans ces tables (tests) : l'événement part avec ce qu'on a
  return p
}

// Appelée par noter() : ne lève jamais, ne retarde rien (mise en file).
export function evenementJournal(db, ligne, instance = obs) {
  if (!instance.actif.posthog) return
  try {
    instance.evenement("journal", proprietesJournal(db, ligne))
  } catch {}
}
