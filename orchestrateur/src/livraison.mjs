// Étage 3 : livrer. L'orchestrateur ne déploie rien lui-même : il écrit l'état
// souhaité dans le dépôt d'état, et le déployeur (seul à toucher Docker) le tire.
//
//   un lot fini      -> apercus/<slug>.json      (direct sur main)  -> aperçu public
//   tous les lots    -> rapport final, boutons Valider / Corriger
//   Valider          -> production/<slug>.json   (par pull request) -> blue/green
//   Corriger         -> l'analyste ajoute un lot « Corrections », retour à l'étage 2
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { adresses } from "./config.mjs"
import { maj, noter, obtenir, plan as lirePlan, taches } from "./db.mjs"
import { ecrireEtat, ecrireFichierDepot, ouvrirPR, shaPrincipal } from "./github.mjs"
import { analyserBrief, analyserCorrections, analyserSens } from "./analyste.mjs"
import { designEnMarkdown } from "./design.mjs"
import { capturesDuLot } from "./suivi.mjs"
import { ajouterLot } from "./creation.mjs"
import { escalader } from "./escalade.mjs"
import { ecrireReglage, enregistrer, lireReglage } from "./couts.mjs"
import { brancheDeBase } from "./profil.mjs"
import { jouerRecette, lireRecette } from "./recette.mjs"
import { pyramideEnCorrections, pyramideEnLignes, verdictPyramide } from "./pyramide.mjs"
import { lirePersona, obtenirPersona, personaEnTexte } from "./personas.mjs"

const pause = (ms) => new Promise((r) => setTimeout(r, ms))
const fini = (t) => ["fusionnee", "abandonnee"].includes(t.statut)

function lireStatut(config) {
  try {
    return JSON.parse(readFileSync(join(config.etatDir, "statut.json"), "utf8"))
  } catch {
    return {}
  }
}

// Attend que le déployeur ait appliqué ce sha (il écrit statut.json sur le volume partagé).
async function attendreDeploiement(config, cle, sha, minutes = 20) {
  const limite = Date.now() + minutes * 60_000
  while (Date.now() < limite) {
    const s = lireStatut(config)[cle]
    if (s?.sha === sha && ["ok", "echec"].includes(s.etat)) return s
    await pause(10_000)
  }
  return { etat: "echec", message: `le déployeur n'a pas appliqué ${sha.slice(0, 7)} en ${minutes} min` }
}

async function santePublique(url) {
  for (let i = 0; i < 12; i++) {
    try {
      const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(10_000) })
      if (res.ok) return true
    } catch {}
    await pause(5_000)
  }
  return false
}

// Les choix de production : le contrat donne les défauts, la personne qui valide
// peut les changer, et ils restent ceux du produit jusqu'au prochain changement.
export function choixProduction(config, ...sources) {
  const c = Object.assign({ donnees: "demo", emails: "captures", horloge: "acceleree", acces: "protege", destinataires_autorises: [] }, config.production ?? {}, ...sources.filter(Boolean))
  const liste = Array.isArray(c.destinataires_autorises) ? c.destinataires_autorises : String(c.destinataires_autorises ?? "").split(/[,;\s]+/)
  return {
    donnees: c.donnees === "vide" ? "vide" : "demo",
    emails: c.emails === "reels" ? "reels" : "captures",
    horloge: c.horloge === "reelle" ? "reelle" : "acceleree",
    // Protégé sauf choix explicite : « toujours protéger les applications ».
    acces: c.acces === "public" ? "public" : "protege",
    destinataires_autorises: liste.map((x) => String(x).trim()).filter((x) => /^[^\s@]*@[^\s@]+$/.test(x)),
  }
}

export const decrireChoix = (c) =>
  `accès ${c.acces === "public" ? "PUBLIC" : "protégé"} · données ${c.donnees === "demo" ? "de démo" : "vides (vraie utilisation)"} · emails ${c.emails === "reels" ? `réels${c.destinataires_autorises.length ? ` vers ${c.destinataires_autorises.join(", ")} seulement` : " vers TOUS les destinataires"}` : "capturés par Mailpit"} · horloge ${c.horloge === "reelle" ? "réelle" : "accélérée"}`

