// Étage 2 : fabriquer en autonomie. Toutes les 15 secondes, si l'atelier est
// libre, la prochaine tâche prête part en fabrication :
//
//   préparer (clone) -> l'agent code -> contrôle local (fichiers protégés,
//   build, tests) -> commit + push -> pull request -> vérificateur indépendant
//   -> porte codée -> fusion | correction | changement d'approche | escalade
//
// Le contrat (usine.config.yml) est appliqué ici, par le code : nombre de
// tentatives, changements d'approche, périmètre protégé, durée par agent.
import { existsSync } from "node:fs"
import { join } from "node:path"
import { decisions, maj, noter, obtenir, plan as lirePlan, taches } from "./db.mjs"
import { executer, ecrireFichier, lireFichier, q } from "./travaux.mjs"
import { ajouterEtiquettes, commentairePR, fusionnerPR, ouvrirPR, retirerEtiquette } from "./github.mjs"
import { COMPTER_TESTS } from "./creation.mjs"
import { pathspec, verifier } from "./verification.mjs"
import { escalader } from "./escalade.mjs"
import { apresFusion } from "./livraison.mjs"

const fini = (t) => ["fusionnee", "abandonnee"].includes(t.statut)

// Une tâche en attente devient prête quand toutes ses dépendances sont finies.
export function liberer(db, projetId) {
  const toutes = taches(db, projetId)
  const parCle = new Map(toutes.map((t) => [t.cle, t]))
  for (const t of toutes) {
    if (t.statut !== "attente") continue
    if (JSON.parse(t.depend_de).every((d) => !parCle.get(d) || fini(parCle.get(d)))) maj(db, "taches", t.id, { statut: "prete" })
  }
}

export const arretGeneral = (config) => existsSync(join(config.dataDir, "STOP"))

let occupe = false

export function demarrerFabrique(ctx) {
  const tick = async () => {
    if (occupe || arretGeneral(ctx.config)) return
    const projets = ctx.db.prepare("SELECT * FROM projets WHERE statut = 'fabrication' ORDER BY id").all()
    for (const projet of projets) {
      // Le budget de durée du contrat : au-delà, l'humain décide de continuer ou non.
      const heures = Number(ctx.config.autonomie?.budget_par_projet?.duree_max_heures ?? 0)
      if (heures > 0 && projet.debut_fabrication && Date.now() - new Date(projet.debut_fabrication).getTime() > heures * 3_600_000) {
        await escalader(ctx, { projetId: projet.id, raison: "budget", details: `Fabrication commencée le ${projet.debut_fabrication}, limite du contrat : ${heures} h.` })
        continue
      }
      liberer(ctx.db, projet.id)
      const t = ctx.db.prepare("SELECT * FROM taches WHERE projet_id = ? AND statut = 'prete' ORDER BY lot, id LIMIT 1").get(projet.id)
      if (!t) continue
      occupe = true
      try {
        await fabriquer(ctx, projet, t)
      } catch (error) {
        noter(ctx.db, { projet: projet.id, tache: t.id, type: "erreur", message: error.stack ?? error.message })
        await escalader(ctx, { projetId: projet.id, tacheId: t.id, raison: "infrastructure", details: error.message }).catch((e) => console.error(e))
      } finally {
        occupe = false
      }
      return
    }
  }
  setInterval(() => tick().catch((e) => console.error("Fabrique :", e)), 15_000)
}

