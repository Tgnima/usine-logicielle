// L'audit du vérificateur (« l'écart 1 » de la boucle de vérification). Rien ne prouvait que nos
// contrôles attrapent un vrai bug. L'usine en plante donc exprès, un à la fois, dans une copie d'un
// produit déjà livré. Puis elle relance la VRAIE vérification, avec les critères d'une tâche déjà
// livrée, sans dire ce qui est cassé. Elle compte ce qui est attrapé et ce qui passe, puis efface tout.
//
//   pour chaque bug : clone de la base -> branche usine/audit/… -> un agent « planteur » plante UN bug
//   -> contrôle par le code (fichiers touchés) -> push -> verifier() -> attrapé | raté | non jugé
//   -> la branche est supprimée, quoi qu'il arrive
//
// Aucune pull request, aucune fusion : hors de la branche d'audit, rien n'est écrit dans le dépôt.
// L'atelier est réservé pendant tout l'audit (avecAtelierReserve) : la fabrication attend la fin.
import { noter, obtenir } from "./db.mjs"
import { RESEAU, executer, ecrireFichier, lireFichier, q } from "./travaux.mjs"
import { brancheDeBase, lireProfil, proteges } from "./profil.mjs"
import { pathspec, verifier } from "./verification.mjs"
import { arretGeneral, avecAtelierReserve } from "./fabrique.mjs"
import { supprimerBranche } from "./github.mjs"
import { ecrireReglage, enregistrer, lireReglage, usagesClaude } from "./couts.mjs"
import { noterLimites, scriptClaude, signalerFacturation } from "./moteurs.mjs"

// Les quatre sortes de bugs, plantées chacune à son tour.
export const SORTES = [
  { cle: "compteur", nom: "un compteur décalé d'un", consigne: "un compteur décalé d'un. Un total, un nombre restant, une position, une limite ou une borne compte un de trop ou un de moins (< au lieu de <=, un + 1 oublié, un indice qui part de 1)." },
  { cle: "sauvegarde", nom: "une sauvegarde qui ne se fait pas", consigne: "une sauvegarde qui ne se fait pas. L'application répond comme si c'était enregistré, mais la donnée n'est pas écrite (ou pas en entier), ou n'est pas relue ensuite." },
  { cle: "email", nom: "un email noté « envoyé » mais jamais parti", consigne: "un email noté « envoyé » mais jamais parti. L'état, l'écran ou le journal de l'application disent « envoyé », mais l'envoi n'a pas lieu." },
  { cle: "erreur", nom: "une erreur avalée", consigne: "une erreur avalée. Une erreur est attrapée puis ignorée : l'utilisateur voit un succès, ou rien, alors que l'opération a échoué." },
]
const nomSorte = (cle) => SORTES.find((s) => s.cle === cle)?.nom ?? cle
const ISSUES = { attrape: "attrapé", rate: "RATÉ", non_juge: "non jugé", non_plante: "non planté" }

export const BUGS_MAX = 8
const DOSSIER = "/travail/audit/depot"
const SORTIES = "/tmp/sorties/audit"
const BUG_TXT = `${SORTIES}/bug.txt`
// Les branches d'audit que GitHub a refusé de supprimer : retentées au début de l'audit suivant.
const CLE_RESTES = "audit_branches"

// Ce qui touche au réseau, aux conteneurs ou à la fabrique : remplacé par des doubles dans les tests.
const DEPS = {
  executer,
  lireFichier,
  verifier,
  supprimerBranche,
  avecAtelierReserve,
  arretGeneral,
  maintenant: () => new Date(),
  attendre: (ms) => new Promise((r) => setTimeout(r, ms)),
}

// Le nombre de bugs demandé : 4 par défaut, de 1 à BUGS_MAX. Sinon null.
export function nombreDeBugs(v) {
  if (v === undefined || v === null || v === "") return 4
  const n = Number(v)
  return Number.isInteger(n) && n >= 1 && n <= BUGS_MAX ? n : null
}

