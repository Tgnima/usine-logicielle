// La page Visibilité : le calcul (base d'essai à une date fixe, sante.json et statut.json
// d'essai), puis l'API derrière un faux portier, comme console.test.mjs.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const racine = mkdtempSync(join(tmpdir(), "visibilite-test-"))
let mod, portier, serveur, base, fixe, api

// Le 11 novembre 2026 à 16 h 40, heure de Paris : la fenêtre va du 5 au 11 novembre.
const MAINTENANT = Date.parse("2026-11-11T15:40:00Z")

function configEssai(dossier) {
  return {
    domaine: { base: "exemple.test", https: true }, dataDir: dossier, etatDir: dossier,
    atelier: { url: "http://127.0.0.1:1" }, verificateur: { url: "http://127.0.0.1:1" },
    secrets: { github: "jeton-de-test", worker: "x" }, github: { proprietaire: "essai", depot_etat: "etat" },
    modeles: {}, slack: { canal: "", admins: [] }, perimetre_protege: [], couts: { devise: "USD" }, budget: {},
  }
}

async function ouvrir(nom) {
  const dossier = join(racine, nom)
  mkdirSync(dossier)
  const { ouvrirDb } = await import("../src/db.mjs")
  const { ouvrirCouts } = await import("../src/couts.mjs")
  const db = ouvrirDb(join(dossier, "usine.db"))
  ouvrirCouts(db)
  return { db, config: configEssai(dossier), dossier }
}

const ecrireJson = (dossier, nom, contenu) => writeFileSync(join(dossier, nom), JSON.stringify(contenu))
const conteneur = (x) => ({ etat: "running", sante: "healthy", redemarrages: 0, redemarrages_30_min: 0, code_sortie: 0, oom: false, ...x })

