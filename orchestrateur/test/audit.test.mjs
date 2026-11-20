// L'audit du vérificateur : des bugs plantés exprès, jugés par la vraie vérification, comptés par le code.
// Sans réseau ni conteneur : l'atelier, GitHub et la vérification sont des doubles.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ouvrirDb } from "../src/db.mjs"
import { ecrireReglage, lireReglage, ouvrirCouts } from "../src/couts.mjs"
import { avecAtelierReserve } from "../src/fabrique.mjs"
import { SORTES, auditer, choisirTache, consignePlanteur, controlerBug, lancerAudit, nombreDeBugs, resumerAudit } from "../src/audit.mjs"

const JETON_GITHUB = "jeton-github-factice-0123456789"
const b64 = (liste) => Buffer.from(liste.join("\n")).toString("base64")

// Un produit livré, ses tâches, et un faux Slack.
function contexte({ statut = "livre", depot = "exemple/vigie-copro" } = {}) {
  const db = ouvrirDb(":memory:")
  ouvrirCouts(db)
  db.prepare("INSERT INTO projets (prompt, statut, nom, slug, depot) VALUES ('p', ?, 'Vigie Copro', 'vigie', ?)").run(statut, depot)
  const tache = db.prepare("INSERT INTO taches (projet_id, cle, lot, titre, description, criteres, statut, retours) VALUES (1, ?, 1, ?, 'La description.', ?, ?, ?)")
  tache.run("T1", "Les contacts", JSON.stringify(["La page /contacts liste les contacts"]), "fusionnee", null)
  tache.run("T2", "Les messages", JSON.stringify(["Le compteur des messages non lus est juste", "Un message envoyé arrive dans Mailpit"]), "fusionnee", "- design : un ancien refus")
  tache.run("T3", "Les relances", JSON.stringify(["Une relance part chaque lundi"]), "prete", null)
  tache.run("T4", "Le logo", "[]", "fusionnee", null)
  const messages = []
  const config = {
    dataDir: mkdtempSync(join(tmpdir(), "audit-")),
    atelier: { url: "http://atelier.test" },
    verificateur: { url: "http://verificateur.test" },
    secrets: { worker: "jeton-travaux-factice", github: JETON_GITHUB },
    modeles: { atelier: { modele: "claude-sonnet-5-5" } },
    perimetre_protege: ["Dockerfile", "server/email.js", ".usine/**"],
    autonomie: {},
  }
  const ctx = { config, db, notifier: { alerte: async (texte) => messages.push(texte), etape: async () => {}, progres: async () => {} } }
  return { ctx, db, messages }
}

// Un faux atelier : chaque script dit son étape en première ligne (« # audit : … »).
// fichiers(i), protegesTouches(i), description(i) : ce que « fait » le planteur au bug i.
function atelier({ fichiers = () => ["server/messages.js"], protegesTouches = () => [], description = () => "Le compteur des non lus compte un de trop.", epuise = () => false } = {}) {
  const scripts = []
  let i = 0 // le bug en cours : un bug commence par son clone
  const executer = async (_serveur, _jeton, script, options = {}) => {
    const etape = /^# audit : (\w+)/.exec(script)?.[1]
    if (etape === "preparation") i++
    scripts.push({ etape, script, env: options.env ?? {}, bug: i })
    if (etape === "preparation") return { marqueurs: { PREPARATION_OK: "" }, journal: "" }
    if (etape === "planteur") return { marqueurs: epuise(i) ? { EPUISE_CLAUDE: "", AGENT_CODE: "1" } : { MODE_CLAUDE: "abonnement", AGENT_CODE: "0" }, journal: "", duree_s: 60 }
    if (etape === "controle") return { marqueurs: { CONTROLE_OK: "", FICHIERS: b64(fichiers(i)), PROTEGES_TOUCHES: b64(protegesTouches(i)) }, journal: "" }
    if (etape === "envoi") return { marqueurs: { SHA: `sha${i}` }, journal: "" }
    throw new Error(`étape inconnue : ${etape}`)
  }
  const lireFichier = async (_serveur, _jeton, chemin) => {
    if (chemin.endsWith("bug.txt")) return description(i)
    if (chemin.endsWith("agent.json")) return JSON.stringify({ result: "fait", usage: { input_tokens: 10, output_tokens: 5 } })
    return null
  }
  return { executer, lireFichier, scripts }
}