const criteresDe = (t) => {
  try {
    const c = JSON.parse(t?.criteres || "[]")
    return Array.isArray(c) ? c.map(String).filter((x) => x.trim()) : []
  } catch {
    return []
  }
}

// Le projet et la tâche à auditer : un produit livré ou en production, avec un dépôt, et une tâche
// fusionnée qui a des critères (la dernière, ou celle qu'on nomme).
export function choisirTache(db, projetId, tacheCle = null) {
  if (!Number.isInteger(projetId) || projetId <= 0) return { ok: false, message: "Donne le numéro du projet : audit <n°> [bugs] [tâche]." }
  const projet = obtenir(db, "projets", projetId)
  if (!projet) return { ok: false, message: `Projet n°${projetId} introuvable.` }
  if (!["livre", "en_production"].includes(projet.statut)) return { ok: false, message: `${projet.nom} est « ${projet.statut} » : l'audit se fait sur un produit livré ou en production.` }
  if (!projet.depot) return { ok: false, message: `${projet.nom} n'a pas de dépôt GitHub : rien à auditer.` }
  if (tacheCle) {
    const t = db.prepare("SELECT * FROM taches WHERE projet_id = ? AND UPPER(cle) = UPPER(?) ORDER BY statut = 'fusionnee' DESC, id DESC LIMIT 1").get(projet.id, String(tacheCle).trim())
    if (!t) return { ok: false, message: `La tâche ${tacheCle} n'existe pas dans ${projet.nom}.` }
    if (t.statut !== "fusionnee") return { ok: false, message: `La tâche ${t.cle} n'est pas fusionnée (${t.statut}) : l'audit part d'une tâche déjà livrée.` }
    if (!criteresDe(t).length) return { ok: false, message: `La tâche ${t.cle} n'a pas de critères d'acceptation : le vérificateur n'aurait rien à juger.` }
    return { ok: true, projet, tache: t, criteres: criteresDe(t) }
  }
  const t = db.prepare("SELECT * FROM taches WHERE projet_id = ? AND statut = 'fusionnee' ORDER BY id DESC").all(projet.id).find((x) => criteresDe(x).length)
  if (!t) return { ok: false, message: `${projet.nom} n'a aucune tâche fusionnée avec des critères d'acceptation : rien à auditer.` }
  return { ok: true, projet, tache: t, criteres: criteresDe(t) }
}

// La consigne du planteur. Elle cite les critères, mais jamais le jeton GitHub : l'agent ne le voit pas.
export function consignePlanteur(config, projet, tache, criteres, sorte) {
  const p = lireProfil(projet)
  return [
    `Tu audites le vérificateur d'une usine logicielle. Le dossier courant est une COPIE du produit « ${projet.nom} », déjà livré. Rien de ce que tu fais n'ira en ligne, et la copie sera effacée après l'audit.`,
    "",
    `Ta mission : planter UN bug, ${sorte.consigne}`,
    "",
    `Ce bug doit casser un comportement couvert par les critères de la tâche ${tache.cle} · ${tache.titre}. Le vérificateur les testera un par un, sur l'application en marche :`,
    ...criteres.map((c, i) => `${i + 1}. ${c}`),
    "",
    `Ce que la tâche a construit : ${tache.description}`,
    "",
    "Règles :",
    "- Un seul bug, réaliste et discret : une erreur d'inattention qu'un développeur pressé pourrait faire. Aucun commentaire qui le signale, aucun nom qui le trahit, pas de code mort.",
    "- Dans le code de l'application seulement, en changeant le moins de lignes possible, dans un fichier qui existe déjà. N'ajoute ni ne supprime aucun fichier.",
    `- Ne touche ni aux tests (test/, tests/, __tests__/, fichiers *.test.* et *.spec.*), ni à .usine/, ni aux journaux (fichiers .log, CHANGELOG), ni aux fichiers protégés : ${proteges(config, projet).join(", ")}. L'usine écarterait le bug.`,
    `- Un vrai bug qui arrive au vérificateur a passé le build et les tests de l'atelier. Lance \`${p.construire}\` puis \`${p.tester}\` (dépendances : \`${p.installer}\`) : s'ils échouent, plante ton bug ailleurs.`,
    "- Ne fais ni commit ni push : l'usine s'en charge.",
    "- Si tu lances un serveur pour essayer, arrête-le avant de terminer.",
    `- À la fin, écris en une phrase ce que tu as cassé (fichier, fonction, effet visible) dans ${BUG_TXT}, jamais dans le dépôt.`,
    `- Si ce produit n'a rien de cette sorte (aucun email, par exemple), ne modifie rien et écris dans ${BUG_TXT} « impossible : » suivi de la raison.`,
  ].join("\n")
}

