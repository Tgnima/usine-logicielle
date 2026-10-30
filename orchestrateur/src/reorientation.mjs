// Réorienter un projet en cours de fabrication : « /usine reorienter <n°> : <nouvelle direction> ».
//
//   1. la fabrication du projet s'arrête après la tâche en cours (statut « reorientation ») ;
//   2. l'analyste refait la suite du plan : les lots déjà fabriqués sont gardés tels quels,
//      les tâches pas encore faites sont reprises ou laissées, selon la nouvelle direction ;
//   3. le plan repasse « à valider » : valider abandonne les tâches non faites, ouvre les
//      nouvelles et relance la fabrication ; « garder l'ancien plan » remet tout comme avant.
//
// La demande vit dans le réglage reorientation_<id> (elle survit à un redémarrage).
import { maj, noter, obtenir, plan as lirePlan, taches } from "./db.mjs"
import { ecrireReglage, enregistrer, lireReglage } from "./couts.mjs"
import { analyserReorientation, planEnMarkdown } from "./analyste.mjs"
import { designEnMarkdown } from "./design.mjs"
import { ouvrirTaches } from "./creation.mjs"
import { ajouterEtiquettes, commenter, creerEtiquettes, ecrireFichierDepot, fermerIssue, retirerEtiquette } from "./github.mjs"
import { apresFusion, retirerFile } from "./livraison.mjs"
import { brancheDeBase, lireProfil } from "./profil.mjs"
import { icpEnMarkdown, lirePersona, missionEnMarkdown, obtenirPersona, personaEnTexte } from "./personas.mjs"

export const STATUTS_REORIENTABLES = ["fabrication", "bloque"]
const cle = (projetId) => `reorientation_${Number(projetId)}`
const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const enPreparation = new Set() // les projets dont la suite est en train d'être refaite

export function lireReorientation(db, projetId) {
  try {
    return JSON.parse(lireReglage(db, cle(projetId), "") || "null")
  } catch {
    return null
  }
}
const ecrire = (db, projetId, r) => ecrireReglage(db, cle(projetId), JSON.stringify(r))
const effacer = (db, projetId) => db.prepare("DELETE FROM reglages WHERE cle = ?").run(cle(projetId))

// Les lots gardés : jusqu'au dernier qui a une tâche fusionnée (son code existe), tels quels.
// Le plus grand numéro de tâche employé : les nouvelles clés viennent après (les issues des
// tâches abandonnées gardent les leurs).
export function partager(plan, toutes) {
  const garde = Math.max(0, ...toutes.filter((t) => t.statut === "fusionnee").map((t) => t.lot))
  const derniere = Math.max(0, ...plan.lots.flatMap((l) => l.taches.map((t) => Number(t.cle.slice(1)))), ...toutes.map((t) => Number(String(t.cle).slice(1)) || 0))
  const nonFaites = toutes.filter((t) => !["fusionnee", "abandonnee"].includes(t.statut))
  return { garde, gardes: plan.lots.slice(0, garde), nonFaites, derniere }
}

// Le plan réorienté : les lots gardés, puis les nouveaux ; nom, slug et brique ne bougent pas (le dépôt existe).
export function fusionner(plan, gardes, r) {
  const nouveau = { ...plan, lots: [...gardes, ...r.lots] }
  for (const champ of ["resume", "criteres_globaux", "hors_perimetre", "risques", "sens", "design"]) if (r[champ] !== undefined && r[champ] !== null) nouveau[champ] = r[champ]
  return nouveau
}