before(async () => {
  // Le faux portier : la session vient d'un cookie « s=admin » ou « s=membre ».
  portier = createServer((req, res) => {
    const s = /s=(\w+)/.exec(req.headers.cookie ?? "")?.[1]
    res.writeHead(req.url.startsWith("/_portier/qui") && !s ? 401 : 200, { "content-type": "application/json" })
    if (req.url.startsWith("/_portier/qui")) return res.end(s ? JSON.stringify({ email: `${s}@exemple.test`, role: s === "admin" ? "admin" : "membre", autorise: true }) : "{}")
    res.end("{}")
  }).listen(0)
  await new Promise((r) => portier.once("listening", r))
  process.env.PORTIER_URL = `http://127.0.0.1:${portier.address().port}`
  process.env.PORTIER_API_TOKEN = "j".repeat(40)
  mod = await import("../src/visibilite.mjs")

  // --- La base à date fixe : quatre projets, des évènements autour des bords de la fenêtre.
  fixe = await ouvrir("fixe")
  const ins = fixe.db.prepare("INSERT INTO projets (id, prompt, statut, nom, slug) VALUES (?, 'p', ?, ?, ?)")
  ins.run(1, "en_production", "Vigie Copro", "vigie-copro")
  ins.run(2, "bloque", "Vingt-Cinq", "vingt-cinq")
  ins.run(3, "livre", "Prêt'Asso", "pret-asso")
  ins.run(4, "abandonne", "Ancien", null)
  const j = fixe.db.prepare("INSERT INTO journal (projet_id, type, message, le) VALUES (?, ?, ?, ?)")
  j.run(1, "fusion", "T1 fusionnée (PR #1, 10 tests)", "2026-11-04 22:59:00") // le 4 à 23 h 59 à Paris : hors fenêtre
  j.run(1, "fusion", "T2 fusionnée (PR #2, 11 tests)", "2026-11-04 23:01:00") // le 5 à 00 h 01 à Paris
  j.run(3, "fusion", "T8 fusionnée (PR #17, 53 tests)", "2026-11-08 23:30:00") // le 9 à 00 h 30 à Paris
  j.run(3, "fusion", "T9 fusionnée (PR #18, 54 tests)", "2026-11-09 02:33:18")
  j.run(3, "refus", "T9 refusée (2 motif(s)) : critère non validé : 7. Disparition avec transition et toast Annuler (observé : une seule image)", "2026-11-09 02:25:08")
  j.run(3, "refus", "T9 refusée (1 motif(s)) : design : Accueil — ordinateur : Le titre manque de contraste. → Afficher ce titre sans atténuation", "2026-11-09 02:18:30")
  j.run(3, "refus", "T7 refusée (1 motif(s)) : design : Accueil — mobile : texte trop pâle", "2026-11-10 09:00:00")
  j.run(1, "refus", "T3 refusée (1 motif(s)) : problème : À 390 px, toucher une ligne n’ouvre pas le panneau", "2026-11-10 10:00:00")
  j.run(1, "refus", "T4 refusée (1 motif(s)) : 2 test(s) échouent", "2026-11-11 08:00:00")
  j.run(1, "refus", "T4 refusée (1 motif(s)) : 3 test(s) échouent", "2026-11-11 15:50:00") // plus tard que maintenant
  j.run(2, "escalade", "T5 : décision demandée", "2026-11-06 10:00:00")
  j.run(1, "production", "Mise en production", "2026-11-08 22:09:00") // un autre type : ignoré
  const c = fixe.db.prepare("INSERT INTO consommations (projet_id, role, moteur, modele, cout_api_usd, duree_s, le) VALUES (?, 'agent', 'claude-code', 'm', ?, ?, ?)")
  c.run(3, 6.44, 7488, "2026-11-09 01:00:00")
  c.run(1, 1.57, 1440, "2026-11-10 10:00:00")
  c.run(1, null, 0, "2026-11-10 11:00:00") // prix inconnu
  c.run(1, 100, 3600, "2026-11-01 10:00:00") // hors fenêtre
  const t = fixe.db.prepare("INSERT INTO taches (projet_id, cle, lot, titre, description, criteres, statut, tentative, maj_le) VALUES (?, ?, 1, ?, 'd', '[]', ?, ?, ?)")
  t.run(3, "T10", "Rappel des retards", "en_cours", 1, "2026-11-11 15:28:00")
  t.run(1, "T5", "Export des charges", "verification", 0, "2026-11-11 15:10:00")
  t.run(1, "T6", "Plus tard", "prete", 0, "2026-11-11 15:00:00")
  ecrireJson(fixe.dossier, "sante.json", {
    le: "2026-11-11T15:39:30Z",
    disque: { total_go: 50.9, utilise_go: 33.5, libre_go: 15.3, pct: 66 },
    memoire: { total_mo: 4102, dispo_mo: 2107, swap_utilise_mo: 358 },
    charge: [0.98, 0.97, 1.01],
    applications: {
      le: "2026-11-11T15:39:58Z",
      produits: {
        "production/vigie-copro": { etat: "ok", raison: "répond en 41 ms", version: "b2ac2d85bd6b", deploiement: "ok", docker: conteneur({ demarre_le: "2026-11-08T22:09:18.273Z" }), http: { code: 200, ms: 41 } },
        "apercu/vingt-cinq": { etat: "panne", raison: "redémarre en boucle (29 redémarrage(s) en 30 min, 13931 au total) · dernier déploiement en échec", version: "fca2fc044334", deploiement: "echec", docker: conteneur({ etat: "restarting", sante: "unhealthy", redemarrages: 13931, redemarrages_30_min: 29, demarre_le: "2026-11-11T15:39:28Z", code_sortie: 1 }), http: null },
        "apercu/pret-asso": { etat: "alerte", raison: "a redémarré 1 fois en 30 min", version: "3aa7555fec06", deploiement: "ok", docker: conteneur({ redemarrages: 1, redemarrages_30_min: 1, demarre_le: "2026-11-11T15:20:00Z" }), http: { code: 200, ms: 39 } },
        "production/sans-projet": { etat: "ok", raison: "répond en 12 ms", version: null, docker: null, http: null },
        "../etc": { etat: "panne", raison: "clé invalide" },
      },
    },
  })
  ecrireJson(fixe.dossier, "statut.json", {
    "production/vigie-copro": { etat: "ok", sha: "b2ac2d85bd6bffff", demande_le: "2026-11-08T22:06:28Z", couleur: "blue", le: "2026-11-08T22:09:23Z", conteneur: "usine-prod-vigie-copro-blue" },
    "apercu/vingt-cinq": { etat: "echec", sha: "fca2fc044334aaaa", demande_le: "2026-10-06T16:26:23Z", le: "2026-10-06T16:28:13Z", message: "l'aperçu ne répond pas à /api/health :\n    at writeFileSync (node:fs:2482:20)" },
    "apercu/pret-asso": { etat: "en_cours", sha: "1111111aaaa", sha_demande: "3aa7555fec06bbbb", demande_le: "2026-11-11T14:40:00Z", le: "2026-11-11T14:40:05Z" },
    "production/acte-clair": { etat: "ok", sha: "1523e8dae9a9cccc", demande_le: "2026-11-09T02:58:02Z", couleur: "green", le: "2026-11-09T03:03:13Z" },
  })

  // --- La base de l'API : des évènements d'il y a une heure, un bilan de santé d'à l'instant.
  api = await ouvrir("api")
  const { ouvrirCycle } = await import("../src/cycle.mjs")
  const { ouvrirDomaines } = await import("../src/domaines.mjs")
  ouvrirCycle(api.db)
  ouvrirDomaines(api.db)
  api.db.prepare("INSERT INTO projets (id, prompt, statut, nom, slug) VALUES (1, 'p', 'bloque', 'Relais', 'relais')").run()
  api.db.prepare("INSERT INTO escalades (projet_id, raison, options) VALUES (1, 'criteres', ?)").run(JSON.stringify([{ cle: "A", libelle: "Réessayer", detail: "" }]))
  api.db.prepare("INSERT INTO journal (projet_id, type, message, le) VALUES (1, 'fusion', 'T1 fusionnée (PR #1, 3 tests)', datetime('now', '-1 hour'))").run()
  api.db.prepare("INSERT INTO journal (projet_id, type, message, le) VALUES (1, 'refus', 'T2 refusée (1 motif(s)) : design : trop pâle', datetime('now', '-1 hour'))").run()
  const maintenant = new Date().toISOString()
  ecrireJson(api.dossier, "sante.json", { le: maintenant, disque: { total_go: 50, utilise_go: 10, libre_go: 40, pct: 20 }, memoire: { total_mo: 4000, dispo_mo: 3000, swap_utilise_mo: 0 }, charge: [0.2, 0.2, 0.2], applications: { le: maintenant, produits: { "production/relais": { etat: "ok", raison: "répond en 9 ms", version: "abcdef0123", docker: conteneur({ demarre_le: maintenant }), http: { code: 200, ms: 9 } } } } })
  const { traiter } = await import("../src/console.mjs")
  const silence = async () => {}
  const ctx = { config: api.config, db: api.db, notifier: { alerte: silence, progres: silence, escalade: silence } }
  serveur = createServer((req, res) => traiter(ctx, req, res)).listen(0)
  await new Promise((r) => serveur.once("listening", r))
  base = `http://127.0.0.1:${serveur.address().port}`
})
after(() => {
  portier.close()
  serveur.close()
})