// Un fichier de test, d'après son chemin.
export const estFichierDeTest = (f) => /(^|\/)(test|tests|__tests__)\//.test(f) || /\.(test|spec)\.[^/]+$/.test(f)

// Le contrôle par le code, avant tout push. Renvoie les raisons d'écarter le bug (aucune : il est planté).
export function controlerBug({ fichiers = [], protegesTouches = [] }) {
  const raisons = []
  if (!fichiers.length) raisons.push("aucun fichier modifié")
  const tests = fichiers.filter(estFichierDeTest)
  if (tests.length) raisons.push(`fichier(s) de test modifié(s) : ${tests.join(", ")}`)
  const usine = fichiers.filter((f) => f.startsWith(".usine/"))
  if (usine.length) raisons.push(`fichier(s) de .usine/ modifié(s) : ${usine.join(", ")}`)
  const autres = protegesTouches.filter((f) => !usine.includes(f) && !tests.includes(f))
  if (autres.length) raisons.push(`fichier(s) protégé(s) modifié(s) : ${autres.join(", ")}`)
  return raisons
}

// Une liste de fichiers passée par un marqueur, en base64 (un nom de fichier ne peut pas forger de marqueur).
const listeDe = (v) => Buffer.from(String(v ?? ""), "base64").toString("utf8").split("\n").map((f) => f.trim()).filter(Boolean)
const finDe = (journal, n = 400) => String(journal ?? "").slice(-n)
const horodater = (d) => d.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")

// 1. Le clone, sur la branche de base (seule étape, avec l'envoi, qui voit le jeton GitHub).
function scriptPreparation(projet, branche) {
  const profil = lireProfil(projet)
  return [
    "# audit : preparation",
    "set -eo pipefail",
    RESEAU,
    `rm -rf /travail/audit ${SORTIES} && mkdir -p /travail/audit ${SORTIES} && cd /travail/audit`,
    `cloner "https://x-access-token:$JETON@github.com/${projet.depot}.git" depot 2>&1 | sed "s/$JETON/***/g"`,
    `cd depot && git remote set-url origin https://github.com/${projet.depot}.git`,
    `git checkout -q -B ${q(branche)} origin/${q(brancheDeBase(projet))}`,
    `bash -c ${q(profil.installer)} > ${SORTIES}/installation.log 2>&1 || { [ -f package.json ] && npm install --no-audit --no-fund >> ${SORTIES}/installation.log 2>&1; }`,
    "echo '@@ PREPARATION_OK'",
  ].join("\n")
}

// 2. Le planteur. Il ne voit pas le jeton GitHub ; l'atelier est son bac à sable.
function scriptPlanteur(ctx, projet, tache, criteres, sorte) {
  return [
    "# audit : planteur",
    `cd ${DOSSIER}`,
    ecrireFichier(`${SORTIES}/consigne.md`, consignePlanteur(ctx.config, projet, tache, criteres, sorte)),
    `rm -f ${BUG_TXT} ${SORTIES}/agent.json`,
    scriptClaude(ctx, {
      args: "-p --dangerously-skip-permissions --max-turns 80 --output-format json",
      entree: `${SORTIES}/consigne.md`,
      modele: ctx.config.modeles.atelier.modele,
      sortie: `${SORTIES}/agent.json`,
      erreurs: `${SORTIES}/agent.err`,
    }),
  ].join("\n")
}