function etatSouhaite(config, projet, environnement, sha, lot, choix = null) {
  const a = adresses(config, projet.slug)
  const hote = (url) => new URL(url).host
  // Un aperçu est toujours une vitrine de démo ; la production suit les choix.
  const c = environnement === "production" ? choix : { donnees: config.demo?.actif ? "demo" : "vide", emails: "captures", horloge: "acceleree", acces: "protege", destinataires_autorises: [] }
  const mailpit = c.emails === "captures" && (config.demo?.services ?? []).includes("mailpit")
  return {
    produit: projet.slug,
    nom: projet.nom,
    depot: projet.depot,
    sha,
    environnement,
    hote: hote(environnement === "production" ? a.production : a.apercu),
    hote_mails: mailpit ? hote(a.mails) : null,
    lot,
    donnees: c.donnees,
    emails: c.emails,
    acces: c.acces ?? "protege",
    env: {
      DEMO: c.donnees === "demo" ? "1" : "0",
      DEMO_VITESSE_HORLOGE: c.horloge === "reelle" ? "1" : String(config.demo?.vitesse_horloge ?? 1),
      PUBLIC_URL: environnement === "production" ? a.production : a.apercu,
      LLM_MODELE: config.modeles?.produit?.modele ?? "",
      EMAIL_DESTINATAIRES_AUTORISES: c.emails === "reels" ? c.destinataires_autorises.join(",") : "",
    },
    services: mailpit ? ["mailpit"] : [],
    demande_le: new Date().toISOString(),
  }
}

// Appelée après chaque fusion (et après une tâche acceptée ou abandonnée).
export async function apresFusion(ctx, projetId, lot) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  const toutes = taches(db, projetId)
  const duLot = toutes.filter((t) => t.lot === lot)
  if (!duLot.every(fini) || lot <= projet.lot_livre) return
  // Les lots se livrent dans l'ordre : un lot fini avant le précédent attend.
  for (let n = projet.lot_livre + 1; n <= Math.max(...toutes.map((t) => t.lot)); n++) {
    if (!toutes.filter((t) => t.lot === n).every(fini)) break
    await livrerApercu(ctx, projetId, n)
  }
}

async function livrerApercu(ctx, projetId, lot) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  const plan = lirePlan(projet)
  const sha = await shaPrincipal(config, projet.depot, brancheDeBase(projet))
  const a = adresses(config, projet.slug)
  maj(db, "projets", projetId, { lot_livre: lot })
  await ctx.notifier.progres(projet, `📦 Lot ${lot} terminé (${plan.lots[lot - 1]?.nom ?? ""}) : déploiement de l'aperçu`)
  await ecrireEtat(config, `apercus/${projet.slug}.json`, etatSouhaite(config, projet, "apercu", sha, lot), { message: `Aperçu ${projet.slug} : lot ${lot} (${sha.slice(0, 7)})` })
  const s = await attendreDeploiement(config, `apercu/${projet.slug}`, sha)
  const enLigne = s.etat === "ok" && (await santePublique(a.apercu))
  if (!enLigne) {
    noter(db, { projet: projetId, type: "livraison", message: `Aperçu du lot ${lot} en échec : ${s.message ?? "santé publique KO"}` })
    await escalader(ctx, { projetId, raison: "livraison", details: `Lot ${lot}, sha ${sha.slice(0, 7)} : ${s.message ?? `${a.apercu}/api/health ne répond pas`}` })
    return
  }
  noter(db, { projet: projetId, type: "livraison", message: `Aperçu du lot ${lot} en ligne (${sha.slice(0, 7)})` })
  // La durée de vie de l'aperçu repart (cycle.mjs la surveille).
  maj(db, "projets", projetId, { apercu_expire_le: new Date(Date.now() + Number(config.apercus?.duree_vie_jours ?? 7) * 86_400_000).toISOString(), apercu_rappel: 0, apercu_retire: 0 })
  const dernier = lot >= Math.max(...taches(db, projetId).map((t) => t.lot))
  await ctx.notifier.lotLivre(projet, {
    texte: `:eyes: *Lot ${lot} livré : ${plan.lots[lot - 1]?.nom ?? ""}*\n${plan.lots[lot - 1]?.objectif ?? ""}\nAperçu : ${a.apercu}${(config.demo?.services ?? []).includes("mailpit") ? ` · emails capturés : ${a.mails}` : ""}${dernier ? "" : `\nLa fabrication continue avec le lot ${lot + 1}.`}`,
    captures: capturesDuLot(ctx, projetId, lot),
  }).catch((e) => console.error("Lot livré :", e.message))
  await finaliserSiFini(ctx, projetId)
}

