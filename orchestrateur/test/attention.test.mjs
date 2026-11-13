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
  // Arrêtée depuis une heure : au-delà du délai de grâce (une escalade en cours d'écriture n'est pas orpheline).
  db.prepare("UPDATE taches SET maj_le = datetime('now', '-1 hour') WHERE id = ?").run(ids.t1Orphelin)
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
  // Pendant une réorientation, la décision attend le nouveau plan : rien à décider, elle n'est pas dans la file.
  ctx.db.prepare("INSERT INTO reglages (cle, valeur) VALUES (?, '{}')").run(`reorientation_${ids.relais}`)
  try {
    assert.equal(parCle(mod.elementsAttente(ctx, { raisons: RAISONS }))[`decision:${ids.escBudget}`], undefined)
  } finally {
    ctx.db.prepare("DELETE FROM reglages WHERE cle = ?").run(`reorientation_${ids.relais}`)
  }
  assert.equal(l[`plan:${ids.atlas}`].groupe, "decider")
  assert.equal(l[`plan:${ids.atlas}`].detail, "1 lot, 2 tâches", "le singulier quand il n'y en a qu'un")
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
  // L'orchestrateur ne lit la clé maîtresse qu'à son démarrage : « up -d » ne le redémarrerait pas (il tourne déjà).
  assert.deepEqual(c.action.commandes, ["bash secrets.sh axmaril", "docker compose restart orchestrateur"], "à faire sur le serveur, avec la commande exacte")
  assert.match(readFileSync(new URL("../../secrets.sh", import.meta.url), "utf8"), /Pour l'appliquer[^\n]*: docker compose restart orchestrateur/, "secrets.sh dit la même chose")
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

test("Décider pendant une réorientation : un seul geste, le nouveau plan, qui dit combien de décisions il règle ; une réorientation ratée est à débloquer", () => {
  const { db } = ctx
  const cap = Number(db.prepare("INSERT INTO projets (prompt, statut, nom, plan) VALUES ('p', 'reorientation', 'Cap', ?)").run(JSON.stringify({ lots: [{ nom: "Socle", taches: [{ cle: "T1" }] }] })).lastInsertRowid)
  try {
    for (const cle of ["T1", "T2", "T3"]) {
      const t = Number(db.prepare("INSERT INTO taches (projet_id, cle, lot, titre, description, criteres, statut) VALUES (?, ?, 1, 't', 'd', '[]', 'bloquee')").run(cap, cle).lastInsertRowid)
      db.prepare("INSERT INTO escalades (projet_id, tache_id, raison, options) VALUES (?, ?, 'criteres', ?)").run(cap, t, JSON.stringify(OPTIONS))
    }
    db.prepare("INSERT INTO reglages (cle, valeur) VALUES (?, '{}')").run(`reorientation_${cap}`)
    db.prepare("INSERT INTO journal (projet_id, type, message) VALUES (?, 'erreur', 'Une vieille erreur, avant la réorientation')").run(cap)
    db.prepare("INSERT INTO journal (projet_id, type, message) VALUES (?, 'reorientation', 'Réorientation demandée par a@exemple.test : autre chose')").run(cap)
    const deCap = () => mod.elementsAttente(ctx, { raisons: RAISONS }).filter((x) => x.projet === cap)
    // Les trois décisions attendent le nouveau plan : rien à décider.
    let l = deCap()
    assert.deepEqual(l.filter((x) => x.type === "decision"), [], "pas dans la file")
    assert.equal(mod.compterAttente(l).decider, 0)
    // Personne ne refait la suite du plan (ni analyste au travail, ni tâche en cours) : à débloquer, et la
    // cause est la dernière erreur notée après la demande, pas une plus ancienne.
    assert.equal(parCle(l)[`reorientation:${cap}`].detail, "L'analyste n'a pas pu refaire la suite du plan.")
    db.prepare("INSERT INTO journal (projet_id, type, message) VALUES (?, 'erreur', ?)").run(cap, "Réorientation : le dépôt de référence exemple/ref est introuvable\n    at lireReference (file:///app/src/reorientation.mjs:75:9)")
    l = deCap()
    const r = parCle(l)[`reorientation:${cap}`]
    assert.equal(r.groupe, "debloquer")
    assert.equal(r.titre, "Cap · la réorientation a échoué")
    assert.equal(r.detail, "le dépôt de référence exemple/ref est introuvable")
    assert.deepEqual(r.action, { type: "relancer", libelle: "Relancer", projet: cap })
    assert.match(r.refait, /garder l'ancien plan/)
    assert.deepEqual(mod.compterAttente(l), { decider: 0, debloquer: 1, reparer: 0, total: 1 })
    // Le nouveau plan est prêt : un seul geste, qui règle les trois décisions.
    db.prepare("UPDATE projets SET statut = 'plan_a_valider' WHERE id = ?").run(cap)
    l = deCap()
    assert.deepEqual(l.map((x) => x.cle), [`plan:${cap}`])
    assert.equal(l[0].titre, "Cap · nouveau plan (réorientation) à valider")
    assert.equal(l[0].detail, "1 lot, 1 tâche · 3 décisions ouvertes seront réglées par ce plan")
    assert.deepEqual(mod.compterAttente(l), { decider: 1, debloquer: 0, reparer: 0, total: 1 })
  } finally {
    for (const table of ["escalades", "taches", "journal"]) db.prepare(`DELETE FROM ${table} WHERE projet_id = ?`).run(cap)
    db.prepare("DELETE FROM reglages WHERE cle = ?").run(`reorientation_${cap}`)
    db.prepare("DELETE FROM projets WHERE id = ?").run(cap)
  }
})

test("Débloquer : une fonction tout juste arrêtée, ou qui vient d'être décidée, n'est pas une orpheline", () => {
  const { db } = ctx
  const p = Number(db.prepare("INSERT INTO projets (prompt, statut, nom) VALUES ('p', 'fabrication', 'Lent')").run().lastInsertRowid)
  try {
    const t = Number(db.prepare("INSERT INTO taches (projet_id, cle, lot, titre, description, criteres, statut) VALUES (?, 'T1', 1, 't', 'd', '[]', 'bloquee')").run(p).lastInsertRowid)
    const orpheline = () => parCle(mod.elementsAttente(ctx, { raisons: RAISONS }))[`tache:${t}`]
    // L'escalade est en cours d'écriture (creerEscalade attend GitHub) : pas encore orpheline.
    assert.equal(orpheline(), undefined)
    db.prepare("UPDATE taches SET maj_le = datetime('now', '-10 minutes') WHERE id = ?").run(t)
    assert.equal(orpheline()?.titre, "Lent · T1 est arrêtée sans décision ouverte", "au-delà de 5 minutes, elle l'est")
    // Une décision B vient d'être prise : la fusion est en cours, la fonction est encore « bloquee ».
    db.prepare("INSERT INTO decisions (projet_id, tache_id, question, reponse, par) VALUES (?, ?, 'T1 : criteres', 'B · Accepter en l''état', 'a@exemple.test')").run(p, t)
    assert.equal(orpheline(), undefined)
    db.prepare("UPDATE decisions SET le = datetime('now', '-10 minutes') WHERE tache_id = ?").run(t)
    assert.ok(orpheline(), "la fusion n'a jamais fini : elle redevient orpheline")
  } finally {
    for (const table of ["decisions", "taches"]) db.prepare(`DELETE FROM ${table} WHERE projet_id = ?`).run(p)
    db.prepare("DELETE FROM projets WHERE id = ?").run(p)
  }
})

test("GET /api/resume ne relit pas tout le journal : la dernière erreur d'un projet passe par un index", () => {
  const plan = ctx.db.prepare("EXPLAIN QUERY PLAN SELECT id, message, le FROM journal WHERE projet_id = ? AND type = 'erreur' ORDER BY id DESC LIMIT 1").all(1)
  assert.ok(plan.some((l) => /journal_projet_type/.test(l.detail)), JSON.stringify(plan))
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

test("console : un seul clic compte ; pendant le délai, les options restent à leur place, désactivées", () => {
  const { GARDE_DECISION, clicIgnore } = new Function(`${source.match(/^const GARDE_DECISION = \d+$/m)[0]}\n${extraire("function clicIgnore(")}\nreturn { GARDE_DECISION, clicIgnore }`)()
  assert.equal(GARDE_DECISION, 400)
  assert.equal(clicIgnore("decider", { detail: 2, maintenant: 10_000, derniere: 0 }), true, "le second clic d'un double clic")
  assert.equal(clicIgnore("annuler-decision", { detail: 2, maintenant: 10_000, derniere: 0 }), true)
  assert.equal(clicIgnore("decider", { detail: 1, maintenant: 10_000, derniere: 9_800 }), true, "trop près d'un lancement ou d'une annulation")
  assert.equal(clicIgnore("decider", { detail: 1, maintenant: 10_000, derniere: 9_000 }), false, "un clic voulu, plus tard")
  assert.equal(clicIgnore("annuler-decision", { detail: 0, maintenant: 10_000, derniere: 0 }), false, "Entrée au clavier")
  assert.equal(clicIgnore("relancer-attente", { detail: 2, maintenant: 10_000, derniere: 9_900 }), false, "les autres actions ne changent pas")
  // La garde est branchée avant toute action, et chaque bascule la réarme.
  assert.match(source, /if \(clicIgnore\(el\.dataset\.action, \{ detail: e\.detail, derniere: derniereBascule \}\)\) return e\.preventDefault\(\)/)
  assert.equal([...source.matchAll(/derniereBascule = Date\.now\(\)/g)].length, 2, "au lancement et à l'annulation")
  // Le rendu, avec les outils de console.js : pendant le délai, chaque option reste, désactivée, et la choisie est marquée.
  const outils = ["BRUT", "brut", "echapper", "valeur"].map((n) => source.match(new RegExp(`^const ${n} = .*$`, "m"))[0]).join("\n")
  const r = new Function(`${outils}\n${extraire("function html(")}\n${extraire("function optionsDecision(")}\n${extraire("function ligneAttenteDecision(")}\nreturn { BRUT, optionsDecision, ligneAttenteDecision }`)()
  const options = [{ cle: "A", libelle: "Continuer", consequence: "prolonger", recommande: true }, { cle: "C", libelle: "Arrêter", consequence: "arrêter la fabrication" }]
  const libres = r.optionsDecision(12, options, { projet: 3 })[r.BRUT]
  assert.equal((libres.match(/<button/g) ?? []).length, 2)
  assert.doesNotMatch(libres, /disabled/)
  const attente = { choix: "C", quoi: "Arrêter", fin: Date.now() + 4500 }
  const figees = r.optionsDecision(12, options, { projet: 3, attente })[r.BRUT]
  assert.equal((figees.match(/<button/g) ?? []).length, 2, "les options restent à leur place")
  assert.equal((figees.match(/ disabled>/g) ?? []).length, 2, "toutes désactivées : un second clic tombe sur un bouton inerte")
  assert.match(figees, /data-choix="C"[^>]*disabled>\s*<strong>Arrêter <span class="badge orange">choisie<\/span>/)
  // La ligne d'attente dit quand la décision part ; elle vient après les options, jamais à leur place.
  const ligne = r.ligneAttenteDecision(12, attente)[r.BRUT]
  assert.match(ligne, /Arrêter : part dans <span data-compte="12">5<\/span> s/)
  assert.match(ligne, /data-action="annuler-decision" data-id="12" aria-label="Annuler : Arrêter">Annuler</)
  assert.match(extraire("function choixSurPlace("), /\$\{boutons\}[\s\S]*\$\{fin\}/)
})

test("console : la décision qui part est annoncée aux lecteurs d'écran, sans faire bouger la page", () => {
  const page = readFileSync(new URL("../console/index.html", import.meta.url), "utf8")
  assert.match(page, /<div id="annonce" class="cache" aria-live="polite"><\/div>/)
  const decider = source.slice(source.indexOf("  decider: (el) => {"), source.indexOf('  "annuler-decision"'))
  assert.match(decider, /annoncer\(`\$\{quoi\} : part dans 5 secondes\. Annuler pour l'arrêter\.`\)/)
  // Une consigne tapée qui ne part pas (B, C) : la ligne d'attente le dit.
  assert.match(decider, /ta consigne n'est pas transmise/)
  // Après l'envoi, le focus passe au texte qui remplace Annuler.
  assert.match(extraire("async function envoyerDecision("), /#envoye-decision-\$\{id\}`\)\?\.focus/)
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