// 3. Le contrôle : la liste des fichiers changés, et ceux du périmètre protégé (lus par git, comme la fabrique).
function scriptControle(config, projet) {
  const B = q(`origin/${brancheDeBase(projet)}`)
  return [
    "# audit : controle",
    "set -o pipefail",
    `cd ${DOSSIER}`,
    "git add -A",
    `echo "@@ FICHIERS $(git -c core.quotePath=false diff --cached --name-only ${B} | base64 -w0)"`,
    `echo "@@ PROTEGES_TOUCHES $(git -c core.quotePath=false diff --cached --name-only ${B} -- ${pathspec(proteges(config, projet))} | base64 -w0)"`,
    "echo '@@ CONTROLE_OK'",
  ].join("\n")
}

// 4. Commit et push de la branche d'audit, comme une tâche (le message ne dit pas ce qui est cassé).
function scriptEnvoi(projet, tache, branche) {
  return [
    "# audit : envoi",
    "set -eo pipefail",
    RESEAU,
    `cd ${DOSSIER}`,
    `git commit -q -m ${q(`${tache.cle} · ${tache.titre}`)}`,
    `reessayer git push -q --force "https://x-access-token:$JETON@github.com/${projet.depot}.git" HEAD:refs/heads/${q(branche)} 2>&1 | sed "s/$JETON/***/g"`,
    "echo \"@@ SHA $(git rev-parse HEAD)\"",
  ].join("\n")
}

// Les branches d'audit restées sur GitHub (suppression refusée deux fois, ou orchestrateur redémarré).
function lireRestes(db) {
  try {
    const v = JSON.parse(lireReglage(db, CLE_RESTES, "[]"))
    return Array.isArray(v) ? v.filter((b) => typeof b?.depot === "string" && String(b?.branche).startsWith("usine/audit/")) : []
  } catch {
    return []
  }
}
const ecrireRestes = (db, liste) => ecrireReglage(db, CLE_RESTES, JSON.stringify(liste.slice(-50)))
const memeBranche = (a, b) => a.depot === b.depot && a.branche === b.branche

// Supprime la branche d'audit, avec un second essai. Seules les branches usine/audit/… sont supprimées.
async function supprimerBrancheAudit(ctx, projetId, reste, d) {
  if (!reste.branche.startsWith("usine/audit/")) return false
  for (let essai = 1; essai <= 2; essai++) {
    try {
      await d.supprimerBranche(ctx.config, reste.depot, reste.branche)
      ecrireRestes(ctx.db, lireRestes(ctx.db).filter((b) => !memeBranche(b, reste)))
      return true
    } catch (error) {
      if (essai === 1) await d.attendre(5_000)
      else noter(ctx.db, { projet: projetId, type: "erreur", message: `Audit du vérificateur : la branche ${reste.branche} n'a pas pu être supprimée (${error.message}). L'usine réessaiera au prochain audit ; sinon, supprime-la à la main.` })
    }
  }
  return false
}

// La vraie vérification, sans trace dans la fabrication : la tâche est passée sans son id (ni coût ni
// écriture sur la tâche livrée) et sans ses anciens refus. Les réglages que la vérification tient à jour sont
// remis comme avant : la liste des tests sautés du cliquet (l'ordre du prochain rejeu) et les planchers des
// budgets de l'interface (un bug raté ne doit pas changer le meilleur résultat d'une page).
export const reglagesDeVerification = (projetId) => [`cliquet_sautes_${projetId}`, `budgets_${projetId}`]
async function verifierSansTrace(ctx, projet, tache, sha, d) {
  const avant = reglagesDeVerification(projet.id).map((cle) => [cle, lireReglage(ctx.db, cle, null)])
  try {
    return await d.verifier(ctx, obtenir(ctx.db, "projets", projet.id), { ...tache, id: null, retours: null }, sha)
  } finally {
    for (const [cle, valeur] of avant) {
      if (valeur === null) ctx.db.prepare("DELETE FROM reglages WHERE cle = ?").run(cle)
      else ecrireReglage(ctx.db, cle, valeur)
    }
  }
}

