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
    secrets: { github: "jeton-de-test", worker: "secret-worker-essai", slackBot: "xoxb-essai-secret" }, github: { proprietaire: "essai", depot_etat: "etat" },
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
  // Qui fait quoi : les modèles du contrat, et des travaux sans coût (les totaux de la semaine ne bougent pas).
  fixe.config.modeles = { analyste: { modele: "claude-opus-5-5" }, atelier: { modele: "claude-sonnet-5-5" }, renfort: { modele: "claude-opus-5-5" } }
  const m = fixe.db.prepare("INSERT INTO consommations (projet_id, tache_id, role, moteur, modele, cout_api_usd, duree_s, le) VALUES (?, ?, ?, ?, ?, ?, 0, ?)")
  m.run(1, 3, "relecteur-securite", "claude-code", "claude-sonnet-5-5", 0, "2026-11-09 08:00:00") // T6
  m.run(1, 2, "agent", "claude-code", "claude-sonnet-5-5", 0, "2026-11-10 12:00:00") // T5
  m.run(1, 2, "agent", "claude-code", "inconnu", 0, "2026-11-10 12:01:00")
  m.run(1, 2, "verificateur", "codex", "gpt-6.1-sol", null, "2026-11-10 12:10:00")
  m.run(1, 2, "verificateur", "claude-code", "claude-opus-5-5", 0, "2026-11-10 12:20:00") // le relais
  m.run(1, 2, "designer", "codex", "gpt-6.1-sol", null, "2026-11-10 12:30:00")
  m.run(3, 1, "agent", "passerelle", "claude-opus-5-5", 0, "2026-11-11 09:00:00") // T10, payé à l'usage
  fixe.db.prepare("INSERT INTO reglages (cle, valeur) VALUES ('modele_codex', 'gpt-6.1-sol'), ('limite_claude-code_abonnement', '2099-01-01T00:00:00.000Z')").run()
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
    "production/vigie-copro": { etat: "ok", sha: "b2ac2d85bd6bffff", demande_le: "2026-11-08T22:06:28Z", couleur: "blue", le: "2026-11-08T22:09:23Z", conteneur: "usine-prod-vigie-copro-blue", hote: "vigie.hote-interne.test", hote_mails: "mails.hote-interne.test", acces: "protege", chemins_publics: ["/chemin-interne"] },
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
  assert.equal(mod.causeDuRefus("T1 refusée (1 motif(s)) : le build échoue :\nerreur TS2304"), "le code ne se construit pas")
  assert.equal(mod.causeDuRefus("T1 refusée (1 motif(s)) : régression (un critère déjà validé ne tient plus) : la liste"), "une fonction déjà validée ne marche plus")
  assert.equal(mod.causeDuRefus("T4 refusée (1 motif(s)) : 2 test(s) échouent"), mod.causeDuRefus("T4 refusée (3 motif(s)) : 14 test(s) échouent"))
  assert.equal(mod.causeDuRefus("T1 refusée (1 motif(s)) : l'application ne démarre pas (le contrôle de santé /api/health ne répond pas)"), "l'application ne démarre pas")
  assert.equal(mod.causeDuRefus("T2 refusée (1 motif(s)) : `npm test` échoue dans l'atelier : sortie 1"), "des tests échouent")
  assert.equal(mod.causeDuRefus("T2 refusée (1 motif(s)) : `npm run build` puis `npm test` échouent dans l'atelier : sortie 1"), "le code ne se construit pas")
  // Les mots de la maquette restent tels quels.
  assert.equal(mod.causeDuRefus("T2 refusée (1 motif(s)) : sécurité : une clé"), "sécurité")
  assert.equal(mod.causeDuRefus("un message sans motif"), "autre")
  assert.equal(mod.causeDuRefus(null), "autre")
  assert.ok(mod.causeDuRefus(`T1 refusée (1 motif(s)) : ${"x".repeat(200)}`).length <= 60)
})

