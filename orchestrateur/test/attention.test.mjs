// La file d'attention (attention.mjs) : Décider, Débloquer, Réparer, sur une base d'essai ; le même
// total sur l'accueil (GET /api/resume) et sur Visibilité (GET /api/visibilite), derrière un faux
// portier ; et la décision prise sur place, qui ne part qu'au bout de 5 s (console.js).
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dossier = mkdtempSync(join(tmpdir(), "attention-test-"))
let portier, serveur, base, ctx, mod, retenirEtatUsine
const ids = {}

// Les raisons d'une décision, comme console.mjs les écrit.
const RAISONS = { criteres: "les critères ne passent pas malgré les corrections", budget: "la durée maximale du projet est atteinte" }
const OPTIONS = [{ cle: "A", libelle: "Réessayer", detail: "relancer la tâche" }, { cle: "B", libelle: "Accepter en l'état", detail: "fusionner" }, { cle: "C", libelle: "Abandonner", detail: "abandonner la tâche" }]
const OPTIONS_BUDGET = [{ cle: "A", libelle: "Continuer", detail: "prolonger la durée du projet d'autant" }, { cle: "C", libelle: "Arrêter", detail: "arrêter la fabrication" }]

before(async () => {
  portier = createServer((req, res) => {
    const s = /s=(\w+)/.exec(req.headers.cookie ?? "")?.[1]
    res.writeHead(req.url.startsWith("/_portier/qui") && !s ? 401 : 200, { "content-type": "application/json" })
    if (req.url.startsWith("/_portier/qui")) return res.end(s ? JSON.stringify({ email: `${s}@exemple.test`, role: s === "admin" ? "admin" : "membre", autorise: true }) : "{}")
    res.end("{}")
  }).listen(0)
  await new Promise((r) => portier.once("listening", r))
  process.env.PORTIER_URL = `http://127.0.0.1:${portier.address().port}`
  process.env.PORTIER_API_TOKEN = "j".repeat(40)
  // L'adresse IP du serveur pour l'enregistrement à créer : une adresse de documentation (TEST-NET-3).
  process.env.IP_PUBLIQUE = "203.0.113.10"

  const { ouvrirDb } = await import("../src/db.mjs")
  const { ouvrirCouts } = await import("../src/couts.mjs")
  const { ouvrirCycle } = await import("../src/cycle.mjs")
  const { ouvrirDomaines } = await import("../src/domaines.mjs")
  ;({ retenirEtatUsine } = await import("../src/sante.mjs"))
  mod = await import("../src/attention.mjs")
  const db = ouvrirDb(join(dossier, "usine.db"))
  ouvrirCouts(db)
  ouvrirCycle(db)
  ouvrirDomaines(db)
  const config = {
    domaine: { base: "exemple.test", https: true }, dataDir: dossier, etatDir: dossier,
    atelier: { url: "http://127.0.0.1:1" }, verificateur: { url: "http://127.0.0.1:1" },
    secrets: { github: "jeton-de-test", worker: "secret-worker-essai" }, github: { proprietaire: "essai", depot_etat: "etat" },
    modeles: {}, slack: { canal: "", admins: [] }, perimetre_protege: [], couts: { devise: "USD" }, budget: {},
  }
  const silence = async () => {}
  ctx = { config, db, notifier: { alerte: silence, progres: silence, escalade: silence, escaladeResolue: silence, etape: silence }, livraison: { apresFusion: silence, finaliserSiFini: silence } }

  const plan = JSON.stringify({ resume: "r", lots: [{ nom: "Socle", objectif: "o", taches: [{ cle: "T1" }, { cle: "T2" }] }], questions: [{ question: "Pour qui ?", options: ["Les gérants"], recommande: 0 }] })
  const projet = (statut, nom, slug = null, extra = {}) => Number(db.prepare("INSERT INTO projets (prompt, statut, nom, slug, plan, debut_fabrication) VALUES ('p', ?, ?, ?, ?, ?)").run(statut, nom, slug, plan, extra.debut ?? null).lastInsertRowid)
  const tache = (projetId, cle, statut, depend = []) => Number(db.prepare("INSERT INTO taches (projet_id, cle, lot, titre, description, criteres, statut, depend_de) VALUES (?, ?, 1, ?, 'd', '[]', ?, ?)").run(projetId, cle, `Fonction ${cle}`, statut, JSON.stringify(depend)).lastInsertRowid)

  // Décider : une décision sur une fonction (deux fonctions attendent derrière), une décision de budget, un plan, des questions, une livraison, une fiche.
  ids.prospecta = projet("fabrication", "Prospecta", "prospecta", { debut: "2026-11-01T08:00:00Z" })
  tache(ids.prospecta, "T1", "fusionnee")
  ids.t2 = tache(ids.prospecta, "T2", "bloquee", ["T1"])
  tache(ids.prospecta, "T3", "attente", ["T2"])
  tache(ids.prospecta, "T4", "attente", ["T3"])
  tache(ids.prospecta, "T5", "prete", ["T1"]) // ne dépend pas de T2
  tache(ids.prospecta, "T6", "abandonnee", ["T2"]) // finie : n'attend plus
  ids.esc = Number(db.prepare("INSERT INTO escalades (projet_id, tache_id, raison, options) VALUES (?, ?, 'criteres', ?)").run(ids.prospecta, ids.t2, JSON.stringify(OPTIONS)).lastInsertRowid)
  ids.relais = projet("bloque", "Relais", "relais")
  ids.escBudget = Number(db.prepare("INSERT INTO escalades (projet_id, raison, options) VALUES (?, 'budget', ?)").run(ids.relais, JSON.stringify(OPTIONS_BUDGET)).lastInsertRowid)
  ids.atlas = projet("plan_a_valider", "Atlas")
  ids.boussole = projet("questions", "Boussole")
  ids.comptoir = projet("livre", "Comptoir", "comptoir")
  ids.persona = Number(db.prepare("INSERT INTO personas (nom, brief, statut) VALUES ('Gérantes de salon', 'b', 'a_valider')").run().lastInsertRowid)

  // Débloquer : deux projets en échec (l'un déjà relancé), la pause, le coffre, une fonction orpheline, une adresse web.
  ids.echoppe = projet("echec", "Échoppe")
  db.prepare("INSERT INTO decisions (projet_id, question, reponse, par) VALUES (?, 'Plan de fabrication', 'validé', 'a@exemple.test')").run(ids.echoppe)
  db.prepare("INSERT INTO journal (projet_id, type, message) VALUES (?, 'erreur', ?)").run(ids.echoppe, "Error: getaddrinfo EAI_AGAIN api.github.com\n    at GetAddrInfoReqWrap.onlookupall (node:dns:120:26)")
  ids.relance = projet("echec", "Relancé")
  db.prepare("INSERT INTO journal (projet_id, type, message) VALUES (?, 'erreur', 'L''analyste n''a pas rendu de plan lisible')").run(ids.relance)
  db.prepare("INSERT INTO journal (projet_id, type, message) VALUES (?, 'relance', 'Analyse relancée par a@exemple.test')").run(ids.relance)
  db.prepare("INSERT INTO reglages (cle, valeur) VALUES ('pause_limite', ?), ('facturation_claude-code_cle', ?), ('coffre_ANTHROPIC_API_KEY', ?)").run(
    new Date(Date.now() + 2 * 3600_000).toISOString(),
    JSON.stringify({ message: "credit balance is too low", jusqua: new Date(Date.now() + 3600_000).toISOString() }),
    JSON.stringify({ v: 2, iv: "aXY=", tag: "dGFn", donnees: "ZG9ubmVlcw==", fin: "wxyz" }), // scellé par AXMARIL, sans clé maîtresse : verrouillé
  )
  ids.orphelin = projet("fabrication", "Orphelin", "orphelin")
  ids.t1Orphelin = tache(ids.orphelin, "T1", "bloquee")
  tache(ids.orphelin, "T2", "attente", ["T1"])
  ids.vitrine = projet("en_production", "Vitrine", "vitrine")
  db.prepare("INSERT INTO domaines (projet_id, hote, statut, message) VALUES (?, 'app.client.test', 'attente_dns', 'aucun enregistrement A pour l''instant'), (?, 'www.client.test', 'actif', NULL)").run(ids.vitrine, ids.vitrine)

  // Réparer : l'atelier en panne (dernier bilan de la surveillance), Vitrine en panne d'après la sonde.
  // Le résumé des applications et la ligne de Vitrine du bilan n'y entrent pas (la sonde la donne déjà).
  retenirEtatUsine([
    { nom: "atelier", etat: "panne", detail: "ne répond pas" },
    { nom: "disque", etat: "alerte", detail: "85 % utilisés" },
    { nom: "GitHub", etat: "ok", detail: "joignable" },
    { nom: "applications", etat: "panne", detail: "1 en panne", resume: true },
    { nom: "Vitrine · production", etat: "panne", detail: "ne répond pas", produit: "vitrine", cle: "production/vitrine" },
  ])
  const maintenant = new Date().toISOString()
  writeFileSync(join(dossier, "sante.json"), JSON.stringify({
    le: maintenant, disque: { total_go: 50, utilise_go: 10, libre_go: 40, pct: 20 }, memoire: { total_mo: 4000, dispo_mo: 3000, swap_utilise_mo: 0 }, charge: [0.2, 0.2, 0.2],
    applications: { le: maintenant, produits: {
      "production/vitrine": { etat: "panne", raison: "ne répond pas à /api/health", version: "abcdef0123" },
      "apercu/prospecta": { etat: "alerte", raison: "a redémarré 1 fois en 30 min", version: "1234567abc" },
    } },
  }))

  const { traiter } = await import("../src/console.mjs")
  serveur = createServer((req, res) => traiter(ctx, req, res)).listen(0)
  await new Promise((r) => serveur.once("listening", r))
  base = `http://127.0.0.1:${serveur.address().port}`
})
after(() => {
  portier.close()
  serveur.close()
})

