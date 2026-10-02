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
import { ecrireEtat, shaPrincipal } from "./github.mjs"
import { analyserCorrections } from "./analyste.mjs"
import { ajouterLot } from "./creation.mjs"
import { escalader } from "./escalade.mjs"

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

function etatSouhaite(config, projet, environnement, sha, lot) {
  const a = adresses(config, projet.slug)
  const hote = (url) => new URL(url).host
  return {
    produit: projet.slug,
    nom: projet.nom,
    depot: projet.depot,
    sha,
    environnement,
    hote: hote(environnement === "production" ? a.production : a.apercu),
    hote_mails: hote(a.mails),
    lot,
    env: {
      DEMO: config.demo?.actif ? "1" : "0",
      DEMO_VITESSE_HORLOGE: String(config.demo?.vitesse_horloge ?? 1),
      PUBLIC_URL: environnement === "production" ? a.production : a.apercu,
      LLM_MODELE: config.modeles?.produit?.modele ?? "",
    },
    services: config.demo?.services ?? [],
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
  const nomDepot = projet.depot.split("/")[1]
  const sha = await shaPrincipal(config, nomDepot)
  const a = adresses(config, projet.slug)
  maj(db, "projets", projetId, { lot_livre: lot })
  await ctx.notifier.etape(projet, `:package: Lot ${lot} terminé (${plan.lots[lot - 1]?.nom ?? ""}). Déploiement de l'aperçu…`)
  await ecrireEtat(config, `apercus/${projet.slug}.json`, etatSouhaite(config, projet, "apercu", sha, lot), { message: `Aperçu ${projet.slug} : lot ${lot} (${sha.slice(0, 7)})` })
  const s = await attendreDeploiement(config, `apercu/${projet.slug}`, sha)
  const enLigne = s.etat === "ok" && (await santePublique(a.apercu))
  if (!enLigne) {
    noter(db, { projet: projetId, type: "livraison", message: `Aperçu du lot ${lot} en échec : ${s.message ?? "santé publique KO"}` })
    await escalader(ctx, { projetId, raison: "livraison", details: `Lot ${lot}, sha ${sha.slice(0, 7)} : ${s.message ?? `${a.apercu}/api/health ne répond pas`}` })
    return
  }
  noter(db, { projet: projetId, type: "livraison", message: `Aperçu du lot ${lot} en ligne (${sha.slice(0, 7)})` })
  if (!(await finaliserSiFini(ctx, projetId))) {
    await ctx.notifier.etape(projet, `:eyes: *Aperçu du lot ${lot}* en ligne : ${a.apercu}${(config.demo?.services ?? []).includes("mailpit") ? ` · emails capturés : ${a.mails}` : ""}\nLa fabrication continue avec le lot ${lot + 1}.`)
  }
}

// Tout est livré : le rapport final, et la seconde validation humaine.
export async function finaliserSiFini(ctx, projetId) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  const tout = taches(db, projetId)
  if (!tout.every(fini) || projet.lot_livre < Math.max(...tout.map((t) => t.lot))) return false
  maj(db, "projets", projetId, { statut: "livre" })
  const sha = await shaPrincipal(config, projet.depot.split("/")[1])
  await ctx.notifier.rapportFinal(obtenir(db, "projets", projetId), rapport(ctx, projetId, sha))
  return true
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
    refus: compte("refus"),
    escalades: compte("escalade"),
    decisions: compte("decision"),
    duree_min: duree,
  }
}

// Seconde porte humaine : Valider. La production passe par une PR du dépôt d'état.
export async function mettreEnProduction(ctx, projetId, par) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  if (!["livre", "en_production"].includes(projet.statut)) return { ok: false, message: `Le projet est « ${projet.statut} », pas encore livré.` }
  const sha = await shaPrincipal(config, projet.depot.split("/")[1])
  const a = adresses(config, projet.slug)
  maj(db, "projets", projetId, { statut: "mise_en_production" })
  await ctx.notifier.etape(projet, `:rocket: Validé par ${par}. Mise en production de ${sha.slice(0, 7)} (bascule blue/green, sauvegarde des données avant)…`)
  const pr = await ecrireEtat(config, `production/${projet.slug}.json`, { ...etatSouhaite(config, projet, "production", sha, projet.lot_livre), valide_par: par }, { message: `Production ${projet.slug} : ${sha.slice(0, 7)}`, viaPR: true })
  const s = await attendreDeploiement(config, `production/${projet.slug}`, sha, 25)
  const enLigne = s.etat === "ok" && (await santePublique(a.production))
  noter(db, { projet: projetId, type: "production", message: enLigne ? `En production (${sha.slice(0, 7)}, ${s.couleur ?? ""}) validé par ${par}` : `Mise en production en échec : ${s.message ?? "santé KO"}` })
  if (!enLigne) {
    maj(db, "projets", projetId, { statut: "livre" })
    await ctx.notifier.etape(projet, `:x: La mise en production a échoué : ${s.message ?? `${a.production}/api/health ne répond pas`}. L'ancienne version (s'il y en a une) continue de tourner.`)
    return { ok: false, message: s.message ?? "santé KO" }
  }
  maj(db, "projets", projetId, { statut: "en_production" })
  await ctx.notifier.etape(projet, `:tada: *${projet.nom}* est en production : ${a.production}\nTrace : https://github.com/${config.github.proprietaire}/${config.github.depot_etat}/pull/${pr}`)
  return { ok: true, message: a.production }
}

// Seconde porte humaine : Corriger. Les retours deviennent un lot de plus.
export async function demanderCorrections(ctx, projetId, retours, par) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  if (!["livre", "en_production"].includes(projet.statut)) return { ok: false, message: `Le projet est « ${projet.statut} ».` }
  maj(db, "projets", projetId, { statut: "corrections" })
  await ctx.notifier.etape(projet, `:memo: Corrections demandées par ${par} :\n>${retours.replace(/\n/g, "\n>")}\nL'analyste prépare un lot de corrections…`)
  try {
    const lot = await analyserCorrections(config, projet, lirePlan(projet), retours)
    db.prepare("INSERT INTO decisions (projet_id, question, reponse, par) VALUES (?, ?, ?, ?)").run(projetId, "Corrections après livraison", retours, par)
    const numero = await ajouterLot(ctx, projetId, lot)
    await ctx.notifier.etape(obtenir(db, "projets", projetId), `:hammer_and_wrench: Lot ${numero} « ${lot.nom} » : ${lot.taches.map((t) => `${t.cle} ${t.titre}`).join(" · ")}. La fabrication reprend ; un nouveau rapport suivra.`)
    return { ok: true, message: lot.nom }
  } catch (error) {
    maj(db, "projets", projetId, { statut: "livre" })
    await ctx.notifier.etape(projet, `:x: L'analyste n'a pas pu préparer les corrections : ${error.message.slice(0, 500)}`)
    return { ok: false, message: error.message }
  }
}