// Tout est livré : le rapport final, et la seconde validation humaine.
export async function finaliserSiFini(ctx, projetId) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  const tout = taches(db, projetId)
  if (!tout.every(fini) || projet.lot_livre < Math.max(...tout.map((t) => t.lot))) return false
  maj(db, "projets", projetId, { statut: "livre" })
  // Des demandes reçues pendant la fabrication : elles partent maintenant, sans attendre
  // l'humain ; le rapport final viendra quand elles seront livrées à leur tour.
  const enFile = retirerFile(db, projetId)
  if (enFile.length) {
    await ctx.notifier.etape(obtenir(db, "projets", projetId), `:inbox_tray: Lot terminé. ${enFile.length > 1 ? `${enFile.length} demandes reçues` : "Une demande reçue"} pendant la fabrication ${enFile.length > 1 ? "partent" : "part"} maintenant chez l'analyste.`)
    await demanderCorrections(ctx, projetId, enFile.map((d) => d.texte).join("\n\n"), [...new Set(enFile.map((d) => d.par))].join(", "))
    return true
  }
  // Le lot de finition (une fois par projet) : les remarques du relecteur design deviennent
  // un dernier lot de polissage, avant que l'humain ne voie le produit.
  if (config.finition !== false && !projet.finition_faite) {
    const remarques = db.prepare("SELECT cle, titre, design FROM taches WHERE projet_id = ? AND statut = 'fusionnee' AND design IS NOT NULL").all(projetId).flatMap((t) => {
      try {
        return (JSON.parse(t.design).mineurs ?? []).map((d) => `- ${t.cle} · ${d.ecran ?? ""} : ${d.defaut}${d.correction ? ` → ${d.correction}` : ""}`)
      } catch {
        return []
      }
    })
    maj(db, "projets", projetId, { finition_faite: 1 })
    const texte = [
      "Lot de FINITION, demandé par l'usine avant de présenter le produit : rends-le irréprochable, sans ajouter de fonctionnalité.",
      "Objectifs : cohérence avec docs/DESIGN.md et sa grille sur tous les écrans, états vides, de chargement et d'erreur partout, textes précis et homogènes, responsive à 390 px, parcours clé fluides.",
      remarques.length ? `Remarques du relecteur design pendant la fabrication (à traiter en priorité) :\n${remarques.slice(0, 40).join("\n")}` : "Le relecteur design n'a pas laissé de remarque : passe en revue chaque écran avec la grille.",
      "Au plus 3 tâches. Chaque critère s'observe sur l'application en marche (capture ou navigateur).",
    ].join("\n\n")
    await ctx.notifier.etape(obtenir(db, "projets", projetId), `:sparkles: Tous les lots sont faits. Avant de te présenter le produit, l'usine fait un lot de *finition* (design, textes, états vides, mobile)${remarques.length ? ` à partir de ${remarques.length} remarque(s) du relecteur design` : ""}.`)
    await demanderCorrections(ctx, projetId, texte, "l'usine (finition)")
    return true
  }
  const sha = await shaPrincipal(config, projet.depot, brancheDeBase(projet))
  // La recette : les scénarios cachés du persona et la pyramide de l'expérience, sur ce qui va être livré (une fois par version).
  if (lireRecette(projet)?.sha !== sha) await jouerRecette(ctx, projetId, sha).catch((e) => console.error("Recette :", e.message))
  // Un dépôt repris en mode direct : l'usine rend son travail par UNE pull request vers la branche
  // d'origine. Elle ne la fusionne jamais : c'est la personne qui décide.
  if (projet.origine) await ouvrirPRLivraison(ctx, projetId).catch((e) => noter(db, { projet: projetId, type: "erreur", message: `Pull request de livraison impossible : ${e.message}` }))
  await ctx.notifier.rapportFinal(obtenir(db, "projets", projetId), rapport(ctx, projetId, sha))
  return true
}

