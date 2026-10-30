// L'escalade : quand le contrat est épuisé (tentatives, approches, durée) ou
// qu'une panne empêche de juger, l'usine s'arrête sur ce point et appelle
// l'humain. Une issue GitHub lui est assignée (label usine:bloquant), et un
// message Slack porte les mêmes options en boutons. Les deux débloquent :
// un clic, ou un commentaire « A », « B », « C » (ou une consigne libre) sur l'issue.
import { maj, noter, obtenir } from "./db.mjs"
import { lireReglage, reglagesCouts } from "./couts.mjs"
import { presenterDecision } from "./presentation.mjs"
import { MARQUE, ajouterEtiquettes, commenter, commentaires, creerIssue, fermerIssue, fusionnerPR, lireIssue, lirePR, retirerEtiquette } from "./github.mjs"

const RAISONS = {
  criteres: "les critères d'acceptation ne sont toujours pas tenus après toutes les tentatives prévues par le contrat",
  verificateur: "le vérificateur indépendant n'a pas pu juger (panne de Codex ou de son environnement)",
  infrastructure: "une erreur d'infrastructure a interrompu la fabrication",
  budget: "la durée maximale prévue par le contrat pour ce projet est atteinte",
  livraison: "le déploiement de l'aperçu a échoué",
  cout: "le budget du projet (en équivalent API) est atteint",
}

// Les options proposées selon la raison. A, B, C : toujours le même sens.
export function options(raison, aUnePR) {
  if (raison === "budget") return [
    { cle: "A", libelle: "Continuer", detail: "prolonger la durée du projet d'autant" },
    { cle: "C", libelle: "Arrêter", detail: "arrêter la fabrication ; ce qui est fusionné reste" },
  ]
  if (raison === "cout") return [
    { cle: "A", libelle: "Continuer", detail: "relever le budget du projet de 50 % et reprendre" },
    { cle: "C", libelle: "Arrêter", detail: "arrêter la fabrication ; ce qui est fusionné reste" },
  ]
  if (raison === "livraison") return [
    { cle: "A", libelle: "Redéployer", detail: "relancer le déploiement de l'aperçu" },
    { cle: "C", libelle: "Ignorer", detail: "continuer la fabrication sans cet aperçu" },
  ]
  return [
    { cle: "A", libelle: "Réessayer", detail: "relancer la tâche ; une consigne libre en commentaire sera transmise à l'agent" },
    ...(aUnePR && raison === "criteres" ? [{ cle: "B", libelle: "Accepter en l'état", detail: "fusionner la dernière pull request malgré le refus" }] : []),
    { cle: "C", libelle: "Abandonner", detail: "abandonner la tâche ; celles qui en dépendent continuent sans elle" },
  ]
}