// Un bug : planté, contrôlé, poussé, vérifié. Renvoie { bug, arret } (arret : pourquoi ne pas continuer).
async function auditerUnBug(ctx, { projet, tache, criteres, sorte, branche }, d) {
  const { config, db } = ctx
  const atelier = config.atelier.url
  const jeton = config.secrets.worker
  const bug = { sorte: sorte.cle, description: "", sha: null, issue: "non_plante", raisons: [] }
  const reste = { depot: projet.depot, branche }
  let pousse = false
  try {
    const prep = await d.executer(atelier, jeton, scriptPreparation(projet, branche), { env: { JETON: config.secrets.github }, minutes: 10 })
    if (!("PREPARATION_OK" in prep.marqueurs)) {
      bug.raisons.push(`préparation impossible : ${finDe(prep.journal)}`)
      return { bug }
    }

    const minutes = Math.min(20, Number(config.autonomie?.minutes_max_par_agent) || 30)
    const agent = await d.executer(atelier, jeton, scriptPlanteur(ctx, projet, tache, criteres, sorte), { minutes })
    const acces = noterLimites(ctx, "claude-code", agent.marqueurs)
    await signalerFacturation(ctx, "claude-code", acces)
    if (acces.epuise) {
      bug.raisons.push("Claude est à sa limite d'usage : le bug n'a pas pu être planté")
      return { bug, arret: "Claude est à sa limite d'usage" }
    }
    try {
      const sortie = JSON.parse(await d.lireFichier(atelier, jeton, `${SORTIES}/agent.json`))
      enregistrer(db, { projet: projet.id, role: "audit", moteur: acces.mode && acces.mode !== "abonnement" ? "passerelle" : "claude-code", usages: usagesClaude(sortie), duree_s: agent.duree_s ?? 0 })
    } catch {}
    bug.description = String((await d.lireFichier(atelier, jeton, BUG_TXT).catch(() => null)) ?? "").replace(/\s+/g, " ").trim().slice(0, 500)
    if (/^impossible\b/i.test(bug.description)) {
      bug.raisons.push(`le planteur n'a pas trouvé où planter ce bug (${bug.description})`)
      return { bug }
    }
    if ("DELAI_DEPASSE" in agent.marqueurs) bug.raisons.push(`planteur arrêté au bout de ${minutes} min`)

    const ctl = await d.executer(atelier, jeton, scriptControle(config, projet), { minutes: 5 })
    if (!("CONTROLE_OK" in ctl.marqueurs)) {
      bug.raisons.push(`contrôle impossible : ${finDe(ctl.journal)}`)
      return { bug }
    }
    const ecarts = controlerBug({ fichiers: listeDe(ctl.marqueurs.FICHIERS), protegesTouches: listeDe(ctl.marqueurs.PROTEGES_TOUCHES) })
    if (ecarts.length) {
      bug.raisons.push(...ecarts)
      return { bug }
    }

    // La branche est notée avant le push : un orchestrateur coupé en plein audit ne la perd pas.
    ecrireRestes(db, [...lireRestes(db).filter((b) => !memeBranche(b, reste)), reste])
    pousse = true
    const envoi = await d.executer(atelier, jeton, scriptEnvoi(projet, tache, branche), { env: { JETON: config.secrets.github }, minutes: 5 })
    if (!envoi.marqueurs.SHA) {
      bug.raisons.push(`push impossible : ${finDe(envoi.journal)}`)
      return { bug }
    }
    bug.sha = envoi.marqueurs.SHA
    bug.issue = "non_juge"

    const v = await verifierSansTrace(ctx, projet, tache, bug.sha, d)
    bug.raisons = (v.raisons ?? []).slice(0, 8).map((r) => String(r).slice(0, 500))
    if (v.limite || v.infra) return { bug, arret: v.limite ? "le vérificateur est à sa limite d'usage" : null }
    bug.issue = v.ok ? "rate" : "attrape"
    return { bug }
  } catch (error) {
    // Avant le push : non planté ; après : non jugé. La branche est supprimée quand même (finally).
    bug.raisons.push(`${bug.sha ? "vérification" : "préparation du bug"} interrompue : ${String(error.message).slice(0, 400)}`)
    return { bug }
  } finally {
    if (pousse) await supprimerBrancheAudit(ctx, projet.id, reste, d)
  }
}

