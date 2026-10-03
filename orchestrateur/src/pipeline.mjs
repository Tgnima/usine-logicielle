// Les actions de l'usine, appelées par Slack, par l'API locale ou par la CLI.
// Étage 1 : une demande -> l'analyste -> des questions ou un plan -> validation humaine.
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { maj, noter, obtenir, plan as lirePlan, taches } from "./db.mjs"
import { analyser } from "./analyste.mjs"
import { creerProduit } from "./creation.mjs"
import { adresses } from "./config.mjs"
import { enregistrer } from "./couts.mjs"

export async function nouveauProjet(ctx, { prompt, demandeur = "?", canal = null, fil = null }) {
  const id = Number(ctx.db.prepare("INSERT INTO projets (prompt, demandeur, canal, fil) VALUES (?, ?, ?, ?)").run(prompt, demandeur, canal, fil).lastInsertRowid)
  noter(ctx.db, { projet: id, type: "demande", message: prompt })
  lancerAnalyse(ctx, id).catch((e) => console.error(e))
  return id
}

// L'analyse tourne en tâche de fond ; le résultat arrive par le notificateur.
export async function lancerAnalyse(ctx, projetId, options = {}) {
  const { db } = ctx
  maj(db, "projets", projetId, { statut: "analyse" })
  const projet = obtenir(db, "projets", projetId)
  await ctx.notifier.etape(projet, ":brain: L'analyste étudie la demande et prépare le plan de fabrication…")
  try {
    const mesurer = (usages, duree_s) => enregistrer(db, { projet: projetId, role: "analyste", moteur: "claude-code", usages, duree_s })
    const { plan, tokens } = await analyser(ctx.config, projet, { ...options, mesurer })
    noter(db, { projet: projetId, type: "analyse", message: `Plan reçu (${tokens} jetons) : ${plan.lots?.length ?? 0} lot(s), ${plan.questions?.length ?? 0} question(s)` })
    if (plan.questions?.length && !plan.lots?.length) {
      maj(db, "projets", projetId, { statut: "questions", plan: JSON.stringify(plan) })
      return ctx.notifier.questions(obtenir(db, "projets", projetId), plan.questions)
    }
    // Un slug déjà pris par un autre projet reçoit un suffixe.
    // (Certains noms sont réservés aux adresses de l'usine elle-même.)
    const pris = ["mails", "usine-tableau"].includes(plan.slug) || db.prepare("SELECT 1 FROM projets WHERE slug = ? AND id != ?").get(plan.slug, projetId)
    if (pris) plan.slug = `${plan.slug.slice(0, 17)}-${projetId}`
    maj(db, "projets", projetId, { statut: "plan_a_valider", plan: JSON.stringify(plan), nom: plan.nom, slug: plan.slug })
    return ctx.notifier.plan(obtenir(db, "projets", projetId), plan)
  } catch (error) {
    maj(db, "projets", projetId, { statut: "echec" })
    noter(db, { projet: projetId, type: "erreur", message: error.message })
    return ctx.notifier.etape(projet, `:x: L'analyse a échoué : ${error.message.slice(0, 800)}\nRelance avec \`/usine relancer ${projetId}\`.`)
  }
}

export async function repondreQuestions(ctx, projetId, reponses, par) {
  const projet = obtenir(ctx.db, "projets", projetId)
  if (projet?.statut !== "questions") return { ok: false, message: "Ce projet n'attend pas de réponses." }
  const plan = lirePlan(projet)
  const texte = plan.questions.map((q, i) => `${q}\n→ ${reponses[i] ?? reponses}`).join("\n")
  ctx.db.prepare("INSERT INTO decisions (projet_id, question, reponse, par) VALUES (?, ?, ?, ?)").run(projetId, "Questions de l'analyste", texte, par)
  lancerAnalyse(ctx, projetId, { reponses: texte }).catch((e) => console.error(e))
  return { ok: true, message: "Réponses transmises à l'analyste." }
}

export async function corrigerPlan(ctx, projetId, retours, par) {
  const projet = obtenir(ctx.db, "projets", projetId)
  if (projet?.statut !== "plan_a_valider") return { ok: false, message: "Ce plan n'est pas en attente de validation." }
  ctx.db.prepare("INSERT INTO decisions (projet_id, question, reponse, par) VALUES (?, ?, ?, ?)").run(projetId, "Corrections du plan", retours, par)
  const reponses = ctx.db.prepare("SELECT reponse FROM decisions WHERE projet_id = ? AND question = 'Questions de l''analyste' ORDER BY id DESC").get(projetId)?.reponse
  lancerAnalyse(ctx, projetId, { retours, planPrecedent: projet.plan, reponses }).catch((e) => console.error(e))
  return { ok: true, message: "Corrections transmises à l'analyste." }
}

