// Le message de suivi d'un projet : UN message dans le fil, mis à jour en direct
// (lot, tâche en cours, avancement, dernières étapes), au lieu d'une suite de
// messages. Les vrais signaux (plan, décision, lot livré, rapport) restent des
// messages à part. Les captures d'écran d'un lot sont gardées ici pour Slack.
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ecrireReglage, lireReglage } from "./couts.mjs"
import { obtenir, plan as lirePlan, taches } from "./db.mjs"
import { lireFichierBinaire } from "./travaux.mjs"

const cle = (projetId) => `suivi_${projetId}`

// Les dernières étapes (6), gardées en base pour survivre à un redémarrage.
export function ajouterEtape(db, projetId, ligne) {
  let etapes = []
  try {
    etapes = JSON.parse(lireReglage(db, cle(projetId), "[]"))
  } catch {}
  const heure = new Date().toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })
  etapes.push(`${heure} ${ligne}`)
  ecrireReglage(db, cle(projetId), JSON.stringify(etapes.slice(-6)))
}

export function texteSuivi(db, projetId) {
  const projet = obtenir(db, "projets", projetId)
  const plan = lirePlan(projet) ?? { lots: [] }
  const tout = taches(db, projetId)
  const finies = tout.filter((t) => ["fusionnee", "abandonnee"].includes(t.statut)).length
  const enCours = tout.find((t) => ["en_cours", "verification"].includes(t.statut))
  const lotActuel = enCours?.lot ?? Math.min(plan.lots.length, (projet.lot_livre ?? 0) + 1)
  const barre = (n, total, largeur = 14) => {
    const plein = total ? Math.round((n / total) * largeur) : 0
    return "🟩".repeat(plein) + "⬜".repeat(largeur - plein)
  }
  let etapes = []
  try {
    etapes = JSON.parse(lireReglage(db, cle(projetId), "[]"))
  } catch {}
  const enTete = projet.statut === "fabrication" || projet.statut === "creation"
    ? `:factory: *Fabrication de ${projet.nom ?? "ce projet"}* · lot ${lotActuel}/${plan.lots.length}${plan.lots[lotActuel - 1] ? ` : ${plan.lots[lotActuel - 1].nom}` : ""}`
    : `:factory: *${projet.nom ?? "Projet"}* · ${projet.statut}`
  return [
    enTete,
    `${barre(finies, tout.length)}  ${finies}/${tout.length} tâches`,
    enCours ? `En cours : *${enCours.cle}* · ${enCours.titre} (${enCours.statut === "verification" ? "en vérification" : "l'agent code"}${enCours.tentative ? `, correction ${enCours.tentative}` : ""}${enCours.approche ? `, approche ${enCours.approche + 1}` : ""})` : "",
    etapes.length ? `\n${etapes.map((e) => `› ${e}`).join("\n")}` : "",
    "_Ce message se met à jour tout seul. Les décisions et les livraisons arrivent en messages à part._",
  ].filter(Boolean).join("\n")
}

// --- Les captures d'écran -------------------------------------------------------------

const dossierCaptures = (config, projetId, cleTache) => join(config.dataDir, "captures", String(projetId), cleTache ?? "")

// Après une vérification réussie : les captures du vérificateur sont gardées pour le lot.
export async function garderCaptures(ctx, projetId, cleTache, noms = []) {
  const dossier = dossierCaptures(ctx.config, projetId, cleTache)
  mkdirSync(dossier, { recursive: true })
  let n = 0
  for (const nom of noms.filter((x) => /^[\w.-]+\.png$/.test(x)).slice(0, 6)) {
    const contenu = await lireFichierBinaire(ctx.config.verificateur.url, ctx.config.secrets.worker, `/tmp/sorties/verif/captures/${nom}`).catch(() => null)
    if (contenu?.length) {
      writeFileSync(join(dossier, nom), contenu)
      n += 1
    }
  }
  return n
}

// Les captures d'un lot, pour Slack : d'abord celles sur ordinateur, les plus récentes, 4 au plus.
export function capturesDuLot(ctx, projetId, lot) {
  const cles = taches(ctx.db, projetId).filter((t) => t.lot === lot && t.statut === "fusionnee").map((t) => t.cle)
  const fichiers = []
  for (const c of cles) {
    const d = dossierCaptures(ctx.config, projetId, c)
    if (!existsSync(d)) continue
    for (const f of readdirSync(d).filter((x) => x.endsWith(".png"))) fichiers.push({ chemin: join(d, f), nom: `${c}-${f}`, bureau: /bureau|desktop|1440/i.test(f), date: statSync(join(d, f)).mtimeMs })
  }
  return fichiers.sort((a, b) => Number(b.bureau) - Number(a.bureau) || b.date - a.date).slice(0, 4)
}