export function reorienterProjet(ctx, projetId, { consigne, personaId = null, par = "?" }) {
  const { db } = ctx
  const projet = obtenir(db, "projets", projetId)
  if (!projet || projet.statut === "supprime") return { ok: false, message: `Pas de projet ${projetId}.` }
  if (lireReorientation(db, projetId)) return { ok: false, message: "Une réorientation est déjà en cours sur ce projet : valide le nouveau plan, révise-le, ou garde l'ancien." }
  if (!STATUTS_REORIENTABLES.includes(projet.statut)) {
    const conseil = ["livre", "en_production"].includes(projet.statut) ? " Le produit est livré : décris l'évolution voulue (`/usine corriger`), l'analyste ajoutera un lot." : ["questions", "plan_a_valider"].includes(projet.statut) ? " Son plan n'est pas encore validé : corrige-le directement." : ""
    return { ok: false, message: `Le projet ${projetId} est « ${projet.statut} » : seule une fabrication en cours se réoriente.${conseil}` }
  }
  const texte = String(consigne ?? "").trim()
  if (texte.length < 10) return { ok: false, message: "Décris la nouvelle direction (10 caractères au moins)." }
  if (texte.length > 6000) return { ok: false, message: "La nouvelle direction est trop longue (6 000 caractères au plus)." }
  if (personaId !== null) {
    const p = obtenirPersona(db, personaId)
    if (!p || p.statut !== "valide") return { ok: false, message: "Ce persona n'est pas validé : relis sa fiche et valide-la d'abord." }
  }
  // Les demandes mises en file pendant la fabrication partent avec la réorientation, pas après la livraison.
  const enFile = retirerFile(db, projetId)
  const complete = enFile.length ? `${texte}\n\nDemandes reçues pendant la fabrication :\n${enFile.map((d) => `- ${d.texte}`).join("\n")}` : texte
  ecrire(db, projetId, { consigne: complete, persona_id: personaId, par, le: new Date().toISOString(), statut_avant: projet.statut, plan_avant: projet.plan })
  maj(db, "projets", projetId, { statut: "reorientation" })
  db.prepare("INSERT INTO decisions (projet_id, question, reponse, par) VALUES (?, ?, ?, ?)").run(projetId, "Réorientation demandée", complete, par)
  noter(db, { projet: projetId, type: "reorientation", message: `Réorientation demandée par ${par} : ${complete}` })
  const enCours = taches(db, projetId).find((t) => ["en_cours", "verification"].includes(t.statut))
  ctx.notifier.etape(projet, `:twisted_rightwards_arrows: *Réorientation* demandée par ${par} :\n>${complete.replace(/\n/g, "\n>")}\n${enCours ? `L'usine termine ${enCours.cle} (en cours), puis` : "La fabrication est en pause :"} l'analyste refait la suite du plan. Les lots déjà fabriqués sont gardés ; tu valideras le nouveau plan avant que la fabrication reprenne.`).catch(() => {})
  preparer(ctx, projetId).catch((e) => console.error("Réorientation :", e))
  return { ok: true, message: enCours ? `Réorientation enregistrée : l'usine termine ${enCours.cle}, puis l'analyste refait la suite du plan.` : "Réorientation enregistrée : l'analyste refait la suite du plan." }
}

// Attendre la fin de la tâche en cours, puis faire refaire la suite du plan par l'analyste.
// options : { retours } pour une révision de la proposition.
export async function preparer(ctx, projetId, { retours = null } = {}) {
  const { db, config } = ctx
  if (enPreparation.has(projetId)) return
  enPreparation.add(projetId)
  try {
    while (taches(db, projetId).some((t) => ["en_cours", "verification"].includes(t.statut))) {
      if (!lireReorientation(db, projetId)) return // gardé l'ancien plan entre-temps
      await pause(15_000)
    }
    const r = lireReorientation(db, projetId)
    if (!r) return
    const projet = obtenir(db, "projets", projetId)
    const planAvant = JSON.parse(r.plan_avant)
    const { garde, gardes, nonFaites, derniere } = partager(planAvant, taches(db, projetId))
    const personaId = r.persona_id ?? projet.persona_id
    const persona = personaId ? lirePersona(obtenirPersona(db, personaId)) : null
    await ctx.notifier.etape(projet, `:brain: L'analyste refait la suite du plan (${garde ? `lot${garde > 1 ? "s" : ""} 1${garde > 1 ? ` à ${garde}` : ""} gardé${garde > 1 ? "s" : ""}` : "rien n'est encore fabriqué"}, ${nonFaites.length} tâche(s) non faite(s) à revoir)…`)
    const mesurer = (usages, duree_s) => enregistrer(db, { projet: projetId, role: "analyste", moteur: "claude-code", usages, duree_s })
    const proposition = retours && projet.plan ? JSON.stringify({ ...lirePlan(projet), lots: lirePlan(projet).lots.slice(garde) }) : null
    const objet = await analyserReorientation(config, projet, planAvant, { gardes, nonFaites, derniere, consigne: r.consigne, persona: persona ? personaEnTexte(persona) : null, proposition, retours, mesurer, ctx })
    // Gardé l'ancien plan pendant l'analyse : la proposition ne sert plus.
    if (!lireReorientation(db, projetId)) return
    const plan = fusionner(planAvant, gardes, objet)
    if (persona) plan.persona = persona.nom
    ecrire(db, projetId, { ...lireReorientation(db, projetId), garde })
    maj(db, "projets", projetId, { statut: "plan_a_valider", plan: JSON.stringify(plan) })
    noter(db, { projet: projetId, type: "plan", message: `Nouveau plan de réorientation : ${garde} lot(s) gardé(s), ${objet.lots.length} nouveau(x), ${nonFaites.length} tâche(s) non faite(s) abandonnée(s) à la validation` })
    return ctx.notifier.plan(obtenir(db, "projets", projetId), { ...plan, reorientation: { garde, abandonnees: nonFaites.map((t) => t.cle) } })
  } catch (error) {
    noter(db, { projet: projetId, type: "erreur", message: `Réorientation : ${error.message}` })
    await ctx.notifier.etape(obtenir(db, "projets", projetId), `:x: L'analyste n'a pas pu refaire le plan : ${error.message.slice(0, 600)}\nLa fabrication reste en pause. Relance avec \`/usine relancer ${projetId}\`, ou garde l'ancien plan (bouton « Garder l'ancien plan » de la console).`).catch(() => {})
  } finally {
    enPreparation.delete(projetId)
  }
}