// Première porte humaine : le plan est validé, l'usine fabrique seule jusqu'à la livraison.
export async function validerPlan(ctx, projetId, par) {
  const { db } = ctx
  const projet = obtenir(db, "projets", projetId)
  if (projet?.statut !== "plan_a_valider") return { ok: false, message: "Ce plan n'est pas en attente de validation." }
  maj(db, "projets", projetId, { statut: "creation" })
  db.prepare("INSERT INTO decisions (projet_id, question, reponse, par) VALUES (?, ?, ?, ?)").run(projetId, "Plan de fabrication", "validé", par)
  noter(db, { projet: projetId, type: "validation", message: `Plan validé par ${par}` })
  ;(async () => {
    await ctx.notifier.etape(projet, `:white_check_mark: Plan validé par ${par}. Création du dépôt et du socle…`)
    try {
      await creerProduit(ctx, projetId)
      const p = obtenir(db, "projets", projetId)
      const n = taches(db, projetId).length
      await ctx.notifier.etape(p, `:building_construction: Dépôt <https://github.com/${p.depot}|${p.depot}> créé, socle vérifié, ${n} issues ouvertes. La fabrication commence ; je ne reviens vers toi que si une décision est nécessaire, puis à la livraison.\nAperçus : ${adresses(ctx.config, p.slug).apercu}`)
    } catch (error) {
      maj(db, "projets", projetId, { statut: "echec" })
      noter(db, { projet: projetId, type: "erreur", message: error.message })
      await ctx.notifier.etape(projet, `:x: La création du produit a échoué : ${error.message.slice(0, 800)}`)
    }
  })()
  return { ok: true, message: "Plan validé." }
}

// Un plan qui ne correspond pas à la demande : on l'abandonne, rien n'a encore été créé.
export function abandonnerPlan(ctx, projetId, par) {
  const projet = obtenir(ctx.db, "projets", projetId)
  if (!["plan_a_valider", "questions", "echec"].includes(projet?.statut)) return { ok: false, message: "Seul un plan pas encore validé peut être abandonné." }
  maj(ctx.db, "projets", projetId, { statut: "abandonne" })
  noter(ctx.db, { projet: projetId, type: "abandon", message: `Plan abandonné par ${par}` })
  return { ok: true, message: "Plan abandonné." }
}

export function arreter(ctx, par) {
  writeFileSync(join(ctx.config.dataDir, "STOP"), `${par} ${new Date().toISOString()}\n`)
  return { ok: true, message: "Usine à l'arrêt après la tâche en cours. `/usine reprendre` pour repartir." }
}

export function reprendre(ctx) {
  const f = join(ctx.config.dataDir, "STOP")
  if (existsSync(f)) rmSync(f)
  return { ok: true, message: "L'usine reprend." }
}

export function statut(ctx) {
  const { db } = ctx
  const projets = db.prepare("SELECT * FROM projets ORDER BY id DESC LIMIT 10").all()
  return projets.map((p) => {
    const t = taches(db, p.id)
    const compte = (s) => t.filter((x) => x.statut === s).length
    const enCours = t.find((x) => ["en_cours", "verification"].includes(x.statut))
    return {
      id: p.id,
      nom: p.nom ?? p.prompt.slice(0, 60),
      statut: p.statut,
      depot: p.depot,
      taches: t.length,
      fusionnees: compte("fusionnee"),
      bloquees: compte("bloquee"),
      abandonnees: compte("abandonnee"),
      en_cours: enCours ? `${enCours.cle} · ${enCours.titre} (${enCours.statut})` : null,
      lot_livre: p.lot_livre,
      apercu: p.slug ? adresses(ctx.config, p.slug).apercu : null,
      escalades: db.prepare("SELECT id, raison, issue FROM escalades WHERE projet_id = ? AND statut = 'ouverte'").all(p.id),
    }
  })
}

// Au démarrage : ce qui était en cours lors d'un arrêt brutal est repris proprement.
export function reprise(ctx) {
  const { db } = ctx
  const n = db.prepare("UPDATE taches SET statut = 'prete' WHERE statut IN ('en_cours', 'verification')").run().changes
  if (n) console.log(`Reprise : ${n} tâche(s) interrompue(s) remise(s) en file.`)
  for (const p of db.prepare("SELECT id FROM projets WHERE statut = 'analyse'").all()) lancerAnalyse(ctx, p.id).catch((e) => console.error(e))
}