const lire = async (chemin) => (await fetch(`${base}${chemin}`, { headers: { cookie: "s=admin" } })).json()
const parCle = (liste) => Object.fromEntries(liste.map((x) => [x.cle, x]))

test("les fonctions qui attendent derrière une fonction arrêtée, dépendances indirectes comprises", () => {
  const t = [
    { cle: "T1", statut: "bloquee", depend_de: "[]" },
    { cle: "T2", statut: "attente", depend_de: '["T1"]' },
    { cle: "T3", statut: "attente", depend_de: '["T2"]' },
    { cle: "T4", statut: "fusionnee", depend_de: '["T1"]' },
    { cle: "T5", statut: "prete", depend_de: '["T9"]' },
    { cle: "T6", statut: "attente", depend_de: "pas du json" },
  ]
  assert.equal(mod.fonctionsDerriere(t, "T1"), 2)
  assert.equal(mod.fonctionsDerriere(t, "T3"), 0)
})

test("Décider : chaque décision avec sa recommandation d'abord, les plans, les questions, la fiche, la livraison", () => {
  const l = parCle(mod.elementsAttente(ctx, { raisons: RAISONS }))
  const d = l[`decision:${ids.esc}`]
  assert.equal(d.groupe, "decider")
  assert.equal(d.titre, "Prospecta · décision attendue")
  assert.equal(d.detail, "T2 : les critères ne passent pas malgré les corrections · 2 fonctions attendent derrière")
  assert.equal(d.derriere, 2)
  // La décision se prend sur place : l'option recommandée (A) d'abord, avec sa conséquence ; une consigne possible.
  assert.deepEqual(d.decision.options.map((o) => [o.cle, o.recommande]), [["A", true], ["B", false], ["C", false]])
  assert.match(d.decision.options[0].consequence, /reprend « Fonction T2 » avec ta consigne/)
  assert.deepEqual([d.decision.id, d.decision.tache, d.decision.consigne], [ids.esc, "T2", true])
  // Le budget : pas de recommandation (c'est le choix de la personne), pas de consigne pour un agent.
  const b = l[`decision:${ids.escBudget}`]
  assert.equal(b.decision.consigne, false)
  assert.ok(b.decision.options.every((o) => !o.recommande))
  assert.equal(b.detail, "la durée maximale du projet est atteinte")
  // Pendant une réorientation, la décision attend le nouveau plan : pas de choix sur place.
  ctx.db.prepare("INSERT INTO reglages (cle, valeur) VALUES (?, '{}')").run(`reorientation_${ids.relais}`)
  try {
    assert.equal(parCle(mod.elementsAttente(ctx, { raisons: RAISONS }))[`decision:${ids.escBudget}`].decision, null)
  } finally {
    ctx.db.prepare("DELETE FROM reglages WHERE cle = ?").run(`reorientation_${ids.relais}`)
  }
  assert.equal(l[`plan:${ids.atlas}`].groupe, "decider")
  assert.equal(l[`questions:${ids.boussole}`].detail, "Pour qui ?")
  assert.equal(l[`livre:${ids.comptoir}`].titre, "Comptoir · prêt à mettre en ligne")
  assert.deepEqual([l[`persona:${ids.persona}`].groupe, l[`persona:${ids.persona}`].lien], ["decider", `#/personas/${ids.persona}`])
})

