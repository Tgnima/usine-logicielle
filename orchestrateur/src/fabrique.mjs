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
import { RESEAU, executer, ecrireFichier, lireFichier, q } from "./travaux.mjs"
import { ajouterEtiquettes, commentairePR, ecrireFichierDepot, fusionnerPR, ouvrirPR, retirerEtiquette } from "./github.mjs"
import { COMPTER_TESTS, VERROUS, brancheDeBase, brancheDeTache, estRepris, lireProfil, proteges } from "./profil.mjs"
import { pathspec, verifier } from "./verification.mjs"
import { escalader } from "./escalade.mjs"
import { apresFusion } from "./livraison.mjs"
import { ecrireReglage, enregistrer, lireReglage, usagesClaude } from "./couts.mjs"
import { verifierBudgets } from "./budgets.mjs"
import { garderCaptures } from "./suivi.mjs"
import { decrireDefaut, relireSecurite } from "./relectures.mjs"
import { facturationsEnCours, nomMode, noterLimites, scriptClaude, signalerFacturation } from "./moteurs.mjs"
import { REGLE_PYRAMIDE } from "./pyramide.mjs"

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

const enPauseLimite = (db) => {
  const jusqua = lireReglage(db, "pause_limite", "")
  return jusqua && new Date(jusqua) > new Date() ? jusqua : null
}

let occupe = false
let dernierServi = 0

// À tour de rôle : on part du projet qui suit le dernier servi, pour qu'un projet
// aux nombreuses tâches ne fasse pas attendre tous les autres.
export const aTourDeRole = (projets, dernier) => [...projets.filter((p) => p.id > dernier), ...projets.filter((p) => p.id <= dernier)]