test("les raisons de la sonde, en clair", () => {
  assert.equal(mod.enClair("pas en ligne : dernier déploiement en échec, aucun conteneur"), "pas en ligne : la dernière mise en ligne a échoué, rien ne tourne")
  assert.equal(mod.enClair("conteneur absent · déploiement bloqué depuis 50 min"), "l'application n'est pas lancée · mise en ligne bloquée depuis 50 min")
  assert.equal(mod.enClair("arrêté (exited, code de sortie 137, mémoire dépassée)"), "arrêté : mémoire dépassée (code 137)")
  assert.equal(mod.enClair("lent : /api/health en 4200 ms"), "lent : répond en 4200 ms")
  assert.equal(mod.enClair("/api/health répond 502 · déploiement en cours"), "répond par une erreur (502) · mise en ligne en cours")
  assert.equal(mod.enClair("répond en 41 ms"), "répond en 41 ms")
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
  assert.deepEqual(w.causes.map((c) => [c.cause, c.n]), [["design", 2], ["critère non validé", 1], ["des tests échouent", 1], ["problème", 1]])
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
  // Les raisons de la sonde, avec les mots de l'usine (ni « déploiement » ni « conteneur »).
  assert.equal(a[1].detail, "redémarre sans arrêt (29 fois en 30 min, 13931 au total) · la dernière mise en ligne a échoué")
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

test("le nom d'un modèle, pour tout le monde", () => {
  assert.equal(mod.nomModele("claude-code", "claude-sonnet-5-5"), "Claude Sonnet 5.5")
  assert.equal(mod.nomModele("claude-code", "claude-sonnet-5"), "Claude Sonnet 5")
  assert.equal(mod.nomModele("passerelle", "anthropic/claude-haiku-4.5"), "Claude Haiku 4.5")
  assert.equal(mod.nomModele("codex", "gpt-6.1-sol"), "ChatGPT (gpt-6.1-sol)")
  assert.equal(mod.nomModele("codex", "openai/gpt-5.5"), "ChatGPT (gpt-5.5)")
  assert.equal(mod.nomModele("codex", "codex"), "ChatGPT, modèle non noté")
  assert.equal(mod.nomModele("claude-code", "inconnu"), "Claude, modèle non noté")
  // Un identifiant daté : la date n'est pas un numéro de version.
  assert.equal(mod.nomModele("claude-code", "claude-sonnet-4-20250514"), "Claude Sonnet 4")
  assert.equal(mod.nomModele("claude-code", "claude-haiku-4-5-20251001"), "Claude Haiku 4.5")
})

test("les modèles : bornes, secrets, limites, projets supprimés, coût inconnu", async () => {
  const b = await ouvrir("modeles")
  // Le contrat pourrait contenir autre chose qu'un nom : rien d'autre ne sort.
  b.config.modeles = { atelier: { modele: "claude-sonnet-5-5", cle: "sk-essai-contrat" }, analyste: { modele: { secret: "sk-objet" } }, renfort: { modele: "x".repeat(5000) } }
  b.config.relais = { verification: ["codex", "sk-relais"] }
  b.db.prepare("INSERT INTO projets (id, prompt, statut, nom, slug) VALUES (1, 'p', 'fabrication', 'Actif', 'actif'), (2, 'p', 'supprime', 'Supprimé', 'supprime')").run()
  const t = b.db.prepare("INSERT INTO taches (projet_id, cle, lot, titre, description, criteres, statut) VALUES (?, ?, 1, ?, 'd', '[]', 'fusionnee')")
  for (let i = 1; i <= 10; i++) t.run(1, `T${i}`, `Fonction ${i}`)
  t.run(2, "T99", "D'un projet supprimé")
  const c = b.db.prepare("INSERT INTO consommations (projet_id, tache_id, role, moteur, modele, cout_api_usd, duree_s, le) VALUES (?, ?, ?, ?, ?, ?, 0, ?)")
  for (let i = 1; i <= 10; i++) c.run(1, i, "agent", "claude-code", "claude-sonnet-5-5", 1, `2026-11-10 10:${String(i).padStart(2, "0")}:00`)
  c.run(2, 11, "agent", "claude-code", "claude-sonnet-5-5", 1, "2026-11-10 11:00:00") // la plus récente, mais supprimée
  c.run(1, 1, "verificateur", "codex", "gpt-6.1-sol", null, "2026-11-10 12:00:00") // prix inconnu
  c.run(1, 2, "designer", "codex", "gpt-6.1-sol", null, "2026-11-10 12:00:00")
  c.run(1, 2, "designer", "codex", "gpt-6.1-sol", 2, "2026-11-10 12:01:00") // une partie au prix connu : incomplet
  c.run(1, null, "r".repeat(500), "m".repeat(500), "z".repeat(500), 0, "2026-11-10 12:00:00")
  b.db.prepare("INSERT INTO reglages (cle, valeur) VALUES (?, ?), (?, ?), (?, ?), (?, ?)").run(
    "modele_codex", "g".repeat(5000),
    "limite_claude-code_abonnement", "2000-01-01T00:00:00.000Z", // passée : pas montrée
    "limite_codex_cle", "2099-01-01T00:00:00.000Z",
    "limite_inconnu_xx", "2099-01-01T00:00:00.000Z", // un moteur inconnu : pas montré
  )
  const avant = ["journal", "reglages", "consommations"].map((x) => b.db.prepare(`SELECT COUNT(*) AS n FROM ${x}`).get().n)
  const v = mod.visibilite(b, { maintenant: MAINTENANT, processeurs: 1 })
  assert.deepEqual(["journal", "reglages", "consommations"].map((x) => b.db.prepare(`SELECT COUNT(*) AS n FROM ${x}`).get().n), avant, "rien n'est écrit")
  const texte = JSON.stringify(v)
  assert.ok(!texte.includes("sk-"), "rien du contrat au-delà des noms de modèles")
  const q = v.usine.qui_fait_quoi
  for (const r of q.roles) for (const x of r.modeles) assert.ok((x.modele ?? "").length <= 60 && x.nom.length <= 80, `${r.role} : nom borné`)
  assert.deepEqual(q.roles.find((r) => r.role === "plan").modeles.map((x) => [x.modele, x.nom]), [[null, "Claude, modèle par défaut"]])
  assert.deepEqual(q.roles.find((r) => r.role === "verification").modeles.map((x) => x.moteur), ["codex"])
  assert.deepEqual(q.limites.map((l) => [l.nom, l.mode]), [["ChatGPT", "clé API"]])
  // Les 8 fonctions travaillées le plus récemment (T2 et T1 ont été contrôlées et relues après T10), la
  // plus récente d'abord ; celle du projet supprimé n'y est pas, et ne prend la place d'aucune autre.
  assert.deepEqual(v.semaine.fonctions.map((f) => f.cle), ["T2", "T1", "T10", "T9", "T8", "T7", "T6", "T5"])
  const m = v.semaine.modeles
  const codex = m.find((x) => x.role === "verificateur")
  assert.deepEqual([codex.cout_api, codex.cout_api_texte, codex.prix_inconnu], [null, null, true])
  const design = m.find((x) => x.role === "designer")
  assert.deepEqual([design.cout_api, design.prix_inconnu], [2, true])
  const long = m.find((x) => x.role.startsWith("r"))
  assert.ok(long.role.length <= 40 && long.moteur.length <= 20 && long.modele.length <= 60 && long.travail.length <= 40 && long.nom.length <= 60)
})

test("qui fait quoi : le modèle de chaque travail, le relais, les limites d'usage", () => {
  const u = calcul().usine
  const roles = Object.fromEntries(u.qui_fait_quoi.roles.map((r) => [r.role, r.modeles.map((x) => x.nom)]))
  assert.deepEqual(roles, {
    plan: ["Claude Opus 5.5"], construction: ["Claude Sonnet 5.5"], renfort: ["Claude Opus 5.5"], securite: ["Claude Sonnet 5.5"],
    // Par défaut, ChatGPT juge d'abord ; Claude (le modèle du renfort) prend le relais.
    verification: ["ChatGPT (gpt-6.1-sol)", "Claude Opus 5.5"], design: ["ChatGPT (gpt-6.1-sol)", "Claude Opus 5.5"], recette: ["ChatGPT (gpt-6.1-sol)", "Claude Opus 5.5"],
  })
  assert.deepEqual(u.qui_fait_quoi.limites, [{ moteur: "claude-code", nom: "Claude", acces: "abonnement", mode: "abonnement", jusqua: "2099-01-01T00:00:00.000Z" }])
  // Les mêmes mots que le bilan de la semaine.
  assert.deepEqual(u.qui_fait_quoi.roles.map((r) => r.travail), ["Faire le plan", "Construire", "Construire après un changement d'approche", "Relire la sécurité", "Contrôler", "Relire le design", "Jouer la recette"])
  // Chaque fonction en cours dit quel modèle y travaille, et qui l'a construite.
  const [t5, t10] = u.taches
  assert.deepEqual([t5.cle, t5.modeles, t5.construite_par], ["T5", ["ChatGPT (gpt-6.1-sol)", "Claude Opus 5.5"], "Claude Sonnet 5.5"])
  assert.deepEqual([t10.cle, t10.modeles, t10.construite_par], ["T10", ["Claude Sonnet 5.5"], "Claude Opus 5.5"])
  // L'ordre du relais réglé dans la console change ce qui est montré.
  fixe.db.prepare("INSERT INTO reglages (cle, valeur) VALUES ('relais_verification', '[\"claude-code\"]')").run()
  try {
    assert.deepEqual(calcul().usine.qui_fait_quoi.roles.find((r) => r.role === "verification").modeles.map((x) => x.nom), ["Claude Opus 5.5"])
  } finally {
    fixe.db.prepare("DELETE FROM reglages WHERE cle = 'relais_verification'").run()
  }
})

test("7 derniers jours : quel modèle a fait quel travail, et les dernières fonctions", () => {
  const w = calcul().semaine
  assert.deepEqual([...new Set(w.modeles.map((m) => m.travail))], ["Construire", "Relire la sécurité", "Contrôler", "Relire le design"])
  const trouve = (role, moteur, modele) => w.modeles.find((m) => m.role === role && m.moteur === moteur && m.modele === modele)
  const codex = trouve("verificateur", "codex", "gpt-6.1-sol")
  assert.deepEqual([codex.nom, codex.fonctions, codex.utilisations, codex.cout_api_texte, codex.prix_inconnu], ["ChatGPT (gpt-6.1-sol)", 1, 1, null, true])
  assert.equal(trouve("verificateur", "claude-code", "claude-opus-5-5").nom, "Claude Opus 5.5")
  const passerelle = trouve("agent", "passerelle", "claude-opus-5-5")
  assert.deepEqual([passerelle.nom, passerelle.paye_a_l_usage, passerelle.fonctions], ["Claude Opus 5.5", true, 1])
  // La plus récente d'abord ; un modèle « non noté » s'efface derrière le modèle connu.
  assert.deepEqual(w.fonctions.map((f) => [f.cle, f.statut]), [["T10", "en_cours"], ["T5", "verification"], ["T6", "prete"]])
  const t5 = w.fonctions[1]
  assert.deepEqual([t5.projet, t5.construite, t5.controlee, t5.design, t5.securite], ["Vigie Copro", ["Claude Sonnet 5.5"], ["ChatGPT (gpt-6.1-sol)", "Claude Opus 5.5"], ["ChatGPT (gpt-6.1-sol)"], []])
  assert.deepEqual(w.fonctions[2].securite, ["Claude Sonnet 5.5"])
})

test("rien des fichiers du déployeur au-delà de ce que la page montre", () => {
  const texte = JSON.stringify(calcul())
  for (const interne of ["usine-prod-vigie-copro-blue", "hote-interne", "/chemin-interne", "usine-apercu-"]) assert.ok(!texte.includes(interne), `${interne} ne doit pas sortir`)
  const d = calcul().usine.deploiements.en_cours[0]
  assert.deepEqual(Object.keys(d).sort(), ["bloque", "cle", "couleur", "demande_le", "environnement", "etat", "le", "message", "nom", "projet_id", "sha"])
})

test("des fichiers d'état mal formés : rien n'est présenté comme sûr", async () => {
  const mal = await ouvrir("mal")
  const ecrire = (applications) => ecrireJson(mal.dossier, "sante.json", {
    le: "pas une date",
    disque: { pct: "abc", libre_go: { x: 1 }, total_go: 50 },
    memoire: { total_mo: "4102", dispo_mo: null },
    charge: ["x", 1, 2],
    applications,
  })
  // Une date de sonde illisible : la mesure n'est pas datée, donc pas récente.
  ecrire({ le: "pas une date", produits: { "production/constructor": { etat: "bizarre", raison: { objet: true }, version: 1234567890, docker: { redemarrages: "beaucoup" } } } })
  let v = mod.visibilite(mal, { maintenant: MAINTENANT, processeurs: 1 })
  assert.equal(v.sonde.perimee, true)
  assert.equal(v.sonde.age_s, null)
  assert.deepEqual(v.attend.map((x) => [x.type, x.lien]), [["sonde", "#/reglages/etat"]])
  const p = v.productions[0]
  // « constructor » n'est pas un projet (pas de recherche dans le prototype d'un objet) : ni lien, ni adresse.
  assert.deepEqual([p.nom, p.projet_id, p.adresse], ["constructor", null, null])
  assert.deepEqual([p.etat, p.etat_mesure, p.version, p.redemarrages, typeof p.raison], ["inconnu", "inconnu", null, null, "string"])
  const s = v.usine.serveur
  assert.equal(s.perime, true)
  assert.deepEqual([s.disque.pct, s.disque.libre_go, s.disque.etat], [null, null, "inconnu"])
  assert.deepEqual([s.memoire.pct, s.memoire.etat], [null, "inconnu"])
  assert.deepEqual([s.charge.minute, s.charge.pct, s.charge.etat], [null, null, "inconnu"])
  // Une sonde muette (Docker n'a pas répondu) : une seule ligne, vers l'état de l'usine.
  ecrire({ le: "2026-11-11T15:39:58Z", produits: null })
  v = mod.visibilite(mal, { maintenant: MAINTENANT, processeurs: 1 })
  assert.equal(v.sonde.muette, true)
  assert.deepEqual(v.attend.map((x) => [x.type, x.titre, x.lien]), [["sonde", "L'état des produits est inconnu", "#/reglages/etat"]])
  // Une mise en ligne en cours sans date : elle n'est pas déclarée bloquée.
  ecrireJson(mal.dossier, "statut.json", { "apercu/x": { etat: "en_cours", sha_demande: "abcdef12345" } })
  assert.deepEqual(mod.visibilite(mal, { maintenant: MAINTENANT }).usine.deploiements.en_cours.map((x) => [x.sha, x.bloque]), [["abcdef1", false]])
})

test("le message d'une mise en ligne échouée : sa première ligne", async () => {
  ecrireJson(fixe.dossier, "statut.json", { "apercu/vingt-cinq": { etat: "echec", sha: "fca2fc0", le: "2026-11-10T16:28:13Z", message: "l'aperçu ne répond pas à /api/health :\n    at writeFileSync (node:fs:2482:20)" } })
  const d = calcul().usine.deploiements
  assert.equal(d.dernier.message, "l'aperçu ne répond pas")
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
  for (const secret of Object.values(api.config.secrets)) assert.ok(!texte.includes(secret), "aucun secret dans la réponse")
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
  assert.match(r.a_traiter[0].depuis, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/, "une date ISO, en temps universel")
})