// Le score et les textes du résultat.
export function resumerAudit(projet, tache, bugs) {
  const compte = (issue) => bugs.filter((b) => b.issue === issue).length
  const score = { attrapes: compte("attrape"), rates: compte("rate"), non_juges: compte("non_juge"), non_plantes: compte("non_plante"), total: bugs.length }
  const s = (n) => (n > 1 ? "s" : "")
  const juges = score.attrapes + score.rates
  const autres = [score.non_juges && `${score.non_juges} non jugé${s(score.non_juges)}`, score.non_plantes && `${score.non_plantes} non planté${s(score.non_plantes)}`].filter(Boolean)
  const titre = `Audit du vérificateur sur ${projet.nom} : ${juges ? `${score.attrapes} bug${s(score.attrapes)} attrapé${s(score.attrapes)} sur ${juges}` : "aucun bug jugé"}${autres.length ? ` (${autres.join(", ")})` : ""}`
  const premiere = (b) => (b.raisons[0] ? ` (${String(b.raisons[0]).split("\n")[0].slice(0, 200)})` : "")
  const ligne = (b, i) => `${i + 1}. ${nomSorte(b.sorte)} : ${ISSUES[b.issue]}${b.description ? `. ${b.description}` : ""}${b.issue === "rate" ? "" : premiere(b)}`
  const journal = [`${titre}. Critères de ${tache.cle} · ${tache.titre}.`, ...bugs.map(ligne)].join("\n")
  const rates = bugs.filter((b) => b.issue === "rate")
  const mis = bugs.filter((b) => b.issue === "non_juge" || b.issue === "non_plante")
  const annonce = [
    `:mag: *${titre}* (critères de ${tache.cle} · ${tache.titre}).`,
    rates.length ? `Ratés : le vérificateur a validé ces bugs.\n${rates.map((b) => `• ${nomSorte(b.sorte)} : ${b.description || "(pas de description)"}`).join("\n")}` : juges ? "Aucun bug raté." : "",
    mis.length ? `Hors score :\n${mis.map((b) => `• ${nomSorte(b.sorte)} : ${ISSUES[b.issue]}${premiere(b)}`).join("\n")}` : "",
  ].filter(Boolean).join("\n")
  return { score, titre, journal, annonce }
}

async function annoncer(ctx, texte) {
  try {
    await ctx.notifier?.alerte?.(texte)
  } catch (error) {
    console.error("Audit du vérificateur : annonce impossible :", error.message)
  }
}

async function deroulerAudit(ctx, { projet, tache, criteres }, n, d) {
  const { db } = ctx
  noter(db, { projet: projet.id, type: "audit", message: `Audit du vérificateur commencé : ${n} bug(s) à planter, critères de ${tache.cle}. La fabrication attend la fin.` })
  await annoncer(ctx, `:mag: *Audit du vérificateur* sur ${projet.nom} : ${n} bug(s) à planter, un à la fois (critères de ${tache.cle}). La fabrication attend la fin, une dizaine de minutes par bug.`)
  // D'abord les branches d'un audit précédent que GitHub n'avait pas laissé supprimer.
  for (const reste of lireRestes(db)) await supprimerBrancheAudit(ctx, projet.id, reste, d)

  const horodatage = horodater(d.maintenant())
  const bugs = []
  let arret = null
  for (let i = 1; i <= n; i++) {
    const sorte = SORTES[(i - 1) % SORTES.length]
    if (!arret && d.arretGeneral(ctx.config)) arret = "l'usine a été arrêtée pendant l'audit"
    if (arret) {
      bugs.push({ sorte: sorte.cle, description: "", sha: null, issue: "non_plante", raisons: [`audit interrompu : ${arret}`] })
      continue
    }
    const r = await auditerUnBug(ctx, { projet, tache, criteres, sorte, branche: `usine/audit/${horodatage}-${i}` }, d)
    bugs.push(r.bug)
    if (r.arret) arret = r.arret
  }

  const { score, titre, journal, annonce } = resumerAudit(projet, tache, bugs)
  noter(db, { projet: projet.id, type: "audit", message: journal })
  ecrireReglage(db, `audit_${projet.id}`, JSON.stringify({ le: d.maintenant().toISOString(), tache: tache.cle, score, bugs }))
  await annoncer(ctx, annonce)
  return { ok: true, score, bugs, message: titre }
}