const calcul = (options = {}) => mod.visibilite(fixe, { maintenant: MAINTENANT, processeurs: 1, ...options })

test("la cause d'un refus : le premier segment du motif", () => {
  assert.equal(mod.causeDuRefus("T9 refusée (2 motif(s)) : critère non validé : 7. Disparition (observé : x)"), "critère non validé")
  assert.equal(mod.causeDuRefus("T9 refusée (1 motif(s)) : design : Accueil — ordinateur : trop pâle"), "design")
  assert.equal(mod.causeDuRefus("T3 refusée (1 motif(s)) : problème : À 390 px, rien ne s'ouvre"), "problème")
  assert.equal(mod.causeDuRefus("T1 refusée (1 motif(s)) : le build échoue :\nerreur TS2304"), "le build échoue")
  assert.equal(mod.causeDuRefus("T1 refusée (1 motif(s)) : régression (un critère déjà validé ne tient plus) : la liste"), "régression")
  assert.equal(mod.causeDuRefus("T4 refusée (1 motif(s)) : 2 test(s) échouent"), mod.causeDuRefus("T4 refusée (3 motif(s)) : 14 test(s) échouent"))
  assert.equal(mod.causeDuRefus("T1 refusée (1 motif(s)) : l'application ne démarre pas (le contrôle de santé /api/health ne répond pas)"), "l'application ne démarre pas")
  assert.equal(mod.causeDuRefus("T2 refusée (1 motif(s)) : `npm test` échoue dans l'atelier : sortie 1"), "npm test échoue dans l'atelier")
  assert.equal(mod.causeDuRefus("un message sans motif"), "autre")
  assert.equal(mod.causeDuRefus(null), "autre")
  assert.ok(mod.causeDuRefus(`T1 refusée (1 motif(s)) : ${"x".repeat(200)}`).length <= 60)
})