export async function escalader(ctx, { projetId, tacheId = null, raison, details = "" }) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  const tache = tacheId ? obtenir(db, "taches", tacheId) : null
  const deja = db.prepare("SELECT id FROM escalades WHERE projet_id = ? AND tache_id IS ? AND raison = ? AND statut = 'ouverte'").get(projetId, tacheId, raison)
  if (deja) return deja.id
  const opts = options(raison, Boolean(tache?.pr))
  const nomDepot = projet.depot
  const sujet = tache ? `${tache.cle} · ${tache.titre}` : projet.nom
  const corps = [
    `@${config.github.proprietaire}, l'usine a besoin de ta décision : ${RAISONS[raison] ?? raison}.`,
    "",
    ...(tache ? [`Tâche : #${tache.issue}${tache.pr ? ` · dernière pull request : #${tache.pr}` : ""}`, ""] : []),
    "### Ce qui s'est passé",
    "",
    "```",
    String(details).slice(0, 6000),
    "```",
    "",
    "### Options",
    "",
    ...opts.map((o) => `- **${o.cle}** · ${o.libelle} : ${o.detail}`),
    "",
    "Réponds par un commentaire qui commence par la lettre choisie (par exemple « A » ou « A, utilise une table séparée pour les étapes »), ou utilise les boutons dans Slack.",
    config.autonomie?.arret === "projet" ? "\nEn attendant, **tout le projet est à l'arrêt**." : "\nEn attendant, les tâches qui dépendent de celle-ci sont à l'arrêt ; les autres continuent.",
  ].join("\n")
  let issue = null
  if (nomDepot) {
    issue = await creerIssue(config, nomDepot, { titre: `Décision requise : ${sujet}`, corps: `${corps}\n\n${MARQUE}`, etiquettes: ["usine:bloquant"], assigne: true }).catch((e) => {
      console.error("Issue d'escalade impossible :", e.message)
      return null
    })
  }
  const id = Number(db.prepare("INSERT INTO escalades (projet_id, tache_id, issue, raison, options) VALUES (?, ?, ?, ?, ?)").run(projetId, tacheId, issue?.number ?? null, raison, JSON.stringify(opts)).lastInsertRowid)
  if (tache) maj(db, "taches", tache.id, { statut: "bloquee" })
  if (tache?.issue && nomDepot) await ajouterEtiquettes(config, nomDepot, tache.issue, ["usine:bloquant"]).catch(() => {})
  // (Un projet en réorientation y reste : la tâche sera revue avec le nouveau plan.)
  if ((config.autonomie?.arret === "projet" || !tache) && obtenir(db, "projets", projetId).statut !== "reorientation") maj(db, "projets", projetId, { statut: "bloque" })
  noter(db, { projet: projetId, tache: tacheId, type: "escalade", message: `${sujet} : ${raison}` })
  const presentation = presenterDecision({ raison, raisonTexte: RAISONS[raison] ?? raison, options: opts, tache: tache ? obtenir(db, "taches", tache.id) : null })
  const ts = await ctx.notifier.escalade(projet, { id, sujet, raison: RAISONS[raison] ?? raison, details: String(details).slice(0, 1500), options: opts, presentation, issue: issue ? `https://github.com/${projet.depot}/issues/${issue.number}` : null }).catch((e) => console.error(e))
  if (ts) db.prepare("UPDATE escalades SET message_ts = ? WHERE id = ?").run(ts, id)
  return id
}

// Applique la décision humaine. choix : "A" | "B" | "C" ; texte : la consigne libre éventuelle.
export async function resoudre(ctx, escaladeId, { choix, texte = "", par = "?" }) {
  const { config, db } = ctx
  const esc = db.prepare("SELECT * FROM escalades WHERE id = ?").get(escaladeId)
  if (!esc || esc.statut !== "ouverte") return { ok: false, message: "Cette escalade est déjà résolue." }
  const opt = JSON.parse(esc.options).find((o) => o.cle === choix)
  if (!opt) return { ok: false, message: `Option ${choix} indisponible.` }
  const projet = obtenir(db, "projets", esc.projet_id)
  // Pendant une réorientation, les décisions attendent le nouveau plan (qui les règle, ou non).
  if (projet.statut === "reorientation" || lireReglage(db, `reorientation_${projet.id}`)) return { ok: false, message: "Ce projet est en réorientation : valide le nouveau plan (les tâches non faites seront abandonnées) ou garde l'ancien, puis décide." }
  db.prepare("UPDATE escalades SET statut = 'resolue' WHERE id = ?").run(escaladeId)
  const tache = esc.tache_id ? obtenir(db, "taches", esc.tache_id) : null
  const nomDepot = projet.depot
  const question = `${tache ? tache.cle : projet.nom} : ${esc.raison}`
  const reponse = `${choix} · ${opt.libelle}${texte ? ` — ${texte}` : ""}`
  db.prepare("INSERT INTO decisions (projet_id, tache_id, question, reponse, par) VALUES (?, ?, ?, ?, ?)").run(projet.id, esc.tache_id, question, reponse, par)
  noter(db, { projet: projet.id, tache: esc.tache_id, type: "decision", message: `${question} → ${reponse} (par ${par})` })

  if (esc.raison === "cout") {
    const base = Number(reglagesCouts(db, config).budget?.par_projet ?? 0)
    if (choix === "A") maj(db, "projets", projet.id, { statut: "fabrication", budget_supplement: Number(projet.budget_supplement ?? 0) + base * 0.5 })
    else maj(db, "projets", projet.id, { statut: "arrete" })
  } else if (esc.raison === "budget") {
    if (choix === "A") maj(db, "projets", projet.id, { statut: "fabrication", debut_fabrication: new Date().toISOString() })
    else maj(db, "projets", projet.id, { statut: "arrete" })
  } else if (esc.raison === "livraison") {
    maj(db, "projets", projet.id, { statut: "fabrication", ...(choix === "A" ? { lot_livre: Math.max(0, projet.lot_livre - 1) } : {}) })
  } else if (tache) {
    if (choix === "A") {
      const consigne = texte ? `\n\nConsigne de l'humain (prioritaire) : ${texte}` : ""
      maj(db, "taches", tache.id, { statut: "prete", tentative: 0, approche: 0, branche: null, retours: `${tache.retours ?? ""}${consigne}` })
    } else if (choix === "B") {
      const pr = await lirePR(config, nomDepot, tache.pr)
      if (pr.state === "open") await fusionnerPR(config, nomDepot, tache.pr, { titre: `${tache.cle} · ${tache.titre} (#${tache.pr}, accepté par ${par})`, sha: pr.head.sha })
      maj(db, "taches", tache.id, { statut: "fusionnee" })
      await ajouterEtiquettes(config, nomDepot, tache.issue, ["usine:fusionnee"]).catch(() => {})
    } else {
      maj(db, "taches", tache.id, { statut: "abandonnee" })
      await ajouterEtiquettes(config, nomDepot, tache.issue, ["usine:abandonnee"]).catch(() => {})
      await fermerIssue(config, nomDepot, tache.issue).catch(() => {})
    }
    if (tache.issue) await retirerEtiquette(config, nomDepot, tache.issue, "usine:bloquant").catch(() => {})
    if (projet.statut === "bloque") maj(db, "projets", projet.id, { statut: "fabrication" })
  }

  if (esc.issue && nomDepot) {
    await commenter(config, nomDepot, esc.issue, `Décision enregistrée par ${par} : **${reponse}**. L'usine reprend.`).catch(() => {})
    await fermerIssue(config, nomDepot, esc.issue).catch(() => {})
  }
  await ctx.notifier.escaladeResolue(projet, esc, `:unlock: Décision de ${par} : *${reponse}*. L'usine reprend.`).catch(() => {})
  // Une tâche acceptée ou abandonnée peut terminer un lot : la livraison vérifie.
  // (Appels via ctx : la livraison importe ce module, pas l'inverse.)
  const suite = async () => {
    if (tache && choix !== "A") await ctx.livraison.apresFusion(ctx, projet.id, tache.lot)
    if (esc.raison === "livraison" && choix === "A") await ctx.livraison.apresFusion(ctx, projet.id, projet.lot_livre)
    if (esc.raison === "livraison" && choix === "C") await ctx.livraison.finaliserSiFini(ctx, projet.id)
  }
  suite().catch((e) => console.error("Après la décision :", e))
  return { ok: true, message: reponse }
}

// Lit la réponse humaine dans un commentaire d'issue : « A », « b, … », ou du texte libre (= A + consigne).
export function lireReponse(texte, cles) {
  const t = String(texte).trim()
  const m = t.match(/^\**([A-Ca-c])\**(?:$|[\s.,:;)\-—–]+([\s\S]*))/)
  if (m && cles.includes(m[1].toUpperCase())) return { choix: m[1].toUpperCase(), texte: (m[2] ?? "").trim() }
  if (t && cles.includes("A")) return { choix: "A", texte: t }
  return null
}