async function ouvrirPRLivraison(ctx, projetId) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  const origine = JSON.parse(projet.origine)
  if (origine.mode !== "direct") return null
  const plan = lirePlan(projet)
  const recette = lireRecette(projet)
  const tout = taches(db, projetId)
  const corps = [
    `L'usine logicielle a terminé **${plan.nom}** à partir de ce dépôt${plan.persona ? `, pour le persona « ${plan.persona} »` : ""}.`,
    "",
    plan.resume,
    "",
    "### Ce qui a été fait",
    ...plan.lots.map((l, i) => `- **Lot ${i + 1} : ${l.nom}** (${tout.filter((t) => t.lot === i + 1 && t.statut === "fusionnee").length}/${tout.filter((t) => t.lot === i + 1).length} tâches) : ${l.objectif}`),
    "",
    `Chaque tâche a été codée par un agent, testée par un vérificateur indépendant et fusionnée sur \`${projet.branche}\` par le code de l'usine. ${projet.plancher_tests} test(s) passent.`,
    ...(recette && !recette.erreur && recette.total ? ["", `### Recette du persona : ${recette.tenus}/${recette.total} scénario(s) tenu(s)`, ...recette.scenarios.map((s) => `- ${s.tenu ? "✅" : "❌"} ${s.titre}${s.tenu ? "" : ` : ${s.ecart || s.observe}`}`)] : []),
    ...(recette?.pyramide ? ["", "### Pyramide de l'expérience", "", verdictPyramide(recette.pyramide), "", "```", ...pyramideEnLignes(recette.pyramide, { gras: (t) => t }), "```"] : []),
    "",
    "Voir aussi : `MISSION.md`, `ICP.md`, `docs/PLAN.md`, `docs/INVENTAIRE.md`.",
    "",
    "_Cette pull request n'est jamais fusionnée par l'usine : relis-la, puis fusionne-la toi-même._",
  ].join("\n")
  const pr = await ouvrirPR(config, projet.depot, { titre: `Usine logicielle : ${plan.nom}`, corps, branche: projet.branche, base: origine.branche_source })
  if (pr?.number && pr.number !== projet.pr_livraison) {
    maj(db, "projets", projetId, { pr_livraison: pr.number })
    noter(db, { projet: projetId, type: "livraison", message: `Pull request de livraison : https://github.com/${projet.depot}/pull/${pr.number} (${projet.branche} → ${origine.branche_source}), à fusionner par la personne` })
  }
  return pr
}

export function rapport(ctx, projetId, sha) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  const plan = lirePlan(projet)
  const tout = taches(db, projetId)
  const a = adresses(config, projet.slug)
  const journal = db.prepare("SELECT type, COUNT(*) AS n FROM journal WHERE projet_id = ? GROUP BY type").all(projetId)
  const compte = (type) => journal.find((j) => j.type === type)?.n ?? 0
  const debut = db.prepare("SELECT MIN(le) AS d FROM journal WHERE projet_id = ? AND type = 'fabrication'").get(projetId)?.d
  const duree = debut ? Math.round((Date.now() - new Date(`${debut}Z`).getTime()) / 60_000) : null
  return {
    nom: projet.nom,
    resume: plan.resume,
    apercu: a.apercu,
    mails: (config.demo?.services ?? []).includes("mailpit") ? a.mails : null,
    depot: `https://github.com/${projet.depot}`,
    sha,
    lots: plan.lots.map((l, i) => ({
      nom: l.nom,
      taches: tout.filter((t) => t.lot === i + 1).map((t) => ({ cle: t.cle, titre: t.titre, statut: t.statut, pr: t.pr })),
    })),
    tests: projet.plancher_tests,
    recette: lireRecette(projet),
    origine: projet.origine ? JSON.parse(projet.origine) : null,
    pr_livraison: projet.pr_livraison ? `https://github.com/${projet.depot}/pull/${projet.pr_livraison}` : null,
    refus: compte("refus"),
    escalades: compte("escalade"),
    decisions: compte("decision"),
    duree_min: duree,
  }
}