// Valider le nouveau plan : les tâches non faites sont abandonnées, les nouvelles ouvertes,
// le cadre du dépôt (plan, mission, persona, design) réécrit, et la fabrication reprend.
export async function validerReorientation(ctx, projetId, par) {
  const { config, db } = ctx
  const r = lireReorientation(db, projetId)
  const projet = obtenir(db, "projets", projetId)
  if (!r || projet?.statut !== "plan_a_valider" || r.garde === undefined) return { ok: false, message: "Ce projet n'a pas de plan de réorientation à valider." }
  const plan = lirePlan(projet)
  const nomDepot = projet.depot
  const branche = brancheDeBase(projet)
  maj(db, "projets", projetId, { statut: "creation" })
  ;(async () => {
    try {
      // 1. Ce qui n'était pas fait est abandonné (les issues sont fermées, avec la raison).
      const abandonnees = taches(db, projetId).filter((t) => ["attente", "prete", "bloquee"].includes(t.statut))
      for (const t of abandonnees) {
        maj(db, "taches", t.id, { statut: "abandonnee" })
        for (const e of ["usine:attente", "usine:bloquant"]) await retirerEtiquette(config, nomDepot, t.issue, e).catch(() => {})
        await ajouterEtiquettes(config, nomDepot, t.issue, ["usine:abandonnee"]).catch(() => {})
        await commenter(config, nomDepot, t.issue, `Abandonnée : le projet a été réorienté par ${par}. La suite est dans docs/PLAN.md.`).catch(() => {})
        await fermerIssue(config, nomDepot, t.issue).catch(() => {})
      }
      // 2. Les décisions qui attendaient ces tâches n'ont plus d'objet.
      for (const e of db.prepare("SELECT * FROM escalades WHERE projet_id = ? AND statut = 'ouverte'").all(projetId)) {
        db.prepare("UPDATE escalades SET statut = 'resolue' WHERE id = ?").run(e.id)
        if (e.issue) {
          await commenter(config, nomDepot, e.issue, `Sans objet : le projet a été réorienté par ${par}.`).catch(() => {})
          await fermerIssue(config, nomDepot, e.issue).catch(() => {})
        }
      }
      // 3. Le persona, s'il change, et le cadre du dépôt.
      const personaId = r.persona_id ?? projet.persona_id
      if (r.persona_id) maj(db, "projets", projetId, { persona_id: r.persona_id })
      const persona = personaId ? lirePersona(obtenirPersona(db, personaId)) : null
      const p = obtenir(db, "projets", projetId)
      const message = `Réorientation validée par ${par}`
      await ecrireFichierDepot(config, nomDepot, "docs/PLAN.md", planEnMarkdown(plan), `${message} : plan`, branche)
      await ecrireFichierDepot(config, nomDepot, ".usine/plan.json", `${JSON.stringify(plan, null, 2)}\n`, `${message} : plan`, branche)
      await ecrireFichierDepot(config, nomDepot, "MISSION.md", missionEnMarkdown(plan, { persona, repris: Boolean(p.origine), pile: lireProfil(p).pile }), `${message} : mission`, branche)
      if (persona) await ecrireFichierDepot(config, nomDepot, "ICP.md", icpEnMarkdown(persona), `${message} : persona`, branche)
      if (plan.design) await ecrireFichierDepot(config, nomDepot, "docs/DESIGN.md", designEnMarkdown(plan), `${message} : design`, branche)
      // 4. Les nouveaux lots : leurs étiquettes et leurs issues.
      const nouveaux = plan.lots.slice(r.garde)
      await creerEtiquettes(config, nomDepot, nouveaux.map((l, i) => [`lot:${r.garde + i + 1}`, "ededed", l.nom.slice(0, 90)]))
      for (const [i, lot] of nouveaux.entries()) await ouvrirTaches(ctx, projetId, nomDepot, lot, r.garde + i + 1)
      // 5. La fabrication reprend, avec la nouvelle direction dans les décisions que lisent les agents.
      db.prepare("INSERT INTO decisions (projet_id, question, reponse, par) VALUES (?, ?, ?, ?)").run(projetId, "Réorientation (nouvelle direction)", r.consigne, par)
      maj(db, "projets", projetId, { statut: "fabrication", debut_fabrication: new Date().toISOString() })
      effacer(db, projetId)
      const n = nouveaux.reduce((s, l) => s + l.taches.length, 0)
      noter(db, { projet: projetId, type: "validation", message: `${message} : ${abandonnees.length} tâche(s) abandonnée(s), ${nouveaux.length} lot(s) et ${n} tâche(s) ajoutés` })
      await ctx.notifier.etape(obtenir(db, "projets", projetId), `:white_check_mark: ${message}. ${abandonnees.length ? `${abandonnees.length} tâche(s) non faite(s) abandonnée(s), ` : ""}${n} nouvelle(s) tâche(s) en ${nouveaux.length} lot(s). La fabrication reprend au lot ${r.garde + 1}.`)
      // Un lot gardé qui vient d'être soldé par les abandons : son aperçu part maintenant.
      if (r.garde > 0) await apresFusion(ctx, projetId, r.garde).catch((e) => console.error("Réorientation, aperçu :", e.message))
    } catch (error) {
      // Rien n'est perdu : tout ce qui précède se rejoue sans doublon (issues, abandons).
      maj(db, "projets", projetId, { statut: "plan_a_valider" })
      noter(db, { projet: projetId, type: "erreur", message: `Réorientation : ${error.message}` })
      await ctx.notifier.etape(projet, `:x: La réorientation n'a pas pu être appliquée : ${error.message.slice(0, 600)}\nValide à nouveau le plan : ce qui a déjà été fait n'est pas refait.`).catch(() => {})
    }
  })().catch((e) => console.error(e))
  return { ok: true, message: "Réorientation validée : l'usine ouvre les nouvelles tâches et reprend la fabrication." }
}