test("Débloquer : une seule action par cas, et une relance déjà envoyée n'est plus proposée", () => {
  const l = parCle(mod.elementsAttente(ctx, { raisons: RAISONS }))
  const e = l[`echec:${ids.echoppe}`]
  assert.equal(e.groupe, "debloquer")
  assert.equal(e.titre, "Échoppe · la création a échoué")
  assert.equal(e.detail, "Error: getaddrinfo EAI_AGAIN api.github.com", "la première ligne seulement, sans la pile d'appels")
  assert.match(e.refait, /plan déjà validé/)
  assert.deepEqual(e.action, { type: "relancer", libelle: "Relancer", projet: ids.echoppe })
  assert.equal(e.envoye, null)
  const r = l[`echec:${ids.relance}`]
  assert.equal(r.titre, "Relancé · en échec")
  assert.equal(r.envoye.texte, "Relance demandée", "relancé après la dernière erreur : signalé comme envoyé")
  const p = l.pause
  // Dans deux heures : aujourd'hui (« jusqu'à 18:40 »), ou demain le soir venu (« jusqu'au 12 nov. à 00:40 »).
  assert.match(p.titre, /^La fabrication est en pause jusqu'(?:à \d\d:\d\d|au \d{1,2} \S+ à \d\d:\d\d)$/)
  assert.match(p.detail, /faute de crédit/)
  assert.equal(p.action.lien, "#/reglages/integrations")
  const c = l.coffre
  assert.deepEqual(c.action.commandes, ["bash secrets.sh axmaril", "docker compose up -d orchestrateur"], "à faire sur le serveur, avec la commande exacte")
  const o = l[`tache:${ids.t1Orphelin}`]
  assert.equal(o.titre, "Orphelin · T1 est arrêtée sans décision ouverte")
  assert.equal(o.derriere, 1)
  // La fonction qui attend sa décision (T2 de Prospecta) n'est pas comptée deux fois.
  assert.equal(l[`tache:${ids.t2}`], undefined)
  const dns = l["dns:app.client.test"]
  assert.deepEqual(dns.enregistrement, { type: "A", nom: "app", hote: "app.client.test", valeur: "203.0.113.10" })
  assert.match(dns.detail, /aucun enregistrement A pour l'instant/)
  assert.equal(l["dns:www.client.test"], undefined, "une adresse déjà active n'attend rien")
})

test("Réparer : les pannes de l'usine elle-même, pas ses alertes ni les lignes des produits ; un bilan trop ancien ne compte plus", () => {
  const reparer = mod.elementsAttente(ctx, { raisons: RAISONS }).filter((x) => x.groupe === "reparer")
  assert.deepEqual(reparer.map((x) => [x.cle, x.service, x.lien]), [["usine:atelier", "atelier", "#/reglages/etat"]])
  const dansDixMinutes = Date.now() + 10 * 60_000
  assert.deepEqual(mod.elementsAttente(ctx, { raisons: RAISONS, maintenant: dansDixMinutes }).filter((x) => x.groupe === "reparer"), [])
})

test("le compte : Décider + Débloquer ; Réparer à part, jamais additionné", () => {
  const liste = [{ type: "decision" }, { type: "plan" }, { type: "echec" }, { type: "panne" }, { type: "usine" }, { type: "sonde" }]
  assert.deepEqual(mod.compterAttente(liste), { decider: 2, debloquer: 1, reparer: 3, total: 3 })
  // Le groupe d'abord, puis le type, puis l'ordre d'arrivée.
  assert.deepEqual(mod.ordonner([{ type: "panne" }, { type: "livre" }, { type: "echec" }, { type: "decision", n: 2 }, { type: "decision", n: 1 }]).map((x) => x.type + (x.n ?? "")), ["decision2", "decision1", "livre", "echec", "panne"])
})

test("le même total partout : l'accueil (GET /api/resume) et Visibilité (GET /api/visibilite)", async () => {
  const resume = await lire("/api/resume")
  const visibilite = await lire("/api/visibilite")
  const accueil = resume.a_traiter
  const page = visibilite.attend
  assert.deepEqual(accueil.map((x) => x.cle), page.map((x) => x.cle), "la même liste, dans le même ordre")
  assert.deepEqual(mod.compterAttente(accueil), mod.compterAttente(page))
  assert.deepEqual(mod.compterAttente(accueil), { decider: 6, debloquer: 6, reparer: 2, total: 12 })
  // Les projets en échec et les pannes de l'usine y sont, les produits en panne aussi ; un produit à surveiller non.
  const cles = accueil.map((x) => x.cle)
  for (const cle of [`echec:${ids.echoppe}`, `echec:${ids.relance}`, "usine:atelier", "produit:production/vitrine"]) assert.ok(cles.includes(cle), cle)
  assert.ok(!cles.includes("produit:apercu/prospecta"), "à surveiller : pas dans la file")
  // Les groupes se suivent : À décider, puis À débloquer, puis À réparer.
  const groupes = accueil.map((x) => x.groupe)
  assert.deepEqual([...new Set(groupes)], ["decider", "debloquer", "reparer"])
  assert.deepEqual(groupes, [...groupes].sort((a, b) => mod.GROUPES.indexOf(a) - mod.GROUPES.indexOf(b)))
  // Aucun secret ; rien n'est écrit par une lecture.
  const texte = JSON.stringify([resume, visibilite])
  for (const secret of Object.values(ctx.config.secrets)) assert.ok(!texte.includes(secret))
  assert.ok(!texte.includes("ZG9ubmVlcw"), "rien du coffre")
})

// --- La décision prise sur place, dans la console (console.js) -----------------------------------
const source = readFileSync(new URL("../console/console.js", import.meta.url), "utf8")
const extraire = (debut) => {
  const i = source.indexOf(debut)
  assert.ok(i >= 0, `${debut} introuvable dans console.js`)
  return source.slice(i, source.indexOf("\n}\n", i) + 2)
}
// decisionsDifferees telle qu'elle est dans console.js, avec une horloge d'essai.
const { DELAI_ANNULER, decisionsDifferees } = new Function(`${source.match(/^const DELAI_ANNULER = \d+$/m)[0]}\n${extraire("function decisionsDifferees(")}\nreturn { DELAI_ANNULER, decisionsDifferees }`)()
function horloge() {
  let t = 0
  const minuteries = []
  return {
    maintenant: () => t,
    minuterie: (f, ms) => {
      const m = { f, a: t + ms }
      minuteries.push(m)
      return m
    },
    arreter: (m) => { m.annulee = true },
    avancer(ms) {
      t += ms
      for (const m of minuteries) if (!m.fait && !m.annulee && m.a <= t) { m.fait = true; m.f() }
    },
  }
}

test("console : POST /api/escalades/:id n'est appelé qu'à un endroit, depuis la minuterie de la décision", () => {
  assert.equal(DELAI_ANNULER, 5000)
  assert.equal([...source.matchAll(/api\("POST", `escalades\//g)].length, 1, "un seul appel dans toute la console")
  assert.match(extraire("async function envoyerDecision("), /api\("POST", `escalades\/\$\{id\}`/)
  // envoyerDecision n'est donnée qu'à decisionsDifferees : aucun clic ne l'appelle directement (commentaires mis à part).
  const code = source.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")
  assert.deepEqual([...code.matchAll(/\benvoyerDecision\b/g)].length, 2)
  assert.match(source, /^const decisionsEnCours = decisionsDifferees\(envoyerDecision\)$/m)
  assert.doesNotMatch(source.slice(source.indexOf("  decider: (el) => {"), source.indexOf('  "annuler-decision"')), /api\(/, "le clic ne fait que lancer le délai")
})

test("console : rien ne part avant 5 s ; Annuler pendant le délai, et rien ne part du tout", () => {
  const h = horloge()
  const envois = []
  const d = decisionsDifferees((id, x) => envois.push([id, x.choix]), h)
  assert.equal(d.lancer(7, { choix: "A", texte: "", quoi: "Réessayer T2" }), true)
  assert.equal(d.lancer(7, { choix: "C", texte: "", quoi: "Abandonner T2" }), false, "un second clic pendant le délai ne lance rien")
  h.avancer(4999)
  assert.deepEqual(envois, [], "rien avant la fin du délai")
  assert.equal(d.lire(7).fin, 5000)
  h.avancer(1)
  assert.deepEqual(envois, [[7, "A"]])
  assert.equal(d.taille(), 0)
  d.lancer(8, { choix: "C", texte: "", quoi: "Abandonner T3" })
  h.avancer(4900)
  assert.equal(d.annuler(8).quoi, "Abandonner T3")
  h.avancer(60_000)
  assert.deepEqual(envois, [[7, "A"]], "annulée : jamais envoyée")
  assert.equal(d.annuler(8), null)
})

test("console : une décision annulée dans les 5 s n'atteint pas le serveur (aucune ligne dans decisions) ; sinon, elle part", async () => {
  const projetId = Number(ctx.db.prepare("INSERT INTO projets (prompt, statut, nom) VALUES ('p', 'bloque', 'Essai décision')").run().lastInsertRowid)
  const escalade = Number(ctx.db.prepare("INSERT INTO escalades (projet_id, raison, options) VALUES (?, 'budget', ?)").run(projetId, JSON.stringify(OPTIONS_BUDGET)).lastInsertRowid)
  const compter = () => ctx.db.prepare("SELECT COUNT(*) AS n FROM decisions WHERE projet_id = ?").get(projetId).n
  const envoyes = []
  // L'envoi réel de la console : POST /api/escalades/:id, avec la session et l'origine.
  const envoyer = (id, x) => envoyes.push(fetch(`${base}/api/escalades/${id}`, { method: "POST", headers: { cookie: "s=admin", "content-type": "application/json", origin: base }, body: JSON.stringify({ choix: x.choix, texte: x.texte }) }))
  const h = horloge()
  const d = decisionsDifferees(envoyer, h)
  d.lancer(escalade, { choix: "A", texte: "", quoi: "Continuer" })
  h.avancer(3000)
  d.annuler(escalade)
  h.avancer(10_000)
  assert.equal(envoyes.length, 0)
  assert.equal(compter(), 0, "aucune ligne dans decisions")
  assert.equal(ctx.db.prepare("SELECT statut FROM escalades WHERE id = ?").get(escalade).statut, "ouverte")
  d.lancer(escalade, { choix: "A", texte: "", quoi: "Continuer" })
  h.avancer(4999)
  assert.equal(envoyes.length, 0)
  h.avancer(1)
  assert.equal(envoyes.length, 1)
  const r = await (await envoyes[0]).json()
  assert.equal(r.ok, true)
  assert.equal(compter(), 1)
  assert.equal(ctx.db.prepare("SELECT statut FROM escalades WHERE id = ?").get(escalade).statut, "resolue")
})