function consigne(ctx, projet, tache) {
  const plan = lirePlan(projet)
  const lot = plan.lots[tache.lot - 1]
  const criteres = JSON.parse(tache.criteres)
  const decisionsPrises = decisions(ctx.db, projet.id)
  const parties = [
    `Tu es développeur senior dans une usine logicielle. Tu travailles dans ce dépôt : le produit « ${projet.nom} » (${plan.resume}).`,
    "Lis d'abord AGENTS.md (les conventions, à suivre strictement) puis docs/PLAN.md (le plan validé).",
    "",
    `Lot ${tache.lot} : ${lot?.nom ?? ""}. Objectif du lot : ${lot?.objectif ?? ""}`,
    `Ta tâche : ${tache.cle} · ${tache.titre}`,
    tache.description,
    "",
    "Critères d'acceptation. Un vérificateur indépendant les testera un par un sur l'application en marche, comme un visiteur :",
    ...criteres.map((c, i) => `${i + 1}. ${c}`),
    "",
    "Règles :",
    "- Écris d'abord les tests (node:test) des critères testables sans navigateur, puis le code.",
    "- Ne supprime ni n'affaiblis aucun test existant.",
    `- Ne modifie pas les fichiers protégés : ${(ctx.config.perimetre_protege ?? []).join(", ")}. L'usine les restaurerait.`,
    "- Ne fais ni commit ni push : l'usine s'en charge.",
    "- Reste dans le périmètre de la tâche ; ne casse pas ce qui existe.",
    "- Avant de terminer, `npm run verify` doit passer. Lance-le et corrige jusqu'à ce qu'il passe.",
    "- Si tu lances un serveur pour essayer, arrête-le avant de terminer.",
  ]
  if (decisionsPrises.length) parties.push("", "Décisions humaines déjà prises sur ce projet (à respecter) :", ...decisionsPrises.map((d) => `- ${d.question} → ${d.reponse}`))
  if (tache.tentative > 0 && tache.retours) parties.push("", "Ta version précédente a été REFUSÉE. Motifs (corrige-les tous, sans repartir de zéro) :", tache.retours)
  if (tache.tentative === 0 && tache.approche > 0 && tache.retours) parties.push("", "Les tentatives précédentes sur cette tâche ont échoué malgré les corrections. Tu repars de la branche principale : adopte une APPROCHE DIFFÉRENTE. Ce qui a échoué :", tache.retours)
  parties.push("", "Termine par un résumé de 3 lignes au plus : ce que tu as fait, et comment le vérifier.")
  return parties.join("\n")
}