// La vérification, les suppressions de branches et l'attente, en doubles.
function doubles(resultats, opts = {}) {
  const a = atelier(opts)
  const verifications = []
  const supprimees = []
  const deps = {
    executer: a.executer,
    lireFichier: a.lireFichier,
    verifier: async (ctx, projet, tache, sha) => {
      verifications.push({ projet, tache, sha })
      const r = resultats[verifications.length - 1]
      return typeof r === "function" ? r(ctx) : r
    },
    supprimerBranche: opts.supprimerBranche ?? (async (_config, depot, branche) => supprimees.push(`${depot} ${branche}`)),
    attendre: async () => {},
    maintenant: () => new Date("2026-11-20T14:30:05Z"),
  }
  return { deps, verifications, supprimees, scripts: a.scripts }
}

const ATTRAPE = { ok: false, raisons: ["critère non validé : Le compteur des messages non lus est juste (observé : 4 au lieu de 3)"] }
const RATE = { ok: true, raisons: [] }
const PANNE = { ok: false, infra: true, raisons: ["clone impossible : coupure"] }

test("le nombre de bugs : 4 par défaut, de 1 à 8", () => {
  assert.equal(nombreDeBugs(undefined), 4)
  assert.equal(nombreDeBugs("2"), 2)
  assert.equal(nombreDeBugs(8), 8)
  for (const v of [0, 9, -1, 2.5, "trois"]) assert.equal(nombreDeBugs(v), null, String(v))
})