// Un audit à la fois : le nom de celui qui tourne. Une mise à jour de l'usine attend sa fin (cycle.mjs).
let enCours = null
export const auditEnCours = () => enCours

// L'audit d'un projet livré. Refusé (ok: false, message) si le projet ou la tâche ne s'y prêtent pas, si un
// audit tourne déjà, si l'usine fabrique, est arrêtée, ou si une tâche est en cours.
// surDemarrage : appelé une fois l'atelier réservé, juste avant le premier bug (lancerAudit).
export async function auditer(ctx, projetId, { bugs = 4, tacheCle = null, surDemarrage = null } = {}, deps = {}) {
  const d = { ...DEPS, ...deps }
  if (enCours) return { ok: false, message: `Un audit du vérificateur tourne déjà (${enCours}) : attends son résultat.` }
  const n = nombreDeBugs(bugs)
  if (!n) return { ok: false, message: `Le nombre de bugs va de 1 à ${BUGS_MAX}.` }
  const choix = choisirTache(ctx.db, projetId, tacheCle)
  if (!choix.ok) return choix
  enCours = `${choix.projet.nom}, critères de ${choix.tache.cle}`
  try {
    return await d.avecAtelierReserve(async () => {
      if (d.arretGeneral(ctx.config)) return { ok: false, message: "L'usine est arrêtée : reprends-la avant de lancer un audit." }
      const t = ctx.db.prepare("SELECT t.cle, p.nom FROM taches t JOIN projets p ON p.id = t.projet_id WHERE t.statut IN ('en_cours', 'verification') LIMIT 1").get()
      if (t) return { ok: false, message: `Une tâche est en cours (${t.cle} de ${t.nom}) : lance l'audit quand elle sera finie.` }
      surDemarrage?.({ projet: choix.projet, tache: choix.tache, bugs: n })
      return deroulerAudit(ctx, choix, n, d)
    })
  } finally {
    enCours = null
  }
}

// La route POST /audit/:id : un refus revient tout de suite ; sinon la réponse part dès que l'atelier est
// réservé, et l'audit continue en tâche de fond. Son résultat arrive au journal et dans Slack.
export async function lancerAudit(ctx, projetId, options = {}, deps = {}) {
  let signaler
  const demarre = new Promise((r) => (signaler = r))
  const travail = auditer(ctx, projetId, { ...options, surDemarrage: signaler }, deps)
  travail.catch(async (error) => {
    noter(ctx.db, { projet: Number.isInteger(projetId) ? projetId : null, type: "erreur", message: `Audit du vérificateur interrompu : ${error.stack ?? error.message}` })
    await annoncer(ctx, `:x: L'audit du vérificateur (projet n°${projetId}) s'est interrompu : ${error.message}`)
  })
  const premier = await Promise.race([demarre, travail.then((r) => ({ fini: r }), (e) => ({ fini: { ok: false, message: e.message } }))])
  if (premier.fini) return premier.fini
  return { ok: true, message: `Audit lancé sur ${premier.projet.nom} (critères de ${premier.tache.cle}) : ${premier.bugs} bug(s) à planter, une dizaine de minutes chacun. La fabrication attend la fin ; le résultat arrivera dans Slack et au journal du projet.` }
}