// Garder l'ancien plan : tout redevient comme avant la demande (les tâches non faites reprennent).
export function abandonnerReorientation(ctx, projetId, par) {
  const { db } = ctx
  const r = lireReorientation(db, projetId)
  if (!r) return { ok: false, message: "Ce projet n'est pas en réorientation." }
  effacer(db, projetId)
  maj(db, "projets", projetId, { statut: r.statut_avant ?? "fabrication", plan: r.plan_avant })
  noter(db, { projet: projetId, type: "abandon", message: `Réorientation abandonnée par ${par} : la fabrication reprend sur l'ancien plan` })
  ctx.notifier.etape(obtenir(db, "projets", projetId), `:leftwards_arrow_with_hook: Réorientation abandonnée par ${par} : la fabrication reprend sur l'ancien plan.`).catch(() => {})
  return { ok: true, message: "Réorientation abandonnée : la fabrication reprend sur l'ancien plan." }
}

// Réviser la proposition (comme on corrige un plan avant sa validation).
export function reviserReorientation(ctx, projetId, retours, par) {
  const { db } = ctx
  const r = lireReorientation(db, projetId)
  if (!r || obtenir(db, "projets", projetId)?.statut !== "plan_a_valider") return { ok: false, message: "Ce projet n'a pas de plan de réorientation à réviser." }
  db.prepare("INSERT INTO decisions (projet_id, question, reponse, par) VALUES (?, ?, ?, ?)").run(projetId, "Corrections du plan", retours, par)
  maj(db, "projets", projetId, { statut: "reorientation" })
  preparer(ctx, projetId, { retours }).catch((e) => console.error("Réorientation :", e))
  return { ok: true, message: "Corrections transmises à l'analyste." }
}

// Relancer une réorientation dont l'analyse a échoué (ou après un redémarrage).
export function relancerReorientation(ctx, projetId) {
  if (enPreparation.has(projetId)) return { ok: false, message: "L'analyste refait déjà la suite du plan." }
  if (!lireReorientation(ctx.db, projetId)) return { ok: false, message: "Ce projet n'est pas en réorientation." }
  preparer(ctx, projetId).catch((e) => console.error("Réorientation :", e))
  return { ok: true, message: "Réorientation relancée : l'analyste refait la suite du plan." }
}