export function demarrerFabrique(ctx) {
  const tick = async () => {
    if (occupe || arretGeneral(ctx.config) || enPauseLimite(ctx.db)) return
    // Les budgets d'abord : alertes, escalades, et arrêt si le budget mensuel est épuisé.
    if (await verifierBudgets(ctx).catch((e) => (console.error("Budgets :", e), false))) return
    const projets = ctx.db.prepare("SELECT * FROM projets WHERE statut = 'fabrication' ORDER BY id").all()
    for (const projet of aTourDeRole(projets, dernierServi)) {
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
      dernierServi = projet.id
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
  const repris = estRepris(projet)
  const p = lireProfil(projet)
  const parties = [
    `Tu es développeur senior dans une usine logicielle. Tu travailles dans ce dépôt : le produit « ${projet.nom} » (${plan.resume}).`,
    `Lis d'abord MISSION.md (le cap, et ce qu'on ne construit pas)${projet.persona_id ? ", ICP.md (le persona : juge chaque choix de son point de vue)" : ""}, AGENTS.md${repris ? " s'il existe" : ""} (les conventions, à suivre strictement) puis docs/PLAN.md (le plan validé).`,
    ...(repris ? [`Ce produit existait avant l'usine (docs/INVENTAIRE.md dit ce qui marchait) : pars du code existant, respecte sa pile (${p.pile}) et son organisation, ne réécris pas ce qui marche.`] : []),
    "",
    `Lot ${tache.lot} : ${lot?.nom ?? ""}. Objectif du lot : ${lot?.objectif ?? ""}`,
    `Ta tâche : ${tache.cle} · ${tache.titre}`,
    tache.description,
    "",
    "Critères d'acceptation. Un vérificateur indépendant les testera un par un sur l'application en marche, comme un visiteur (avec DEMO=1, emails capturés par Mailpit, sans liste de destinataires autorisés ; il peut relancer l'application avec une variable d'environnement si un critère l'exige) :",
    ...criteres.map((c, i) => `${i + 1}. ${c}`),
    "",
    "Règles :",
    repris
      ? `- Écris d'abord les tests des critères testables sans navigateur, avec l'outil de test du dépôt (la commande \`${p.tester}\` doit les lancer), puis le code.`
      : "- Écris d'abord les tests (node:test) des critères testables sans navigateur, puis le code.",
    "- Ne supprime ni n'affaiblis aucun test existant.",
    `- Ne modifie pas les fichiers protégés : ${proteges(ctx.config, projet).join(", ")}. L'usine les restaurerait.`,
    "- Ne fais ni commit ni push : l'usine s'en charge.",
    "- Reste dans le périmètre de la tâche ; ne casse pas ce qui existe.",
    repris
      ? `- Avant de terminer, \`${p.construire}\` puis \`${p.tester}\` doivent passer. Lance-les et corrige jusqu'à ce qu'ils passent (dépendances : \`${p.installer}\`).`
      : "- Avant de terminer, `npm run verify` doit passer. Lance-le et corrige jusqu'à ce qu'il passe.",
    repris
      ? `- Puis autocontrôle, comme le fera le vérificateur : lance l'application (\`PORT=4300 DEMO=1 DATA_DIR=/tmp/autocontrole ${p.demarrer} &\`), vérifie que GET /api/health répond 200, vérifie avec curl chaque critère observable par HTTP et que les pages demandées répondent, puis arrête-la. Corrige ce qui ne tient pas.`
      : "- Puis autocontrôle, comme le fera le vérificateur : `npm run build`, lance l'application (`PORT=4300 DEMO=1 DATA_DIR=/tmp/autocontrole npm start &`), vérifie avec curl chaque critère observable par HTTP et que les pages demandées répondent, puis arrête-la. Corrige ce qui ne tient pas.",
    "- Si docs/maquettes/ existe, ce sont les maquettes, captures ou documents fournis par l'utilisateur : regarde-les (outil Read) et respecte-les.",
    repris
      ? "- Design (si le produit a des écrans) : lis docs/DESIGN.md s'il existe, réutilise les composants et le style déjà présents dans le dépôt ; tes écrans seront jugés sur captures (ordinateur et mobile)."
      : "- Design (si le produit a des écrans, dossier client/) : lis docs/DESIGN.md s'il existe, construis avec client/src/ui et les jetons de couleur ; tes écrans seront jugés sur captures (ordinateur et mobile) avec sa grille.",
    "- Si tu lances un serveur pour essayer, arrête-le avant de terminer.",
    ...(plan.sens ? [`- Le sens du produit, décidé à partir du persona (c'est lui qui guide tes choix d'écran et de texte) : ${plan.sens.promesse} On le ressent ici : ${plan.sens.moment}.`] : []),
    `- ${REGLE_PYRAMIDE.replace(/\n/g, "\n  ")}\n  Sur les écrans de ta tâche, sans sortir de son périmètre : le produit sera noté étage par étage à la livraison.`,
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
  // Les appels GitHub prennent le dépôt complet (un dépôt repris peut appartenir à quelqu'un d'autre).
  const nomDepot = projet.depot
  const base = brancheDeBase(projet)
  const profil = lireProfil(projet)
  const dossier = `/travail/${projet.slug}/depot`
  const branche = brancheDeTache(projet, tache.cle)
  const reprendre = tache.tentative > 0 && tache.branche
  const essai = `tentative ${tache.tentative + 1}${tache.approche ? `, approche ${tache.approche + 1}` : ""}`

  maj(db, "taches", tache.id, { statut: "en_cours", branche })
  noter(db, { projet: projet.id, tache: tache.id, type: "fabrication", message: `${tache.cle} commence (${essai})` })
  await retirerEtiquette(config, nomDepot, tache.issue, "usine:attente").catch(() => {})
  await ajouterEtiquettes(config, nomDepot, tache.issue, ["usine:en-cours"]).catch(() => {})
  await ctx.notifier.progres(projet, `🛠️ ${tache.cle} · ${tache.titre} : l'agent commence (${essai})`)

  // 1. Préparer l'espace de travail (seule étape, avec le push, qui voit le jeton).
  const prep = await executer(atelier, jeton, [
    "set -eo pipefail",
    RESEAU,
    `D=/travail/${projet.slug}; rm -rf "$D" && mkdir -p "$D" /tmp/sorties/tache && cd "$D"`,
    `cloner "https://x-access-token:$JETON@github.com/${projet.depot}.git" depot 2>&1 | sed "s/$JETON/***/g"`,
    `cd depot && git remote set-url origin https://github.com/${projet.depot}.git`,
    // Un nouvel essai reprend sa branche, mais la base a pu avancer depuis (une autre tâche fusionnée,
    // une tâche acceptée par un humain) : la branche l'intègre d'abord ; en cas de conflit, on repart de la base.
    reprendre
      ? `if git checkout -q -B ${q(branche)} origin/${q(branche)} 2>/dev/null; then git merge -q --no-edit origin/${q(base)} > /tmp/sorties/tache/integration.log 2>&1 || { git merge --abort; git checkout -q -B ${q(branche)} origin/${q(base)}; echo '@@ REPART_DE_LA_BASE'; }; else git checkout -q -B ${q(branche)} origin/${q(base)}; fi`
      : `git checkout -q -B ${q(branche)} origin/${q(base)}`,
    // Dans l'atelier, un verrou en retard ne bloque pas l'agent (il le remettra d'aplomb).
    `bash -c ${q(profil.installer)} > /tmp/sorties/tache/installation.log 2>&1 || { [ -f package.json ] && npm install --no-audit --no-fund >> /tmp/sorties/tache/installation.log 2>&1; }`,
    "echo '@@ PREPARATION_OK'",
  ].join("\n"), { env: { JETON: config.secrets.github }, minutes: 10 })
  if (!("PREPARATION_OK" in prep.marqueurs)) throw new Error(`Préparation impossible : ${prep.journal.slice(-600)}`)

  // 2. L'agent code. Il ne voit pas le jeton GitHub ; l'atelier est son bac à sable.
  const minutes = config.autonomie?.minutes_max_par_agent ?? 30
  const agent = await executer(atelier, jeton, [
    `cd ${dossier}`,
    ecrireFichier("/tmp/sorties/tache/consigne.md", consigne(ctx, projet, tache)),
    ": > /tmp/sorties/tache/agent.jsonl",
    // Abonnement, puis clé API, puis passerelle : la première façon qui n'est pas à sa limite.
    scriptClaude(ctx, {
      args: `-p --dangerously-skip-permissions --max-turns 150 --output-format stream-json --verbose`, entree: "/tmp/sorties/tache/consigne.md",
      modele: tache.approche > 0 ? (config.modeles.renfort?.modele ?? "claude-opus-5-5") : config.modeles.atelier.modele,
      sortie: "/tmp/sorties/tache/agent.jsonl",
      erreurs: "/tmp/sorties/tache/agent.err",
    }),
    // Le dernier évènement (« result ») a la forme de l'ancienne sortie JSON : coûts et résumé.
    "grep '\"type\":\"result\"' /tmp/sorties/tache/agent.jsonl | tail -1 > /tmp/sorties/tache/agent.json",
  ].join("\n"), { minutes, surAvancement: () => {} })
  let resume = ""
  const acces = noterLimites(ctx, "claude-code", agent.marqueurs)
  await signalerFacturation(ctx, "claude-code", acces)
  const sansCredit = facturationsEnCours(db).filter((f) => f.moteur === "claude-code").map((f) => nomMode(f.mode))
  const limite = acces.epuise
    ? { texte: `toutes les façons d'utiliser Claude (abonnement, clé API, passerelle) sont à leur limite${sansCredit.length ? ` (refus faute de crédit : ${sansCredit.join(", ")})` : ""}`, reprise: acces.reprise ?? new Date(Date.now() + 30 * 60_000) }
    : null
  if (acces.mode && acces.mode !== "abonnement") noter(db, { projet: projet.id, tache: tache.id, type: "moteur", message: `${tache.cle} : l'abonnement Claude est à sa limite, l'agent a travaillé via ${nomMode(acces.mode)} (payé à l'usage).` })
  try {
    const sortie = JSON.parse(await lireFichier(atelier, jeton, "/tmp/sorties/tache/agent.json"))
    // Hors abonnement, ce qui est consommé se paie à l'usage : compté comme la passerelle.
    enregistrer(db, { projet: projet.id, tache: tache.id, role: "agent", moteur: acces.mode && acces.mode !== "abonnement" ? "passerelle" : "claude-code", usages: usagesClaude(sortie), duree_s: agent.duree_s ?? 0 })
    resume = String(sortie.result ?? "").trim().slice(0, 1500)
    if (sortie.is_error) resume = `(l'agent signale une erreur) ${resume}`
  } catch {
    resume = "(pas de résumé de l'agent)"
  }
  if ("DELAI_DEPASSE" in agent.marqueurs) resume = `(arrêté au bout de ${minutes} min) ${resume}`
  if (limite) {
    // La tâche repart telle quelle à la réinitialisation, sans tentative consommée.
    maj(db, "taches", tache.id, { statut: "prete" })
    const deja = enPauseLimite(db)
    ecrireReglage(db, "pause_limite", limite.reprise.toISOString())
    const heure = limite.reprise.toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })
    noter(db, { projet: projet.id, tache: tache.id, type: "pause", message: `Limite d'usage : ${limite.texte}. Reprise automatique vers ${heure} (heure de Paris), sans tentative consommée.` })
    await ctx.notifier.progres(projet, `⏸️ ${tache.cle} : Claude à sa limite d'usage (abonnement et secours), reprise automatique vers ${heure}`).catch(() => {})
    if (!deja) await ctx.notifier.alerte(`:pause_button: *Claude est à sa limite d'usage* (abonnement, et ni clé API ni passerelle disponibles). La fabrication s'arrête sans consommer de tentative et reprend toute seule vers ${heure} (heure de Paris). Pour basculer sans attendre : pose une clé AI Gateway ou une clé API Anthropic (bash secrets.sh editer).`).catch(() => {})
    return
  }

  // 3. Contrôle local : fichiers protégés restaurés, taille du changement, build et tests.
  const protege = pathspec(proteges(config, projet))
  const B = `origin/${base}`
  const ctl = await executer(atelier, jeton, [
    "set -o pipefail",
    `cd ${dossier}`,
    "git add -A",
    `RESTAURES=$(git diff --cached --name-only ${q(B)} -- ${protege} | tr '\\n' ' ')`,
    `for f in $RESTAURES; do if git cat-file -e ${q(B)}":$f" 2>/dev/null; then git checkout -q ${q(B)} -- "$f"; else git rm -q -f --cached "$f"; rm -f "$f"; fi; done`,
    "git add -A",
    "echo \"@@ RESTAURES $RESTAURES\"",
    `echo "@@ FICHIERS $(git diff --cached --name-only ${q(B)} | wc -l)"`,
    `echo "@@ LIGNES $(git diff --cached --numstat ${q(B)} -- . ${VERROUS} | awk '{s+=$1+$2} END{print s+0}')"`,
    // Le contrôle du profil : construire puis tester (npm run verify pour une brique).
    `{ bash -c ${q(profil.construire)} && bash -c ${q(profil.tester)}; } 2>&1 | tee /tmp/sorties/tache/verify.log | tail -25; echo "@@ VERIFY_CODE \${PIPESTATUS[0]}"; ${COMPTER_TESTS} /tmp/sorties/tache/verify.log`,
  ].join("\n"), { minutes: 10 })
  const m = ctl.marqueurs
  const refus = []
  if (Number(m.FICHIERS ?? 0) === 0) refus.push("aucune modification : la tâche n'a pas été réalisée")
  if (m.VERIFY_CODE !== "0") refus.push(`\`${profil.construire}\` puis \`${profil.tester}\` échouent dans l'atelier :\n${ctl.journal.split("\n").slice(-25).join("\n")}`)
  if (refus.length) return refuser(ctx, projet, tache, refus, { resume })

  // 4. Commit et push de la branche, puis la pull request.
  const push = await executer(atelier, jeton, [
    "set -eo pipefail",
    RESEAU,
    `cd ${dossier}`,
    `git commit -q -m ${q(`${tache.cle} · ${tache.titre}`)} || true`,
    `reessayer git push -q --force "https://x-access-token:$JETON@github.com/${projet.depot}.git" HEAD:refs/heads/${branche} 2>&1 | sed "s/$JETON/***/g"`,
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
  const pr = await ouvrirPR(config, nomDepot, { titre: `${tache.cle} · ${tache.titre}`, corps, branche, base })
  maj(db, "taches", tache.id, { statut: "verification", pr: pr.number })
  await retirerEtiquette(config, nomDepot, tache.issue, "usine:en-cours").catch(() => {})
  await ajouterEtiquettes(config, nomDepot, tache.issue, ["usine:verification"]).catch(() => {})
  await ctx.notifier.progres(projet, `🔎 ${tache.cle} : PR <https://github.com/${projet.depot}/pull/${pr.number}|#${pr.number}> en relecture et en vérification`)

  // 5. La relecture sécurité (un autre agent, une grille) : un défaut grave renvoie la tâche.
  const rs = await relireSecurite(ctx, projet, tache, { dossier, base }).catch((e) => ({ graves: [], mineurs: [], resume: e.message, indisponible: true }))
  if (rs.graves.length) {
    await commentairePR(config, nomDepot, pr.number, `### :lock: Refusée par la relecture sécurité\n\n${rs.graves.map((d) => `- ${decrireDefaut(d)}`).join("\n")}`).catch(() => {})
    return refuser(ctx, projet, tache, rs.graves.map((d) => `sécurité : ${decrireDefaut(d)}`), { resume })
  }
  if (rs.mineurs.length) await commentairePR(config, nomDepot, pr.number, `### :lock: Relecture sécurité : remarques mineures\n\n${rs.mineurs.map((d) => `- ${decrireDefaut(d)}`).join("\n")}`).catch(() => {})

  // 6. Le vérificateur indépendant, puis la porte.
  const v = await verifier(ctx, obtenir(db, "projets", projet.id), obtenir(db, "taches", tache.id), sha)
  if (v.limite) {
    // Codex à sa limite partout : la tâche repassera (sans tentative consommée) à la reprise.
    maj(db, "taches", tache.id, { statut: "prete" })
    ecrireReglage(db, "pause_limite", (v.reprise ?? new Date(Date.now() + 30 * 60_000)).toISOString())
    noter(db, { projet: projet.id, tache: tache.id, type: "pause", message: `${tache.cle} : Codex (vérificateur) à sa limite d'usage, abonnement et secours compris. Reprise automatique, sans tentative consommée.` })
    return ctx.notifier.alerte(`:pause_button: *Le vérificateur (Codex) est à sa limite d'usage*, abonnement et secours compris. La fabrication reprend toute seule à la réinitialisation, sans consommer de tentative.`).catch(() => {})
  }
  if (v.infra) {
    // Une panne du vérificateur n'est pas une faute de l'agent : on escalade sans consommer de tentative.
    maj(db, "taches", tache.id, { statut: "bloquee" })
    return escalader(ctx, { projetId: projet.id, tacheId: tache.id, raison: "verificateur", details: v.raisons.join("\n") })
  }
  maj(db, "taches", tache.id, { verdict: JSON.stringify(v.verdict ?? null), tests: v.tests, design: v.design ? JSON.stringify({ note: v.design.note ?? null, mineurs: v.design.mineurs ?? [], resume: v.design.resume ?? "" }) : null })
  if (!v.ok) {
    await commentairePR(config, nomDepot, pr.number, `### :x: Refusée par le vérificateur\n\n${v.raisons.map((r) => `- ${r}`).join("\n")}`).catch(() => {})
    return refuser(ctx, projet, tache, v.raisons, { resume })
  }

  if (v.captures?.length) await garderCaptures(ctx, projet.id, tache.cle, v.captures).catch((e) => console.error("Captures :", e.message))

  // 7. La fusion : décidée ici, par le code. Le sha garantit qu'on fusionne ce qui a été vérifié.
  const bilan = (v.verdict.criteres ?? []).map((c) => `- :white_check_mark: ${c.critere}${c.preuve ? ` — ${c.preuve}` : ""}`).join("\n")
  const designPR = v.design ? `\n\n### :art: Design : ${v.design.note ?? "?"}/10\n${v.design.resume ?? ""}${(v.design.mineurs ?? []).length ? `\n\nÀ polir (lot de finition) :\n${v.design.mineurs.map((d) => `- ${d.ecran ? `${d.ecran} : ` : ""}${d.defaut}`).join("\n")}` : ""}` : ""
  await commentairePR(config, nomDepot, pr.number, `### :white_check_mark: Validée par le vérificateur\n\n${v.verdict.resume ?? ""}\n\n${bilan}\n\n${v.tests} test(s) passé(s).${designPR}`).catch(() => {})
  try {
    await fusionnerPR(config, nomDepot, pr.number, { titre: `${tache.cle} · ${tache.titre} (#${pr.number})`, sha })
  } catch (error) {
    // La base a avancé pendant la vérification et la PR est en conflit (ou sa branche a bougé) :
    // ce n'est pas une panne. La tâche repasse, sans tentative consommée, et intégrera la base.
    if (![405, 409].includes(error.statut)) throw error
    maj(db, "taches", tache.id, { statut: "prete", retours: `${tache.retours ? `${tache.retours}\n` : ""}- La branche de base a avancé pendant la vérification (conflit à la fusion) : la tâche intègre ses derniers changements et repasse la vérification.` })
    noter(db, { projet: projet.id, tache: tache.id, type: "conflit", message: `${tache.cle} : validée, mais en conflit avec ${base} au moment de la fusion (PR #${pr.number}). Elle intègre la base et repasse, sans tentative consommée.` })
    await commentairePR(config, nomDepot, pr.number, `### :twisted_rightwards_arrows: Conflit avec \`${base}\` au moment de la fusion\n\nLa base a avancé pendant la vérification. La tâche intègre ses derniers changements et repasse la vérification.`).catch(() => {})
    await retirerEtiquette(config, nomDepot, tache.issue, "usine:verification").catch(() => {})
    return ctx.notifier.progres(projet, `🔀 ${tache.cle} : validée mais en conflit avec la base (une autre tâche a été fusionnée entre-temps) ; elle intègre la base et repasse`)
  }
  const p = obtenir(db, "projets", projet.id)
  maj(db, "projets", projet.id, { plancher_tests: Math.max(p.plancher_tests, v.tests) })
  maj(db, "taches", tache.id, { statut: "fusionnee" })
  // Le cliquet : les tests écrits par le vérificateur rejoignent .usine/e2e/ (protégé), rejoués à chaque tâche.
  let versés = 0
  for (const fichier of v.nouveauxTests ?? []) {
    const contenu = await lireFichier(config.verificateur.url, config.secrets.worker, `/tmp/sorties/verif/e2e/${fichier}`).catch(() => null)
    if (!contenu) continue
    await ecrireFichierDepot(config, nomDepot, `.usine/e2e/${fichier}`, String(contenu), `Non-régression : ${fichier} (${tache.cle})`, base).then(() => versés++).catch((e) => console.error("Test de non-régression :", e.message))
  }
  if (versés) noter(db, { projet: projet.id, tache: tache.id, type: "cliquet", message: `${versés} test(s) de non-régression ajouté(s) (${tache.cle})` })
  await retirerEtiquette(config, nomDepot, tache.issue, "usine:verification").catch(() => {})
  await ajouterEtiquettes(config, nomDepot, tache.issue, ["usine:fusionnee"]).catch(() => {})
  noter(db, { projet: projet.id, tache: tache.id, type: "fusion", message: `${tache.cle} fusionnée (PR #${pr.number}, ${v.tests} tests)` })
  await ctx.notifier.progres(projet, `✅ ${tache.cle} · ${tache.titre} : fusionnée (<https://github.com/${projet.depot}/pull/${pr.number}|#${pr.number}>, ${v.tests} tests${v.design?.note !== undefined && v.design?.note !== null ? `, design ${v.design.note}/10` : ""})`)
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
    return ctx.notifier.progres(projet, `🔁 ${tache.cle} refusée (${raisons[0].split("\n")[0].slice(0, 120)}) : correction ${tentative}/${a.tentatives_par_tache ?? 2}`)
  }
  if (tache.approche < (a.changements_d_approche ?? 1)) {
    maj(db, "taches", tache.id, { statut: "prete", tentative: 0, approche: tache.approche + 1, retours: texte, branche: null })
    return ctx.notifier.progres(projet, `🔀 ${tache.cle} : les corrections ne suffisent pas, autre approche (modèle renforcé)`)
  }
  maj(db, "taches", tache.id, { statut: "bloquee", retours: texte })
  return escalader(ctx, { projetId: projet.id, tacheId: tache.id, raison: "criteres", details: `${texte}\n\nDernier résumé de l'agent :\n${resume}` })
}
