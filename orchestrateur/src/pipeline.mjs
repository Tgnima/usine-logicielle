// Les actions de l'usine, appelées par Slack, par l'API locale ou par la CLI.
// Étage 1 : une demande -> l'analyste -> des questions ou un plan -> validation humaine.
import { existsSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { maj, noter, obtenir, plan as lirePlan, taches } from "./db.mjs"
import { analyser } from "./analyste.mjs"
import { creerProduit } from "./creation.mjs"
import { adresses } from "./config.mjs"
import { enregistrer } from "./couts.mjs"
import { demanderCorrections } from "./livraison.mjs"
import { inventaireEnTexte, inventorier, preparerReprise } from "./reprise.mjs"
import { lirePersona, obtenirPersona, personaEnTexte } from "./personas.mjs"

// personaId : un persona validé (facultatif) ; origine : un dépôt repris (reprise.mjs).
export async function nouveauProjet(ctx, { prompt, demandeur = "?", canal = null, fil = null, avant = null, personaId = null, origine = null }) {
  const id = Number(ctx.db.prepare("INSERT INTO projets (prompt, demandeur, canal, fil, persona_id, origine) VALUES (?, ?, ?, ?, ?, ?)").run(prompt, demandeur, canal, fil, personaId, origine ? JSON.stringify(origine) : null).lastInsertRowid)
  noter(ctx.db, { projet: id, type: "demande", message: `${prompt}\n(par ${demandeur})` })
  avant?.(id)
  lancerAnalyse(ctx, id).catch((e) => console.error(e))
  return id
}

// Reprendre un dépôt existant : vérifié (visible, mode copie ou direct, persona validé), puis
// le même chemin qu'une demande, avec l'inventaire avant le plan.
export async function reprendreDepot(ctx, { adresse, personaId = null, mode = "auto", consigne = "", demandeur = "?", canal = null, fil = null }) {
  const r = await preparerReprise(ctx, { adresse, personaId, mode, consigne })
  if (!r.ok) return r
  const id = await nouveauProjet(ctx, { prompt: r.prompt, demandeur, canal, fil, personaId: r.persona?.id ?? null, origine: r.origine })
  return { ok: true, id, origine: r.origine, message: `Reprise de ${r.origine.depot} lancée (mode ${r.origine.mode === "direct" ? "direct : branche et pull request dans le dépôt d'origine" : "copie dans un dépôt de l'usine"}).` }
}

// L'analyse tourne en tâche de fond ; le résultat arrive par le notificateur.
export async function lancerAnalyse(ctx, projetId, options = {}) {
  const { db } = ctx
  maj(db, "projets", projetId, { statut: "analyse" })
  let projet = obtenir(db, "projets", projetId)
  const persona = projet.persona_id ? lirePersona(obtenirPersona(db, projet.persona_id)) : null
  try {
    // Un dépôt repris : d'abord l'inventaire (une fois ; « relancer » refait seulement le plan).
    if (projet.origine && !projet.inventaire) {
      const origine = JSON.parse(projet.origine)
      await ctx.notifier.etape(projet, `:mag: L'usine fait l'inventaire de ${origine.depot} : sa pile, ses commandes, ce qui marche, et sa mise au contrat d'hébergement. Puis l'analyste fera le plan.`)
      await inventorier(ctx, projetId)
      projet = obtenir(db, "projets", projetId)
    }
    await ctx.notifier.etape(projet, ":brain: L'analyste étudie la demande et prépare le plan de fabrication…")
    const mesurer = (usages, duree_s) => enregistrer(db, { projet: projetId, role: "analyste", moteur: "claude-code", usages, duree_s })
    const inventaire = projet.inventaire ? JSON.parse(projet.inventaire) : null
    const { plan, tokens } = await analyser(ctx.config, projet, { ...options, mesurer, ctx, persona: persona ? personaEnTexte(persona) : null, inventaire: inventaire ? inventaireEnTexte(inventaire) : null, pile: inventaire?.pile })
    // Un dépôt repris garde sa pile ; le persona est rappelé dans le plan (docs/PLAN.md).
    if (inventaire) {
      delete plan.brique
      plan.pile = inventaire.pile
    }
    if (persona) plan.persona = persona.nom
    noter(db, { projet: projetId, type: "analyse", message: `Plan reçu (${tokens} jetons) : ${plan.lots?.length ?? 0} lot(s), ${plan.questions?.length ?? 0} question(s)` })
    if (plan.questions?.length && !plan.lots?.length) {
      maj(db, "projets", projetId, { statut: "questions", plan: JSON.stringify(plan) })
      return ctx.notifier.questions(obtenir(db, "projets", projetId), plan.questions)
    }
    // Un slug déjà pris par un autre projet reçoit un suffixe.
    // (Certains noms sont réservés aux adresses de l'usine elle-même.)
    const pris = ["mails", "usine-tableau", "console", "connexion", "apercu"].includes(plan.slug) || db.prepare("SELECT 1 FROM projets WHERE slug = ? AND id != ?").get(plan.slug, projetId)
    if (pris) plan.slug = `${plan.slug.slice(0, 17)}-${projetId}`
    maj(db, "projets", projetId, { statut: "plan_a_valider", plan: JSON.stringify(plan), nom: plan.nom, slug: plan.slug })
    return ctx.notifier.plan(obtenir(db, "projets", projetId), plan)
  } catch (error) {
    maj(db, "projets", projetId, { statut: "echec" })
    noter(db, { projet: projetId, type: "erreur", message: error.message })
    return ctx.notifier.etape(projet, `:x: L'analyse a échoué : ${error.message.slice(0, 800)}\nRelance avec \`/usine relancer ${projetId}\` ou le bouton « Relancer » de la console.`)
  }
}

export async function repondreQuestions(ctx, projetId, reponses, par) {
  const projet = obtenir(ctx.db, "projets", projetId)
  if (projet?.statut !== "questions") return { ok: false, message: "Ce projet n'attend pas de réponses." }
  const plan = lirePlan(projet)
  // Une réponse par question (fenêtre Slack), ou un seul texte libre (réponse dans le fil).
  const texte = Array.isArray(reponses)
    ? plan.questions.map((q, i) => `${q}\n→ ${reponses[i] ?? ""}`).join("\n")
    : `${plan.questions.map((q, i) => `${i + 1}. ${q}`).join("\n")}\n→ ${reponses}`
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
  db.prepare("INSERT INTO decisions (projet_id, question, reponse, par) VALUES (?, ?, ?, ?)").run(projetId, "Plan de fabrication", "validé", par)
  noter(db, { projet: projetId, type: "validation", message: `Plan validé par ${par}` })
  lancerCreation(ctx, projetId, `:white_check_mark: Plan validé par ${par}. Création du dépôt et du socle…`)
  return { ok: true, message: "Plan validé." }
}

// La création du dépôt, du socle et des issues, en tâche de fond. Rejouable après un échec :
// le dépôt n'est créé que s'il manque, le socle est repoussé, une issue déjà ouverte ne l'est pas deux fois.
function lancerCreation(ctx, projetId, annonce) {
  const { db } = ctx
  maj(db, "projets", projetId, { statut: "creation" })
  const projet = obtenir(db, "projets", projetId)
  ;(async () => {
    await ctx.notifier.etape(projet, annonce)
    try {
      await creerProduit(ctx, projetId)
      const p = obtenir(db, "projets", projetId)
      const n = taches(db, projetId).length
      const ou = !p.origine
        ? `Dépôt <https://github.com/${p.depot}|${p.depot}> créé`
        : JSON.parse(p.origine).mode === "direct"
          ? `Branche \`${p.branche}\` créée dans <https://github.com/${p.depot}|${p.depot}> (la branche d'origine n'est pas touchée)`
          : `Dépôt repris copié dans <https://github.com/${p.depot}|${p.depot}>`
      await ctx.notifier.etape(p, `:building_construction: ${ou}, socle vérifié, ${n} issues ouvertes. La fabrication commence ; je ne reviens vers toi que si une décision est nécessaire, puis à la livraison.\nAperçus : ${adresses(ctx.config, p.slug).apercu}`)
    } catch (error) {
      maj(db, "projets", projetId, { statut: "echec" })
      noter(db, { projet: projetId, type: "erreur", message: error.message })
      await ctx.notifier.etape(projet, `:x: La création du produit a échoué : ${error.message.slice(0, 800)}\nRelance avec \`/usine relancer ${projetId}\` ou le bouton « Relancer » de la console : le plan validé est gardé.`)
    }
  })().catch((e) => console.error(e))
}

// Relancer un projet là où il a échoué : la création si son plan était validé (le plan est
// gardé tel quel), sinon l'analyse. Un projet en fabrication ne se relance pas : ses tâches
// bloquées se débloquent par leur décision (A · Réessayer).
export function relancerProjet(ctx, projetId, par = "?") {
  const { db } = ctx
  const projet = obtenir(db, "projets", projetId)
  if (!projet) return { ok: false, message: `Pas de projet ${projetId}.` }
  const planValide = db.prepare("SELECT 1 FROM decisions WHERE projet_id = ? AND question = 'Plan de fabrication' AND reponse = 'validé'").get(projetId)
  if (projet.statut === "echec" && planValide && !projet.debut_fabrication) {
    noter(db, { projet: projetId, type: "relance", message: `Création relancée par ${par}, avec le plan validé` })
    lancerCreation(ctx, projetId, `:repeat: Création relancée par ${par}, avec le plan validé. Dépôt et socle…`)
    return { ok: true, message: "Création relancée, avec le plan validé." }
  }
  if (!["echec", "questions", "plan_a_valider"].includes(projet.statut)) {
    return { ok: false, message: `Le projet ${projetId} est « ${projet.statut} » : il n'y a rien à relancer. Une tâche bloquée se débloque par sa décision (A · Réessayer).` }
  }
  noter(db, { projet: projetId, type: "relance", message: `Analyse relancée par ${par}` })
  lancerAnalyse(ctx, projetId).catch((e) => console.error(e))
  return { ok: true, message: "Analyse relancée." }
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
  // Une demande de correction ou une mise en production interrompue : le produit
  // reprend son état d'avant, et la dernière demande de correction est relancée.
  for (const p of db.prepare("SELECT id FROM projets WHERE statut IN ('corrections', 'mise_en_production')").all()) {
    const enProd = db.prepare("SELECT 1 FROM journal WHERE projet_id = ? AND type = 'production' AND message LIKE 'En production%'").get(p.id)
    const avant = obtenir(db, "projets", p.id).statut
    maj(db, "projets", p.id, { statut: enProd ? "en_production" : "livre" })
    if (avant !== "corrections") continue
    const derniere = db.prepare("SELECT reponse, par FROM decisions WHERE projet_id = ? AND question = 'Corrections après livraison' ORDER BY id DESC LIMIT 1").get(p.id)
    if (!derniere) continue
    console.log(`Reprise : demande de correction relancée sur le projet ${p.id}.`)
    db.prepare("DELETE FROM decisions WHERE projet_id = ? AND question = 'Corrections après livraison' AND id = (SELECT MAX(id) FROM decisions WHERE projet_id = ? AND question = 'Corrections après livraison')").run(p.id, p.id)
    demanderCorrections(ctx, p.id, derniere.reponse, derniere.par ?? "?").catch((e) => console.error(e))
  }
}