async function fabriquer(ctx, projet, tache) {
  const { config, db } = ctx
  const atelier = config.atelier.url
  const jeton = config.secrets.worker
  const nomDepot = projet.depot.split("/")[1]
  const branche = `usine/${tache.cle.toLowerCase()}`
  const reprendre = tache.tentative > 0 && tache.branche
  const essai = `tentative ${tache.tentative + 1}${tache.approche ? `, approche ${tache.approche + 1}` : ""}`

  maj(db, "taches", tache.id, { statut: "en_cours", branche })
  noter(db, { projet: projet.id, tache: tache.id, type: "fabrication", message: `${tache.cle} commence (${essai})` })
  await retirerEtiquette(config, nomDepot, tache.issue, "usine:attente").catch(() => {})
  await ajouterEtiquettes(config, nomDepot, tache.issue, ["usine:en-cours"]).catch(() => {})
  await ctx.notifier.etape(projet, `:hammer_and_wrench: *${tache.cle}* · ${tache.titre} : l'agent commence (${essai}).`)

  // 1. Préparer l'espace de travail (seule étape, avec le push, qui voit le jeton).
  const prep = await executer(atelier, jeton, [
    "set -eo pipefail",
    `D=/travail/${nomDepot}; rm -rf "$D" && mkdir -p "$D" /tmp/sorties/tache && cd "$D"`,
    `git clone -q "https://x-access-token:$JETON@github.com/${projet.depot}.git" depot 2>&1 | sed "s/$JETON/***/g"`,
    `cd depot && git remote set-url origin https://github.com/${projet.depot}.git`,
    reprendre ? `git checkout -q -B ${q(branche)} origin/${q(branche)} 2>/dev/null || git checkout -q -B ${q(branche)} main` : `git checkout -q -B ${q(branche)} main`,
    "npm ci --no-audit --no-fund > /tmp/sorties/tache/npm.log 2>&1 || npm install --no-audit --no-fund >> /tmp/sorties/tache/npm.log 2>&1",
    "echo '@@ PREPARATION_OK'",
  ].join("\n"), { env: { JETON: config.secrets.github }, minutes: 10 })
  if (!("PREPARATION_OK" in prep.marqueurs)) throw new Error(`Préparation impossible : ${prep.journal.slice(-600)}`)

  // 2. L'agent code. Il ne voit pas le jeton GitHub ; l'atelier est son bac à sable.
  const minutes = config.autonomie?.minutes_max_par_agent ?? 30
  const agent = await executer(atelier, jeton, [
    `cd /travail/${nomDepot}/depot`,
    ecrireFichier("/tmp/sorties/tache/consigne.md", consigne(ctx, projet, tache)),
    `claude -p "$(cat /tmp/sorties/tache/consigne.md)" --output-format json --model ${q(config.modeles.atelier.modele)} --dangerously-skip-permissions --max-turns 150 > /tmp/sorties/tache/agent.json 2> /tmp/sorties/tache/agent.err`,
    "echo \"@@ AGENT_CODE $?\"",
  ].join("\n"), { minutes, surAvancement: () => {} })
  let resume = ""
  try {
    const sortie = JSON.parse(await lireFichier(atelier, jeton, "/tmp/sorties/tache/agent.json"))
    resume = String(sortie.result ?? "").trim().slice(0, 1500)
    if (sortie.is_error) resume = `(l'agent signale une erreur) ${resume}`
  } catch {
    resume = "(pas de résumé de l'agent)"
  }
  if ("DELAI_DEPASSE" in agent.marqueurs) resume = `(arrêté au bout de ${minutes} min) ${resume}`

  // 3. Contrôle local : fichiers protégés restaurés, taille du changement, build et tests.
  const protege = pathspec(config.perimetre_protege ?? [])
  const ctl = await executer(atelier, jeton, [
    "set -o pipefail",
    `cd /travail/${nomDepot}/depot`,
    "git add -A",
    `RESTAURES=$(git diff --cached --name-only main -- ${protege} | tr '\\n' ' ')`,
    "for f in $RESTAURES; do if git cat-file -e \"main:$f\" 2>/dev/null; then git checkout -q main -- \"$f\"; else git rm -q -f --cached \"$f\"; rm -f \"$f\"; fi; done",
    "git add -A",
    "echo \"@@ RESTAURES $RESTAURES\"",
    "echo \"@@ FICHIERS $(git diff --cached --name-only main | wc -l)\"",
    "echo \"@@ LIGNES $(git diff --cached --numstat main -- . ':(exclude)package-lock.json' | awk '{s+=$1+$2} END{print s+0}')\"",
    `npm run verify 2>&1 | tee /tmp/sorties/tache/verify.log | tail -25; echo "@@ VERIFY_CODE \${PIPESTATUS[0]}"; ${COMPTER_TESTS} /tmp/sorties/tache/verify.log`,
  ].join("\n"), { minutes: 10 })
  const m = ctl.marqueurs
  const refus = []
  if (Number(m.FICHIERS ?? 0) === 0) refus.push("aucune modification : la tâche n'a pas été réalisée")
  if (m.VERIFY_CODE !== "0") refus.push(`\`npm run verify\` échoue dans l'atelier :\n${ctl.journal.split("\n").slice(-25).join("\n")}`)
  if (refus.length) return refuser(ctx, projet, tache, refus, { resume })

  // 4. Commit et push de la branche, puis la pull request.
  const push = await executer(atelier, jeton, [
    "set -eo pipefail",
    `cd /travail/${nomDepot}/depot`,
    `git commit -q -m ${q(`${tache.cle} · ${tache.titre}`)} || true`,
    `git push -q --force "https://x-access-token:$JETON@github.com/${projet.depot}.git" HEAD:refs/heads/${branche} 2>&1 | sed "s/$JETON/***/g"`,
    "echo \"@@ SHA $(git rev-parse HEAD)\"",
  ].join("\n"), { env: { JETON: config.secrets.github }, minutes: 5 })
  const sha = push.marqueurs.SHA
  if (!sha) throw new Error(`Push impossible : ${push.journal.slice(-600)}`)
  const lignes = Number(m.LIGNES ?? 0)
  const max = config.autonomie?.lignes_max_par_pr ?? 800
  const corps = [
    `Closes #${tache.issue}`,
    "",
    "### Résumé de l'agent",
    resume || "(aucun)",
    "",
    `- ${m.FICHIERS} fichier(s), ${lignes} ligne(s) modifiée(s)${lignes > max ? ` :warning: au-delà de la limite du contrat (${max})` : ""}`,
    `- ${m.TESTS_PASSES ?? 0} test(s) passé(s) dans l'atelier`,
    ...(m.RESTAURES ? [`- Fichiers protégés restaurés par l'usine : ${m.RESTAURES}`] : []),
    "",
    "_La fusion sera décidée par le code de l'usine, après le vérificateur indépendant._",
  ].join("\n")
  const pr = await ouvrirPR(config, nomDepot, { titre: `${tache.cle} · ${tache.titre}`, corps, branche })
  maj(db, "taches", tache.id, { statut: "verification", pr: pr.number })
  await retirerEtiquette(config, nomDepot, tache.issue, "usine:en-cours").catch(() => {})
  await ajouterEtiquettes(config, nomDepot, tache.issue, ["usine:verification"]).catch(() => {})
  await ctx.notifier.etape(projet, `:mag: *${tache.cle}* : pull request <https://github.com/${projet.depot}/pull/${pr.number}|#${pr.number}> ouverte, le vérificateur la teste.`)

  // 5. Le vérificateur indépendant, puis la porte.
  const v = await verifier(ctx, obtenir(db, "projets", projet.id), obtenir(db, "taches", tache.id), sha)
  if (v.infra) {
    // Une panne du vérificateur n'est pas une faute de l'agent : on escalade sans consommer de tentative.
    maj(db, "taches", tache.id, { statut: "bloquee" })
    return escalader(ctx, { projetId: projet.id, tacheId: tache.id, raison: "verificateur", details: v.raisons.join("\n") })
  }
  maj(db, "taches", tache.id, { verdict: JSON.stringify(v.verdict ?? null), tests: v.tests })
  if (!v.ok) {
    await commentairePR(config, nomDepot, pr.number, `### :x: Refusée par le vérificateur\n\n${v.raisons.map((r) => `- ${r}`).join("\n")}`).catch(() => {})
    return refuser(ctx, projet, tache, v.raisons, { resume })
  }

  // 6. La fusion : décidée ici, par le code. Le sha garantit qu'on fusionne ce qui a été vérifié.
  const bilan = (v.verdict.criteres ?? []).map((c) => `- :white_check_mark: ${c.critere}${c.preuve ? ` — ${c.preuve}` : ""}`).join("\n")
  await commentairePR(config, nomDepot, pr.number, `### :white_check_mark: Validée par le vérificateur\n\n${v.verdict.resume ?? ""}\n\n${bilan}\n\n${v.tests} test(s) passé(s).`).catch(() => {})
  await fusionnerPR(config, nomDepot, pr.number, { titre: `${tache.cle} · ${tache.titre} (#${pr.number})`, sha })
  const p = obtenir(db, "projets", projet.id)
  maj(db, "projets", projet.id, { plancher_tests: Math.max(p.plancher_tests, v.tests) })
  maj(db, "taches", tache.id, { statut: "fusionnee" })
  await retirerEtiquette(config, nomDepot, tache.issue, "usine:verification").catch(() => {})
  await ajouterEtiquettes(config, nomDepot, tache.issue, ["usine:fusionnee"]).catch(() => {})
  noter(db, { projet: projet.id, tache: tache.id, type: "fusion", message: `${tache.cle} fusionnée (PR #${pr.number}, ${v.tests} tests)` })
  await ctx.notifier.etape(projet, `:white_check_mark: *${tache.cle}* · ${tache.titre} : vérifiée et fusionnée (<https://github.com/${projet.depot}/pull/${pr.number}|#${pr.number}>, ${v.tests} tests). ${v.verdict.resume ?? ""}`)
  await apresFusion(ctx, projet.id, tache.lot)
}