// Seconde porte humaine : Valider. La production passe par une PR du dépôt d'état.
export async function mettreEnProduction(ctx, projetId, par, demande = null) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  if (!["livre", "en_production"].includes(projet.statut)) return { ok: false, message: `Le projet est « ${projet.statut} », pas encore livré.` }
  if (demande?.emails === "reels" && !process.env.SMTP_HOST) return { ok: false, message: "Emails réels demandés, mais aucun service d'envoi n'est configuré (SMTP_HOST dans .env)." }
  const choix = choixProduction(config, projet.production ? JSON.parse(projet.production) : null, demande)
  const sha = await shaPrincipal(config, projet.depot, brancheDeBase(projet))
  const a = adresses(config, projet.slug)
  maj(db, "projets", projetId, { statut: "mise_en_production", production: JSON.stringify(choix) })
  await ctx.notifier.etape(projet, `:rocket: Validé par ${par}. Mise en production de ${sha.slice(0, 7)} (bascule blue/green, sauvegarde des données avant).\nRéglages : ${decrireChoix(choix)}.`)
  const pr = await ecrireEtat(config, `production/${projet.slug}.json`, { ...etatSouhaite(config, projet, "production", sha, projet.lot_livre, choix), valide_par: par }, { message: `Production ${projet.slug} : ${sha.slice(0, 7)}`, viaPR: true })
  const s = await attendreDeploiement(config, `production/${projet.slug}`, sha, 25)
  const enLigne = s.etat === "ok" && (await santePublique(a.production))
  noter(db, { projet: projetId, type: "production", message: enLigne ? `En production (${sha.slice(0, 7)}, ${s.couleur ?? ""}) validé par ${par}` : `Mise en production en échec : ${s.message ?? "santé KO"}` })
  if (!enLigne) {
    maj(db, "projets", projetId, { statut: "livre" })
    await ctx.notifier.etape(projet, `:x: La mise en production a échoué : ${s.message ?? `${a.production}/api/health ne répond pas`}. L'ancienne version (s'il y en a une) continue de tourner.`)
    return { ok: false, message: s.message ?? "santé KO" }
  }
  maj(db, "projets", projetId, { statut: "en_production" })
  await ctx.notifier.etape(projet, `:tada: *${projet.nom}* est en production : ${a.production}\nRéglages : ${decrireChoix(choix)}.\nTrace : https://github.com/${config.github.proprietaire}/${config.github.depot_etat}/pull/${pr}`, [{ texte: "Changer les réglages de production", action: "production_reglages", valeur: projet.id }, { texte: "Demander des corrections", action: "livraison_corriger", valeur: projet.id }])
  return { ok: true, message: a.production }
}