// Toutes les minutes : les réponses sur GitHub, et les relances.
export function surveillerEscalades(ctx) {
  const tour = async () => {
    const { config, db } = ctx
    for (const esc of db.prepare("SELECT * FROM escalades WHERE statut = 'ouverte'").all()) {
      const projet = obtenir(db, "projets", esc.projet_id)
      const nomDepot = projet.depot
      if (!esc.issue || !nomDepot) continue
      try {
        const cles = JSON.parse(esc.options).map((o) => o.cle)
        const humains = (await commentaires(config, nomDepot, esc.issue)).filter((c) => !c.body.includes(MARQUE) && c.user?.type !== "Bot")
        const reponse = humains.map((c) => ({ c, r: lireReponse(c.body, cles) })).find((x) => x.r)
        if (reponse) {
          await resoudre(ctx, esc.id, { ...reponse.r, par: `${reponse.c.user.login} (GitHub)` })
          continue
        }
        const issue = await lireIssue(config, nomDepot, esc.issue)
        if (issue.state === "closed") {
          // Fermer l'issue sans commentaire vaut « débloquer » : on réessaie (ou on continue).
          await resoudre(ctx, esc.id, { choix: "A", par: `${issue.closed_by?.login ?? "?"} (issue fermée)` })
          continue
        }
        const heures = Number(config.autonomie?.relance_apres_heures ?? 24)
        const depuis = new Date(`${esc.relance_le ?? esc.cree_le}Z`).getTime()
        if (heures > 0 && Date.now() - depuis > heures * 3_600_000) {
          db.prepare("UPDATE escalades SET relance_le = datetime('now') WHERE id = ?").run(esc.id)
          await ctx.notifier.etape(projet, `:bell: Rappel : une décision est toujours attendue (<https://github.com/${projet.depot}/issues/${esc.issue}|issue #${esc.issue}>).`)
        }
      } catch (error) {
        console.error(`Escalade ${esc.id} :`, error.message)
      }
    }
  }
  setInterval(() => tour().catch((e) => console.error(e)), 60_000)
}