// Un refus : on corrige, puis on change d'approche, puis on appelle l'humain.
async function refuser(ctx, projet, tache, raisons, { resume }) {
  const { config, db } = ctx
  const a = config.autonomie ?? {}
  const texte = raisons.map((r) => `- ${r}`).join("\n").slice(0, 6000)
  const tentative = tache.tentative + 1
  noter(db, { projet: projet.id, tache: tache.id, type: "refus", message: `${tache.cle} refusée (${raisons.length} motif(s)) : ${raisons[0]}` })
  if (tentative <= (a.tentatives_par_tache ?? 2)) {
    maj(db, "taches", tache.id, { statut: "prete", tentative, retours: texte })
    return ctx.notifier.etape(projet, `:repeat: *${tache.cle}* refusée : ${raisons[0].split("\n")[0].slice(0, 200)}. Correction ${tentative}/${a.tentatives_par_tache ?? 2}.`)
  }
  if (tache.approche < (a.changements_d_approche ?? 1)) {
    maj(db, "taches", tache.id, { statut: "prete", tentative: 0, approche: tache.approche + 1, retours: texte, branche: null })
    return ctx.notifier.etape(projet, `:twisted_rightwards_arrows: *${tache.cle}* : les corrections ne suffisent pas, l'agent repart avec une autre approche.`)
  }
  maj(db, "taches", tache.id, { statut: "bloquee", retours: texte })
  return escalader(ctx, { projetId: projet.id, tacheId: tache.id, raison: "criteres", details: `${texte}\n\nDernier résumé de l'agent :\n${resume}` })
}