test("les 7 jours se comptent sur le calendrier de Paris, passage à l'heure d'été compris", () => {
  assert.deepEqual(mod.joursFenetre(MAINTENANT), ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10", "2026-11-11"])
  // Le 30 mars 2026 à 00 h 30 à Paris (le 29 à 22 h 30 en temps universel) : le 29, jour du changement d'heure, est bien là.
  assert.deepEqual(mod.joursFenetre(Date.parse("2026-03-29T22:30:00Z"), 3), ["2026-03-28", "2026-03-29", "2026-03-30"])
  assert.equal(mod.jourParis(new Date("2026-11-08T23:30:00Z")), "2026-11-09")
})

test("7 derniers jours : fusions, refus, escalades, causes et coûts, au jour de Paris", () => {
  const w = calcul().semaine
  assert.equal(w.du, "2026-11-05")
  assert.equal(w.au, "2026-11-11")
  // Hors fenêtre : la fusion du 4 à 23 h 59 (Paris), le refus de 15 h 50 (après maintenant), la consommation du 1er.
  assert.deepEqual([w.fusions, w.refus, w.escalades], [3, 5, 1])
  assert.equal(w.acceptes_pct, 38)
  const jour = Object.fromEntries(w.jours.map((x) => [x.jour, x]))
  assert.equal(w.jours.length, 7)
  assert.equal(jour["2026-11-05"].fusions, 1)
  assert.equal(jour["2026-11-09"].fusions, 2, "la fusion de 23 h 30 (temps universel) compte le 9, à Paris")
  assert.deepEqual([jour["2026-11-09"].refus, jour["2026-11-10"].refus, jour["2026-11-11"].refus], [2, 2, 1])
  assert.equal(jour["2026-11-06"].escalades, 1)
  assert.deepEqual(w.causes.map((c) => [c.cause, c.n]), [["design", 2], ["critère non validé", 1], ["N test(s) échouent", 1], ["problème", 1]])
  assert.equal(w.causes[0].pct, 40)
  assert.equal(Math.round(w.cout_api * 100), 801)
  assert.match(w.cout_api_texte, /8,01/)
  assert.equal(w.cout_incomplet, true)
  assert.equal(w.heures, 2.5)
  // Par produit, le plus coûteux d'abord ; un projet sans activité n'y est pas.
  assert.deepEqual(w.produits.map((p) => [p.nom, p.fusions, p.refus, p.escalades]), [["Prêt'Asso", 2, 3, 0], ["Vigie Copro", 1, 2, 0], ["Vingt-Cinq", 0, 0, 1]])
  assert.equal(w.produits[0].heures, 2.1)
})

test("les productions et les aperçus, d'après la sonde", () => {
  const v = calcul()
  assert.equal(v.sonde.perimee, false)
  assert.equal(v.sonde.age_s, 2)
  assert.deepEqual(v.productions.map((x) => x.cle), ["production/sans-projet", "production/vigie-copro"])
  const vigie = v.productions.find((x) => x.slug === "vigie-copro")
  assert.equal(vigie.nom, "Vigie Copro")
  assert.equal(vigie.projet_id, 1)
  assert.equal(vigie.version, "b2ac2d8")
  assert.equal(vigie.redemarrages, 0)
  assert.equal(vigie.age_s, Math.round((MAINTENANT - Date.parse("2026-11-08T22:09:18.273Z")) / 1000))
  assert.equal(vigie.adresse, "https://vigie-copro.exemple.test")
  // Les aperçus à part, le plus grave d'abord ; une clé invalide est ignorée.
  assert.deepEqual(v.apercus.map((x) => [x.slug, x.etat]), [["vingt-cinq", "panne"], ["pret-asso", "alerte"]])
  assert.equal(v.apercus[0].redemarrages, 13931)
  assert.equal(v.apercus[0].redemarrages_30_min, 29)
  assert.equal(v.apercus[0].adresse, "https://vingt-cinq.apercu.exemple.test")
  const sansProjet = v.productions[0]
  assert.equal(sansProjet.projet_id, null)
  assert.equal(sansProjet.adresse, null)
  assert.equal(sansProjet.age_s, null)
})

test("ce qui t'attend : la décision d'abord, puis la panne, l'alerte, et ce qui est prêt", () => {
  const aTraiter = [
    { type: "livre", projet: 3, titre: "Prêt'Asso · prêt à mettre en ligne", detail: "à mettre en ligne ou à corriger", depuis: "2026-11-09 02:35:00" },
    { type: "decision", projet: 2, titre: "Vingt-Cinq · décision attendue", detail: "la durée maximale du projet est atteinte", depuis: "2026-10-23 18:27:18" },
  ]
  const a = calcul({ aTraiter }).attend
  assert.deepEqual(a.map((x) => x.type), ["decision", "panne", "alerte", "livre"])
  assert.equal(a[0].depuis, "2026-10-23T18:27:18.000Z")
  assert.equal(a[0].lien, "#/projets/2")
  assert.equal(a[1].titre, "Vingt-Cinq · aperçu en panne")
  assert.match(a[1].detail, /redémarre en boucle/)
  assert.equal(a[2].titre, "Prêt'Asso · aperçu à surveiller")
})

test("une sonde trop ancienne : états inconnus, une seule ligne d'alerte", () => {
  const v = calcul({ maintenant: Date.parse("2026-11-11T16:00:00Z") })
  assert.equal(v.sonde.perimee, true)
  assert.ok([...v.productions, ...v.apercus].every((x) => x.etat === "inconnu"))
  assert.equal(v.apercus[0].etat_mesure, "panne")
  assert.deepEqual(v.attend.map((x) => x.type), ["sonde"])
})

test("l'usine maintenant : tâches en cours, mises en ligne, serveur", () => {
  const u = calcul().usine
  assert.deepEqual(u.taches.map((t) => [t.projet, t.cle, t.statut]), [["Vigie Copro", "T5", "verification"], ["Prêt'Asso", "T10", "en_cours"]])
  assert.equal(u.taches[1].tentative, 1)
  assert.equal(u.taches[1].depuis, "2026-11-11T15:28:00.000Z")
  const d = u.deploiements
  assert.equal(d.en_cours.length, 1)
  assert.equal(d.en_cours[0].sha, "3aa7555", "en cours : la version demandée")
  assert.equal(d.en_cours[0].bloque, true, "commencé il y a une heure : au-delà de 45 min")
  assert.equal(d.dernier.cle, "production/acte-clair")
  assert.deepEqual([d.dernier.etat, d.dernier.sha, d.dernier.couleur, d.dernier.projet_id], ["ok", "1523e8d", "green", null])
  const s = u.serveur
  assert.equal(s.perime, false)
  assert.equal(s.disque.etat, "ok")
  assert.equal(s.memoire.pct, 49)
  assert.deepEqual([s.charge.pct, s.charge.processeurs, s.charge.etat], [98, 1, "ok"])
  assert.equal(calcul({ processeurs: 0.4 }).usine.serveur.charge.etat, "alerte")
})

test("le message d'une mise en ligne échouée : sa première ligne", async () => {
  ecrireJson(fixe.dossier, "statut.json", { "apercu/vingt-cinq": { etat: "echec", sha: "fca2fc0", le: "2026-11-10T16:28:13Z", message: "l'aperçu ne répond pas à /api/health :\n    at writeFileSync (node:fs:2482:20)" } })
  const d = calcul().usine.deploiements
  assert.equal(d.dernier.message, "l'aperçu ne répond pas à /api/health")
  assert.equal(d.dernier.nom, "Vingt-Cinq")
  ecrireJson(fixe.dossier, "statut.json", "pas un objet")
  assert.deepEqual(calcul().usine.deploiements, { en_cours: [], dernier: null })
})

test("sans bilan du serveur : pas de serveur ni de produits, rien ne casse", async () => {
  const vide = await ouvrir("vide")
  const v = mod.visibilite(vide, { maintenant: MAINTENANT })
  assert.equal(v.usine.serveur, null)
  assert.equal(v.sonde.absente, true)
  assert.deepEqual([v.productions, v.apercus, v.attend, v.usine.taches], [[], [], [], []])
  assert.deepEqual([v.semaine.fusions, v.semaine.acceptes_pct, v.semaine.causes, v.semaine.produits], [0, null, [], []])
})

test("API : GET /api/visibilite, réservé aux administrateurs, sans secret, sans écriture", async () => {
  const avant = api.db.prepare("SELECT COUNT(*) AS n FROM journal").get().n
  const r = await fetch(`${base}/api/visibilite`, { headers: { cookie: "s=admin" } })
  assert.equal(r.status, 200)
  const texte = await r.text()
  assert.ok(!texte.includes("jeton-de-test"), "aucun secret dans la réponse")
  const v = JSON.parse(texte)
  assert.deepEqual(Object.keys(v), ["le", "fuseau", "attend", "sonde", "productions", "apercus", "usine", "semaine"])
  assert.equal(v.fuseau, "Europe/Paris")
  assert.equal(v.attend[0].type, "decision")
  assert.equal(v.attend[0].titre, "Relais · décision attendue")
  assert.ok(v.attend[0].depuis, "la décision dit depuis quand elle attend")
  assert.deepEqual(v.productions.map((x) => [x.nom, x.etat, x.version]), [["Relais", "ok", "abcdef0"]])
  assert.deepEqual([v.semaine.fusions, v.semaine.refus, v.semaine.jours.length], [1, 1, 7])
  assert.deepEqual(v.semaine.causes, [{ cause: "design", n: 1, pct: 100 }])
  assert.equal(api.db.prepare("SELECT COUNT(*) AS n FROM journal").get().n, avant, "un GET ne note rien")

  assert.equal((await fetch(`${base}/api/visibilite`, { headers: { cookie: "s=membre" } })).status, 403)
  assert.equal((await fetch(`${base}/api/visibilite`)).status, 403)
  // Une seule méthode : un POST ne trouve pas de route.
  const p = await fetch(`${base}/api/visibilite`, { method: "POST", headers: { cookie: "s=admin", "content-type": "application/json", origin: base }, body: "{}" })
  assert.equal(p.status, 404)
})

test("API : l'accueil garde ses éléments à traiter, avec depuis quand", async () => {
  const r = await (await fetch(`${base}/api/resume`, { headers: { cookie: "s=admin" } })).json()
  assert.equal(r.a_traiter[0].type, "decision")
  assert.ok(r.a_traiter[0].depuis)
})