// Seconde porte humaine : Corriger. Les retours deviennent un lot de plus.
export async function demanderCorrections(ctx, projetId, retours, par) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  if (!["livre", "en_production"].includes(projet.statut)) return { ok: false, message: `Le projet est « ${projet.statut} ».` }
  const avant = projet.statut
  maj(db, "projets", projetId, { statut: "corrections" })
  await ctx.notifier.etape(projet, `:mag: Demande de ${par} :\n>${retours.replace(/\n/g, "\n>")}\nL'analyste enquête (journaux et réglages du produit en ligne)…`)
  try {
    const contexte = {
      reglages: projet.production ? JSON.parse(projet.production) : null,
      journaux: { production: lireJournal(config, `production-${projet.slug}`), apercu: lireJournal(config, `apercu-${projet.slug}`) },
      mesurer: (usages, duree_s) => enregistrer(db, { projet: projetId, role: "analyste", moteur: "claude-code", usages, duree_s }),
      echanges: echangesRecents(db, projetId),
      persona: projet.persona_id ? personaEnTexte(lirePersona(obtenirPersona(db, projet.persona_id)) ?? { nom: "?", fiche: {} }) : null,
      // Où en est le produit dans la pyramide : chaque correction en profite pour le faire monter d'un étage.
      pyramide: lireRecette(projet)?.pyramide ? `${verdictPyramide(lireRecette(projet).pyramide)}\n${pyramideEnCorrections(lireRecette(projet).pyramide)}`.trim() : null,
    }
    // Un produit fabriqué avant les briefs de design en reçoit un, d'abord (docs/DESIGN.md).
    let plan = lirePlan(projet)
    if (!plan.design) {
      try {
        plan.design = await analyserBrief(config, projet, plan, contexte.mesurer)
        await ecrireFichierDepot(config, projet.depot, "docs/DESIGN.md", designEnMarkdown(plan), "Brief de design (docs/DESIGN.md)", brancheDeBase(projet))
        maj(db, "projets", projetId, { plan: JSON.stringify(plan) })
        noter(db, { projet: projetId, type: "design", message: `Brief de design rédigé : ${plan.design.intention}` })
        await ctx.notifier.etape(projet, `:art: *${plan.nom}* n'avait pas de brief de design : l'analyste en a rédigé un (docs/DESIGN.md). ${plan.design.intention}`)
      } catch (error) {
        console.error("Brief de design :", error.message) // sans brief, la grille seule s'applique
      }
    }
    // Un produit fabriqué avant la question du sens : l'analyste se la pose d'abord, d'après le persona.
    if (!plan.sens) {
      try {
        plan.sens = await analyserSens(config, projet, plan, contexte.persona, contexte.mesurer)
        maj(db, "projets", projetId, { plan: JSON.stringify(plan) })
        noter(db, { projet: projetId, type: "sens", message: `Le sens du produit : ${plan.sens.promesse}` })
        await ctx.notifier.etape(projet, `:compass: *Ce qui donnerait du sens à ${plan.nom}* (d'après le persona) : ${plan.sens.promesse}
Le moment où on le ressent : ${plan.sens.moment}. Les prochaines évolutions s'en serviront.`)
      } catch (error) {
        console.error("Sens :", error.message) // sans sens, la pyramide seule s'applique
      }
    }
    // La demande est gardée même si l'analyse échoue : une reformulation la retrouvera.
    db.prepare("INSERT INTO decisions (projet_id, question, reponse, par) VALUES (?, ?, ?, ?)").run(projetId, "Corrections après livraison", retours, par)
    const r = await analyserCorrections(config, projet, plan, retours, contexte)
    noter(db, { projet: projetId, type: "diagnostic", message: `${r.diagnostic}${r.reglage ? `\nRéglage : ${r.reglage}` : ""}` })
    const boutonReglages = [{ texte: "Changer les réglages de production", action: "production_reglages", valeur: projetId }]
    const boutonRepondre = { texte: "Répondre à l'analyste", action: "livraison_corriger", valeur: projetId }
    const diag = `:stethoscope: *Diagnostic* : ${r.diagnostic}${r.reglage ? `\n:gear: *Réglage à changer* : ${r.reglage}` : ""}`
    if (!r.lot) {
      maj(db, "projets", projetId, { statut: avant })
      await ctx.notifier.etape(projet, `${diag}\nAucun code à modifier. _Tu peux répondre directement dans ce fil._`, [...(projet.production ? boutonReglages : []), boutonRepondre])
      return { ok: true, message: r.diagnostic }
    }
    const numero = await ajouterLot(ctx, projetId, r.lot)
    await ctx.notifier.etape(obtenir(db, "projets", projetId), `${diag}\n:hammer_and_wrench: Lot ${numero} « ${r.lot.nom} » : ${r.lot.taches.map((t) => `${t.cle} ${t.titre}`).join(" · ")}. La fabrication reprend ; un nouveau rapport suivra.`, r.reglage && projet.production ? boutonReglages : undefined)
    return { ok: true, message: r.lot.nom }
  } catch (error) {
    maj(db, "projets", projetId, { statut: avant })
    await ctx.notifier.etape(projet, `:x: L'analyste n'a pas pu traiter la demande : ${error.message.slice(0, 500)}\n_Tu peux reformuler en répondant dans ce fil._`, [{ texte: "Reformuler", action: "livraison_corriger", valeur: projetId }])
    return { ok: false, message: error.message }
  }
}

// La file des demandes de correction reçues pendant une fabrication.
const cleFile = (projetId) => `corrections_en_attente_${projetId}`
export function mettreEnFile(db, projetId, texte, par) {
  const file = JSON.parse(lireReglage(db, cleFile(projetId), "[]"))
  file.push({ texte, par, le: new Date().toISOString() })
  ecrireReglage(db, cleFile(projetId), JSON.stringify(file))
  return file.length
}
function retirerFile(db, projetId) {
  const file = JSON.parse(lireReglage(db, cleFile(projetId), "[]"))
  if (file.length) ecrireReglage(db, cleFile(projetId), "[]")
  return file
}

// Les derniers échanges avec l'analyste sur ce produit (demandes et diagnostics).
function echangesRecents(db, projetId, n = 6) {
  const lignes = db.prepare("SELECT le, type, message FROM journal WHERE projet_id = ? AND type IN ('diagnostic', 'corrections', 'remarque') UNION ALL SELECT le, 'demande', reponse FROM decisions WHERE projet_id = ? AND question IN ('Corrections après livraison', 'Remarque') ORDER BY le DESC LIMIT ?").all(projetId, projetId, n)
  return lignes.reverse().map((l) => `[${l.le}] ${l.type} : ${l.message.slice(0, 1500)}`).join("\n")
}

// Les dernières lignes du journal d'un produit, publiées par le déployeur.
function lireJournal(config, nom, lignes = 120) {
  try {
    return readFileSync(join(config.etatDir, "journaux", `${nom}.log`), "utf8").split("\n").slice(-lignes).join("\n").slice(-15_000)
  } catch {
    return ""
  }
}