test("projet refusé : pas livré, sans dépôt, sans tâche fusionnée avec des critères", () => {
  assert.match(choisirTache(contexte({ statut: "fabrication" }).db, 1).message, /« fabrication » : l'audit se fait sur un produit livré ou en production/)
  assert.match(choisirTache(contexte({ depot: null }).db, 1).message, /n'a pas de dépôt GitHub/)
  assert.match(choisirTache(contexte().db, 7).message, /Projet n°7 introuvable/)
  const { db } = contexte()
  db.prepare("UPDATE taches SET statut = 'abandonnee' WHERE cle IN ('T1', 'T2')").run()
  assert.match(choisirTache(db, 1).message, /aucune tâche fusionnée avec des critères/)
})

test("la tâche : la dernière fusionnée qui a des critères, ou celle qu'on nomme", () => {
  const { db } = contexte()
  assert.equal(choisirTache(db, 1).tache.cle, "T2", "T4 est fusionnée mais sans critère")
  assert.equal(choisirTache(db, 1, "t1").tache.cle, "T1")
  assert.match(choisirTache(db, 1, "T3").message, /T3 n'est pas fusionnée \(prete\)/)
  assert.match(choisirTache(db, 1, "T4").message, /T4 n'a pas de critères/)
  assert.match(choisirTache(db, 1, "T9").message, /T9 n'existe pas/)
})

test("le contrôle par le code : tests, .usine/ et fichiers protégés écartent le bug", () => {
  assert.deepEqual(controlerBug({ fichiers: ["server/messages.js"] }), [])
  assert.deepEqual(controlerBug({ fichiers: [] }), ["aucun fichier modifié"])
  for (const f of ["test/messages.test.js", "tests/unit/a.py", "client/src/__tests__/b.js", "server/compteur.spec.ts", "lib/x.test.mjs"]) {
    assert.match(controlerBug({ fichiers: ["server/messages.js", f] }).join(), /fichier\(s\) de test modifié\(s\)/, f)
  }
  assert.match(controlerBug({ fichiers: [".usine/e2e/T2-1.cjs"], protegesTouches: [".usine/e2e/T2-1.cjs"] }).join("\n"), /^fichier\(s\) de \.usine\/ modifié\(s\) : \.usine\/e2e\/T2-1\.cjs$/)
  assert.deepEqual(controlerBug({ fichiers: ["server/email.js"], protegesTouches: ["server/email.js"] }), ["fichier(s) protégé(s) modifié(s) : server/email.js"])
  // Un fichier qui contient « test » dans son nom n'est pas un test.
  assert.deepEqual(controlerBug({ fichiers: ["server/attestation.js", "server/latest.js"] }), [])
})

test("un bug attrapé, un raté, un non jugé, un non planté : le score, le journal, le réglage et l'annonce", async () => {
  const { ctx, db, messages } = contexte()
  const d = doubles([ATTRAPE, RATE, PANNE], { fichiers: (i) => (i === 4 ? ["server/erreurs.js", "test/erreurs.test.js"] : ["server/messages.js"]), description: (i) => `bug numéro ${i}` })
  const r = await auditer(ctx, 1, {}, d.deps)
  assert.equal(r.ok, true)
  assert.deepEqual(r.score, { attrapes: 1, rates: 1, non_juges: 1, non_plantes: 1, total: 4 })
  assert.deepEqual(r.bugs.map((b) => [b.sorte, b.issue, b.sha]), [["compteur", "attrape", "sha1"], ["sauvegarde", "rate", "sha2"], ["email", "non_juge", "sha3"], ["erreur", "non_plante", null]])
  assert.deepEqual(r.bugs.map((b) => b.description), ["bug numéro 1", "bug numéro 2", "bug numéro 3", "bug numéro 4"])
  assert.match(r.bugs[0].raisons[0], /4 au lieu de 3/, "les raisons du refus sont gardées")
  assert.match(r.bugs[3].raisons[0], /fichier\(s\) de test modifié\(s\) : test\/erreurs\.test\.js/)
  // Le non planté n'est jamais poussé ; les trois autres branches sont supprimées.
  assert.deepEqual(d.scripts.filter((s) => s.etape === "envoi").map((s) => s.bug), [1, 2, 3])
  assert.deepEqual(d.supprimees, [1, 2, 3].map((i) => `exemple/vigie-copro usine/audit/20261120-143005-${i}`))
  // La vraie vérification reçoit la tâche livrée, sans son id ni ses anciens refus, et le sha poussé.
  assert.equal(d.verifications.length, 3)
  for (const [i, v] of d.verifications.entries()) {
    assert.equal(v.sha, `sha${i + 1}`)
    assert.deepEqual([v.tache.cle, v.tache.id, v.tache.retours, JSON.parse(v.tache.criteres).length], ["T2", null, null, 2])
    assert.equal(v.projet.id, 1)
  }
  // Le journal, le réglage, l'annonce.
  const journal = db.prepare("SELECT message FROM journal WHERE type = 'audit' ORDER BY id").all().map((l) => l.message)
  assert.match(journal.at(-1), /^Audit du vérificateur sur Vigie Copro : 1 bug attrapé sur 2 \(1 non jugé, 1 non planté\)\. Critères de T2 · Les messages\./)
  assert.match(journal.at(-1), /2\. une sauvegarde qui ne se fait pas : RATÉ\. bug numéro 2/)
  const garde = JSON.parse(lireReglage(db, "audit_1"))
  assert.deepEqual([garde.tache, garde.score.total, garde.bugs.length], ["T2", 4, 4])
  assert.match(messages.at(-1), /Ratés : le vérificateur a validé ces bugs\.\n• une sauvegarde qui ne se fait pas : bug numéro 2/)
  assert.match(messages.at(-1), /Hors score :\n• un email noté « envoyé » mais jamais parti : non jugé \(clone impossible/)
  // Le planteur est compté dans les coûts du projet, pas dans ceux de la tâche livrée.
  const couts = db.prepare("SELECT projet_id, tache_id, role FROM consommations").all()
  assert.equal(couts.length, 4)
  assert.ok(couts.every((c) => c.projet_id === 1 && c.tache_id === null && c.role === "audit"))
})

test("le message : « 3 bugs attrapés sur 4 », avec la liste des ratés", () => {
  const bugs = [
    { sorte: "compteur", issue: "attrape", description: "a", raisons: ["x"] },
    { sorte: "sauvegarde", issue: "attrape", description: "b", raisons: ["x"] },
    { sorte: "email", issue: "rate", description: "L'email de bienvenue est noté envoyé sans partir.", raisons: [] },
    { sorte: "erreur", issue: "attrape", description: "d", raisons: ["x"] },
  ]
  const r = resumerAudit({ nom: "Vigie Copro" }, { cle: "T2", titre: "Les messages" }, bugs)
  assert.deepEqual(r.score, { attrapes: 3, rates: 1, non_juges: 0, non_plantes: 0, total: 4 })
  assert.equal(r.titre, "Audit du vérificateur sur Vigie Copro : 3 bugs attrapés sur 4")
  assert.match(r.annonce, /Ratés : le vérificateur a validé ces bugs\.\n• un email noté « envoyé » mais jamais parti : L'email de bienvenue est noté envoyé sans partir\./)
  assert.doesNotMatch(r.annonce, /Hors score/)
  const aucun = resumerAudit({ nom: "Vigie Copro" }, { cle: "T2", titre: "t" }, [{ sorte: "compteur", issue: "non_plante", description: "", raisons: ["aucun fichier modifié"] }])
  assert.equal(aucun.titre, "Audit du vérificateur sur Vigie Copro : aucun bug jugé (1 non planté)")
  assert.match(resumerAudit({ nom: "V" }, { cle: "T2", titre: "t" }, bugs.filter((b) => b.issue === "attrape")).annonce, /Aucun bug raté\./)
})

test("la branche est supprimée même quand la vérification lève une erreur, et l'audit continue", async () => {
  const { ctx } = contexte()
  const d = doubles([() => {
    throw new Error("le vérificateur a perdu le travail (502)")
  }, ATTRAPE], {})
  const r = await auditer(ctx, 1, { bugs: 2 }, d.deps)
  assert.deepEqual(r.bugs.map((b) => b.issue), ["non_juge", "attrape"])
  assert.match(r.bugs[0].raisons[0], /vérification interrompue : le vérificateur a perdu le travail \(502\)/)
  assert.deepEqual(d.supprimees, [1, 2].map((i) => `exemple/vigie-copro usine/audit/20261120-143005-${i}`))
})

test("la suppression de la branche : un second essai, puis le prochain audit s'en charge", async () => {
  const { ctx, db } = contexte()
  const essais = []
  const refus = [true, false, true, true] // puis tout passe
  const supprimerBranche = async (_config, _depot, branche) => {
    essais.push(branche)
    if (refus.shift()) throw new Error("GitHub 403")
  }
  // Bug 1 : refusé puis accepté au second essai. Bug 2 : refusé deux fois, gardé pour plus tard.
  const d = doubles([ATTRAPE, ATTRAPE], { supprimerBranche })
  await auditer(ctx, 1, { bugs: 2 }, d.deps)
  assert.deepEqual(essais, ["-1", "-1", "-2", "-2"].map((s) => `usine/audit/20261120-143005${s}`))
  assert.deepEqual(JSON.parse(lireReglage(db, "audit_branches")), [{ depot: "exemple/vigie-copro", branche: "usine/audit/20261120-143005-2" }])
  assert.match(db.prepare("SELECT message FROM journal WHERE type = 'erreur'").get().message, /usine\/audit\/20261120-143005-2 n'a pas pu être supprimée/)
  // L'audit suivant la supprime d'abord. Une branche qui n'est pas d'un audit n'est jamais touchée.
  ecrireReglage(db, "audit_branches", JSON.stringify([...JSON.parse(lireReglage(db, "audit_branches")), { depot: "exemple/vigie-copro", branche: "main" }]))
  essais.length = 0
  const e = doubles([ATTRAPE], { supprimerBranche })
  await auditer(ctx, 1, { bugs: 1 }, e.deps)
  assert.deepEqual(essais, ["usine/audit/20261120-143005-2", "usine/audit/20261120-143005-1"])
  assert.deepEqual(JSON.parse(lireReglage(db, "audit_branches")), [])
})

test("refusé quand l'atelier est réservé, quand l'usine est arrêtée, ou quand une tâche est en cours", async () => {
  const { ctx, db } = contexte()
  const d = doubles([ATTRAPE])
  let liberer
  const tache = avecAtelierReserve(() => new Promise((r) => (liberer = r)))
  const r = await auditer(ctx, 1, {}, d.deps)
  assert.deepEqual(r, { ok: false, message: "L'usine fabrique en ce moment : réessaie quand la tâche en cours sera finie." })
  liberer()
  await tache
  assert.equal(d.scripts.length, 0, "rien n'a été lancé dans l'atelier")
  // L'usine arrêtée (fichier STOP).
  writeFileSync(join(ctx.config.dataDir, "STOP"), "")
  assert.match((await auditer(ctx, 1, {}, d.deps)).message, /L'usine est arrêtée/)
  ctx.config.dataDir = mkdtempSync(join(tmpdir(), "audit-"))
  // Une tâche restée en vérification.
  db.prepare("UPDATE taches SET statut = 'verification' WHERE cle = 'T3'").run()
  assert.match((await auditer(ctx, 1, {}, d.deps)).message, /Une tâche est en cours \(T3 de Vigie Copro\)/)
  assert.equal(d.scripts.length, 0)
  // L'atelier est rendu après chaque refus : une fabrication peut repartir.
  assert.deepEqual(await avecAtelierReserve(async () => "libre"), "libre")
})

test("pendant l'audit, l'atelier est réservé et un second audit est refusé", async () => {
  const { ctx } = contexte()
  let finir
  const d = doubles([() => new Promise((r) => (finir = () => r(ATTRAPE)))])
  const premier = auditer(ctx, 1, { bugs: 1 }, d.deps)
  while (!finir) await new Promise((r) => setTimeout(r, 2))
  assert.match((await auditer(ctx, 1, {}, d.deps)).message, /Un audit du vérificateur tourne déjà \(Vigie Copro, critères de T2\)/)
  assert.equal((await avecAtelierReserve(async () => "fabrication")).ok, false, "aucune tâche ne part pendant l'audit")
  finir()
  assert.equal((await premier).score.attrapes, 1)
})

test("la route : un refus revient tout de suite ; sinon « Audit lancé », et le résultat arrive ensuite", async () => {
  const { ctx, db, messages } = contexte()
  assert.match((await lancerAudit(ctx, 1, { bugs: 12 })).message, /Le nombre de bugs va de 1 à 8/)
  assert.match((await lancerAudit(ctx, Number(undefined))).message, /Donne le numéro du projet/)
  let finir
  const d = doubles([() => new Promise((r) => (finir = () => r(RATE)))])
  const r = await lancerAudit(ctx, 1, { bugs: 1, tacheCle: "T1" }, d.deps)
  assert.equal(r.ok, true)
  assert.match(r.message, /^Audit lancé sur Vigie Copro \(critères de T1\) : 1 bug\(s\) à planter/)
  assert.equal(lireReglage(db, "audit_1"), null, "l'audit tourne encore")
  while (!finir) await new Promise((r) => setTimeout(r, 2))
  finir()
  while (lireReglage(db, "audit_1") === null) await new Promise((r) => setTimeout(r, 2))
  assert.equal(JSON.parse(lireReglage(db, "audit_1")).score.rates, 1)
  assert.match(messages.at(-1), /0 bug attrapé sur 1/)
  // Une erreur en tâche de fond est notée au journal, et dite.
  const e = doubles([])
  e.deps.verifier = async () => ATTRAPE
  e.deps.maintenant = () => {
    throw new Error("horloge en panne")
  }
  assert.equal((await lancerAudit(ctx, 1, { bugs: 1 }, e.deps)).ok, true)
  while (!db.prepare("SELECT 1 FROM journal WHERE type = 'erreur'").get()) await new Promise((r) => setTimeout(r, 2))
  assert.match(db.prepare("SELECT message FROM journal WHERE type = 'erreur'").get().message, /Audit du vérificateur interrompu : Error: horloge en panne/)
  while (!messages.at(-1).startsWith(":x:")) await new Promise((r) => setTimeout(r, 2))
})

test("Claude à sa limite : le bug n'est pas planté et l'audit s'arrête là", async () => {
  const { ctx } = contexte()
  const d = doubles([ATTRAPE], { epuise: (i) => i === 2 })
  const r = await auditer(ctx, 1, { bugs: 4 }, d.deps)
  assert.deepEqual(r.bugs.map((b) => b.issue), ["attrape", "non_plante", "non_plante", "non_plante"])
  assert.match(r.bugs[1].raisons[0], /Claude est à sa limite d'usage/)
  assert.match(r.bugs[3].raisons[0], /audit interrompu : Claude est à sa limite d'usage/)
  assert.equal(d.scripts.filter((s) => s.etape === "preparation").length, 2, "aucun clone après la limite")
})

test("le planteur qui ne trouve rien à casser : non planté, rien n'est poussé", async () => {
  const { ctx } = contexte()
  const d = doubles([], { description: () => "impossible : ce produit n'envoie aucun email" })
  const r = await auditer(ctx, 1, { bugs: 1 }, d.deps)
  assert.equal(r.bugs[0].issue, "non_plante")
  assert.match(r.bugs[0].raisons[0], /n'a pas trouvé où planter ce bug \(impossible : ce produit n'envoie aucun email\)/)
  assert.deepEqual([d.scripts.some((s) => s.etape === "envoi"), d.supprimees.length], [false, 0])
})

test("l'audit ne change pas la liste des tests sautés du cliquet", async () => {
  const { ctx, db } = contexte()
  ecrireReglage(db, "cliquet_sautes_1", JSON.stringify({ "T1-1.cjs": [1] }))
  const d = doubles([(c) => (ecrireReglage(c.db, "cliquet_sautes_1", JSON.stringify({ "T1-1.cjs": [1, null], "T2-1.cjs": [null] })), ATTRAPE)])
  await auditer(ctx, 1, { bugs: 1 }, d.deps)
  assert.equal(lireReglage(db, "cliquet_sautes_1"), JSON.stringify({ "T1-1.cjs": [1] }))
})

test("l'audit ne change pas les planchers des budgets de l'interface, même quand un bug est raté", async () => {
  const { ctx, db } = contexte()
  const avant = JSON.stringify({ pages: { "/": { console: 2, a11y: 1, webkit: 0 } } })
  ecrireReglage(db, "budgets_1", avant)
  // Un bug raté : la vérification valide, et elle abaisserait le plancher de la page avec la mesure du mutant.
  const d = doubles([(c) => (ecrireReglage(c.db, "budgets_1", JSON.stringify({ pages: { "/": { console: 0, a11y: 0, webkit: 0 } } })), { ok: true, raisons: [] })])
  await auditer(ctx, 1, { bugs: 1 }, d.deps)
  assert.equal(lireReglage(db, "budgets_1"), avant)
  // Un projet sans plancher n'en reçoit pas un du mutant.
  db.prepare("DELETE FROM reglages WHERE cle = ?").run("budgets_1")
  const d2 = doubles([(c) => (ecrireReglage(c.db, "budgets_1", JSON.stringify({ pages: { "/": { console: 5, a11y: 5, webkit: 5 } } })), { ok: true, raisons: [] })])
  await auditer(ctx, 1, { bugs: 1 }, d2.deps)
  assert.equal(lireReglage(db, "budgets_1"), null)
})

test("une mise à jour de l'usine attend la fin d'un audit en cours", () => {
  const cycle = readFileSync(new URL("../src/cycle.mjs", import.meta.url), "utf8")
  assert.match(cycle, /import \{ auditEnCours \} from "\.\/audit\.mjs"/)
  assert.match(cycle, /statut IN \('en_cours', 'verification'\)"\)\.get\(\) \|\| auditEnCours\(\)\)\)/)
})

test("le jeton GitHub ne sert qu'au clone et au push ; ni la consigne ni le commit ne disent rien de trop", async () => {
  const { ctx } = contexte()
  const d = doubles([ATTRAPE])
  await auditer(ctx, 1, { bugs: 1 }, d.deps)
  assert.deepEqual(d.scripts.map((s) => s.etape), ["preparation", "planteur", "controle", "envoi"])
  for (const s of d.scripts) {
    assert.equal(Boolean(s.env.JETON), ["preparation", "envoi"].includes(s.etape), s.etape)
    assert.ok(!s.script.includes(JETON_GITHUB), s.etape)
    if (s.env.JETON) assert.match(s.script, /sed "s\/\$JETON\/\*\*\*\/g"/)
  }
  assert.doesNotMatch(d.scripts[1].script, /JETON/)
  // Le commit ressemble à celui d'une tâche : il ne dit pas ce qui est cassé.
  assert.match(d.scripts[3].script, /git commit -q -m 'T2 · Les messages'/)
  assert.match(d.scripts[3].script, /HEAD:refs\/heads\/'usine\/audit\/20261120-143005-1'/)
  const consigne = consignePlanteur(ctx.config, { nom: "Vigie Copro" }, { cle: "T2", titre: "Les messages", description: "d" }, ["Le compteur des messages non lus est juste"], SORTES[0])
  assert.match(consigne, /planter UN bug, un compteur décalé d'un/)
  assert.match(consigne, /1\. Le compteur des messages non lus est juste/)
  assert.match(consigne, /fichiers protégés : Dockerfile, server\/email\.js, \.usine\/\*\*, MISSION\.md, ICP\.md/)
  assert.match(consigne, /\/tmp\/sorties\/audit\/bug\.txt, jamais dans le dépôt/)
  assert.doesNotMatch(consigne, new RegExp(JETON_GITHUB))
})

test("la commande audit et la route POST /audit sont branchées", () => {
  const source = (f) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")
  assert.match(source("index.mjs"), /"POST \/audit": \(c, id\) => lancerAudit\(ctx, id, \{ bugs: c\.bugs, tacheCle: c\.tache \?\? null \}\)/)
  assert.match(source("cli.mjs"), /^ {2}audit <n°> \[bugs\] \[tâche\]/m)
  assert.match(source("cli.mjs"), /audit: \(\) => /)
})
