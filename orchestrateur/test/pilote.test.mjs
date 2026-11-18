// Le pilote des pannes : ce sont des règles codées qui décident, jamais un modèle. Une panne du code
// est corrigée jusqu'à l'aperçu, le reste va à une personne, une seule fois par panne.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ouvrirDb } from "../src/db.mjs"
import { ecrireReglage, lireReglage, ouvrirCouts } from "../src/couts.mjs"
import { JOUR_MS, PAR_PILOTE, RECHUTE_MS, RETABLI_MS, choisirAction, classerPanne, correctionsDuJournal, deciderPilote, etatPilote, lireMemoirePilote, passagePilote, reglagesPilote, reglerPilote, texteCorrection } from "../src/pilote.mjs"

const MIN = 60_000
const T0 = Date.parse("2026-11-18T10:00:00Z")
const reglages = { mode: "corriger", minutes: 10, parProduit: 1, parJour: 3 }
const boucle = { etat: "panne", raison: "redémarre en boucle (4 redémarrage(s) en 30 min, 12 au total)", version: "a1b2c3d4e5f6", deploiement: "ok", docker: { etat: "restarting", redemarrages_30_min: 4, code_sortie: 1, oom: false }, http: null }
const ok = { etat: "ok", raison: "répond en 40 ms", version: "a1b2c3d4e5f6" }
const projets = { vigie: { id: 8, nom: "Vigie Copro", statut: "en_production" } }

// Plusieurs passages de suite, une minute d'écart : les décisions de chacun.
function derouler(etats, { memoire = {}, regl = reglages, proj = projets, debut = T0 } = {}) {
  const passages = []
  let m = memoire
  etats.forEach((produits, i) => {
    const r = deciderPilote({ produits, projets: proj, memoire: m, reglages: regl, maintenant: debut + i * MIN })
    m = r.memoire
    passages.push(r.decisions)
  })
  return { passages, memoire: m }
}
const fois = (n, produits) => Array.from({ length: n }, () => produits)

test("classerPanne : le code, le serveur, l'attente et l'inconnu", () => {
  assert.equal(classerPanne(boucle).classe, "code")
  assert.equal(classerPanne({ etat: "panne", raison: "/api/health répond 500" }).classe, "code")
  assert.equal(classerPanne({ etat: "panne", raison: "ne répond pas à /api/health" }).classe, "code")
  assert.equal(classerPanne({ etat: "panne", raison: "arrêté (exited, code de sortie 1)", docker: { code_sortie: 1 } }).classe, "code")
  // Arrêtée proprement, ou de l'extérieur : rien ne désigne le code.
  assert.equal(classerPanne({ etat: "panne", raison: "arrêté (exited, code de sortie 0)", docker: { code_sortie: 0 } }).classe, "inconnu")
  assert.equal(classerPanne({ etat: "panne", raison: "arrêté (exited, code de sortie 137)", docker: { code_sortie: 137 } }).classe, "inconnu")
  // La mémoire : même si l'application redémarre en boucle, c'est au serveur de le dire.
  assert.equal(classerPanne({ ...boucle, docker: { ...boucle.docker, oom: true } }).classe, "serveur")
  assert.equal(classerPanne({ etat: "panne", raison: "arrêté (exited, code de sortie 137, mémoire dépassée)" }).classe, "serveur")
  assert.equal(classerPanne(boucle, { pannesProduction: 2 }).classe, "serveur")
  assert.match(classerPanne(boucle, { usine: [{ nom: "disque", etat: "panne", detail: "95 % utilisés" }] }).pourquoi, /serveur de l'usine a un problème \(disque\)/)
  assert.equal(classerPanne({ ...boucle, deploiement: "en_cours" }).classe, "attendre")
  assert.equal(classerPanne({ etat: "panne", raison: "conteneur absent" }).classe, "inconnu")
})

test("une panne du code de 10 minutes : une seule demande de corrections, rien avant", () => {
  const { passages, memoire } = derouler(fois(14, { "production/vigie": boucle }))
  const toutes = passages.flat()
  assert.equal(toutes.length, 1, "une seule décision pour toute la panne")
  assert.equal(passages.findIndex((d) => d.length), 10, "décidée au bout de 10 minutes, pas avant")
  assert.equal(toutes[0].type, "corriger")
  assert.equal(toutes[0].projet.id, 8)
  assert.equal(memoire.incidents["production/vigie"].decision, "corriger")
})

test("en observation : il dit ce qu'il aurait fait, et ne compte aucune correction", () => {
  const { passages, memoire } = derouler(fois(12, { "production/vigie": boucle }), { regl: { ...reglages, mode: "observer" } })
  assert.deepEqual(passages.flat().map((d) => d.type), ["observer"])
  assert.equal(memoire.corrections.length, 0)
})

test("coupé : rien du tout ; un aperçu en panne n'est jamais l'affaire du pilote", () => {
  assert.equal(derouler(fois(12, { "production/vigie": boucle }), { regl: { ...reglages, mode: "coupe" } }).passages.flat().length, 0)
  assert.equal(derouler(fois(12, { "apercu/vigie": boucle })).passages.flat().length, 0)
})

test("une cause hors du code, ou une cause inconnue : une personne, une seule fois", () => {
  const oom = { ...boucle, docker: { ...boucle.docker, oom: true } }
  const { passages } = derouler(fois(15, { "production/vigie": oom }))
  assert.deepEqual(passages.flat().map((d) => [d.type, d.classe]), [["humain", "serveur"]])
  // Deux applications en panne à la fois : cause commune, deux messages, aucune correction.
  const deux = derouler(fois(11, { "production/vigie": boucle, "production/acte": boucle }), { proj: { ...projets, acte: { id: 9, nom: "Acte Clair", statut: "en_production" } } })
  assert.deepEqual(deux.passages.flat().map((d) => d.type), ["humain", "humain"])
})

test("un projet déjà en travail : noté une fois, puis revu quand il est de nouveau en production", () => {
  const enTravail = { vigie: { ...projets.vigie, statut: "corrections" } }
  const a = derouler(fois(13, { "production/vigie": boucle }), { proj: enTravail })
  assert.deepEqual(a.passages.flat().map((d) => d.type), ["deja"])
  // La correction humaine est mise en ligne (nouvelle version), et la panne continue : le pilote la revoit.
  const b = derouler(fois(11, { "production/vigie": { ...boucle, version: "ffff00001111" } }), { memoire: a.memoire, debut: T0 + 13 * MIN })
  assert.deepEqual(b.passages.flat().map((d) => d.type), ["corriger"])
})

test("une version qui attend sa mise en ligne : une personne, pas une deuxième correction", () => {
  const { passages } = derouler(fois(11, { "production/vigie": boucle }), { proj: { vigie: { ...projets.vigie, statut: "livre" } } })
  assert.equal(passages.flat()[0].type, "humain")
  assert.match(passages.flat()[0].pourquoi, /attend sa mise en ligne/)
})

test("plafonds : trois corrections par 24 h pour toute l'usine ; zéro, c'est aucune", () => {
  const base = { classe: "code", pourquoi: "x", projet: projets.vigie, produit: "vigie", reglages, maintenant: T0 }
  assert.equal(choisirAction({ ...base, corrections: [] }).type, "corriger")
  const autres = ["a", "b", "c"].map((produit) => ({ produit, le: T0 - 3600_000 }))
  assert.match(choisirAction({ ...base, corrections: autres }).pourquoi, /3 corrections automatiques en 24 h : c'est son plafond/)
  assert.equal(choisirAction({ ...base, corrections: autres.map((c) => ({ ...c, le: T0 - JOUR_MS - MIN })) }).type, "corriger", "au-delà de 24 h, le plafond de l'usine est levé")
  assert.match(choisirAction({ ...base, corrections: [], reglages: { ...reglages, parProduit: 0 } }).pourquoi, /plafonnées à zéro/)
})

test("une rechute : toute panne dans les 7 jours qui suivent une correction, quelle que soit la version", () => {
  const base = { classe: "code", pourquoi: "x", projet: projets.vigie, produit: "vigie", reglages, maintenant: T0 }
  // Mise en ligne, elle n'a pas tenu.
  assert.equal(choisirAction({ ...base, corrections: [{ produit: "vigie", le: T0 - 2 * JOUR_MS }] }).type, "rechute")
  // L'analyste n'a rien trouvé à changer, la même version retombe chaque nuit : pas une correction par nuit.
  const d = choisirAction({ ...base, corrections: [{ produit: "vigie", le: T0 - 20 * 3600_000 }] })
  assert.equal(d.type, "rechute")
  assert.match(d.pourquoi, /ne réessaie pas/)
  assert.equal(choisirAction({ ...base, corrections: [{ produit: "vigie", le: T0 - RECHUTE_MS - MIN }] }).type, "corriger", "au-delà de 7 jours")
  assert.equal(choisirAction({ ...base, corrections: [{ produit: "autre", le: T0 - 3600_000 }] }).type, "corriger", "une autre application ne compte pas")
})

test("une correction est comptée dès qu'elle est décidée ; une observation ne l'est jamais", () => {
  const { memoire } = derouler(fois(11, { "production/vigie": boucle }))
  assert.deepEqual(memoire.corrections, [{ produit: "vigie", le: T0 + 10 * MIN }])
  // Six jours plus tard, la même application retombe : une personne.
  const apres = derouler(fois(11, { "production/vigie": boucle }), { memoire: { corrections: memoire.corrections }, debut: T0 + 6 * JOUR_MS })
  assert.deepEqual(apres.passages.flat().map((d) => d.type), ["rechute"])
})

test("une mémoire illisible : les pannes sont oubliées, les corrections recomptées depuis le journal", () => {
  const db = ouvrirDb(":memory:")
  ouvrirCouts(db)
  db.prepare("INSERT INTO projets (prompt, statut, nom, slug) VALUES ('p', 'en_production', 'Vigie Copro', 'vigie')").run()
  const sql = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ")
  const ligne = db.prepare("INSERT INTO journal (projet_id, type, message, le) VALUES (1, 'pilote', ?, ?)")
  ligne.run("Correction automatique demandée : Vigie Copro est en panne en ligne depuis 10 min.", sql(T0 - JOUR_MS))
  ligne.run("Observation : l'usine aurait demandé une correction.", sql(T0 - JOUR_MS))
  ligne.run("Correction automatique demandée : trop ancienne.", sql(T0 - RECHUTE_MS - JOUR_MS))
  assert.deepEqual(correctionsDuJournal(db, T0), [{ produit: "vigie", le: T0 - JOUR_MS }])
  ecrireReglage(db, "pilote_memoire", "{pas du json")
  const m = lireMemoirePilote(db, T0)
  assert.equal(m.recomptee, true)
  assert.deepEqual(m.corrections, [{ produit: "vigie", le: T0 - JOUR_MS }])
  // Une ligne abîmée est écartée, le reste est gardé.
  ecrireReglage(db, "pilote_memoire", JSON.stringify({ incidents: { "production/vigie": { depuis: "hier" }, "production/acte": { depuis: T0 } }, corrections: [{ produit: "vigie", le: "x" }, { produit: "acte", le: T0 }] }))
  const n = lireMemoirePilote(db, T0)
  assert.deepEqual([Object.keys(n.incidents), n.corrections.length, n.recomptee], [["production/acte"], 1, undefined])
})

test("le retour : 30 minutes de suite en ligne closent la panne ; un retour bref ne compte pas", () => {
  const a = derouler(fois(11, { "production/vigie": boucle }))
  // 10 minutes en ligne, puis de nouveau en panne : même panne, aucune nouvelle décision.
  const b = derouler([...fois(10, { "production/vigie": ok }), ...fois(15, { "production/vigie": boucle })], { memoire: a.memoire, debut: T0 + 11 * MIN })
  assert.equal(b.passages.flat().length, 0)
  // 30 minutes en ligne : « rétabli », et la panne est close.
  const c = derouler(fois(32, { "production/vigie": ok }), { memoire: b.memoire, debut: T0 + 40 * MIN })
  const retour = c.passages.flat()
  assert.deepEqual(retour.map((d) => d.type), ["retabli"])
  assert.equal(retour[0].incident.decision, "corriger")
  assert.equal(c.memoire.incidents["production/vigie"], undefined)
  assert.ok(RETABLI_MS === 30 * MIN)
})

test("la consigne de correction : ce que voit la sonde, un test d'abord, et la mise en ligne reste à une personne", () => {
  const t = texteCorrection({ nom: "Vigie Copro", depuis: T0, panne: boucle, pourquoi: "l'application s'arrête à chaque démarrage" }, T0 + 12 * MIN)
  assert.match(t, /Vigie Copro est en panne en production depuis 12 min/)
  assert.match(t, /redémarre en boucle/)
  assert.match(t, /version en ligne : a1b2c3d4e5f6/)
  assert.match(t, /test qui reproduit le défaut/)
  assert.match(t, /aucune nouvelle fonctionnalité/)
  assert.match(t, /La mise en ligne pour de vrai reste à une personne/)
})

test("le pilote n'appelle jamais la mise en ligne pour de vrai", () => {
  const source = readFileSync(new URL("../src/pilote.mjs", import.meta.url), "utf8")
  assert.doesNotMatch(source, /mettreEnProduction|ecrireEtat|production_reglages|ctx\.livraison|from "\.\/livraison\.mjs"/)
  // index.mjs ne lui donne que la demande de corrections.
  assert.match(readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8"), /demarrerPilote\(ctx, \{ corriger: livraison\.demanderCorrections \}\)/)
})

test("réglages : le mode de la console passe avant le contrat ; des bornes partout", () => {
  const db = ouvrirDb(":memory:")
  ouvrirCouts(db)
  assert.deepEqual(reglagesPilote({}, db), { mode: "observer", minutes: 10, parProduit: 1, parJour: 3 })
  assert.equal(reglagesPilote({ pilote: { mode: "corriger" } }, db).mode, "corriger")
  ecrireReglage(db, "pilote_mode", "coupe")
  assert.equal(reglagesPilote({ pilote: { mode: "corriger" } }, db).mode, "coupe")
  ecrireReglage(db, "pilote_mode", "n'importe quoi")
  assert.equal(reglagesPilote({}, db).mode, "observer")
  assert.deepEqual(reglagesPilote({ pilote: { minutes_avant_action: 0, corrections_par_application: 99, corrections_par_jour: "x" } }), { mode: "observer", minutes: 3, parProduit: 5, parJour: 3 })
})

// Un passage réel : sante.json sur disque, une base, une fausse livraison et un faux Slack.
function essai({ mode = "corriger" } = {}) {
  const dossier = mkdtempSync(join(tmpdir(), "pilote-"))
  const db = ouvrirDb(":memory:")
  ouvrirCouts(db)
  db.prepare("INSERT INTO projets (prompt, statut, nom, slug) VALUES ('p', 'en_production', 'Vigie Copro', 'vigie')").run()
  ecrireReglage(db, "pilote_mode", mode)
  const demandes = []
  const messages = []
  const ctx = { config: { dataDir: dossier, etatDir: dossier }, db, notifier: { alerte: async (texte) => messages.push(texte) } }
  const livraison = { reponse: async () => ({ ok: true }) }
  const corriger = async (_ctx, id, texte, par) => (demandes.push({ id, texte, par }), livraison.reponse())
  const sonde = (maintenant, produit) => writeFileSync(join(dossier, "sante.json"), JSON.stringify({ le: new Date(maintenant).toISOString(), applications: { le: new Date(maintenant).toISOString(), produits: { "production/vigie": produit } } }))
  const passer = (maintenant) => passagePilote(ctx, { maintenant, corriger })
  return { ctx, db, demandes, messages, sonde, dossier, livraison, passer }
}

test("un passage complet : la demande part une fois, avec le pilote pour auteur, et tout est au journal", async () => {
  const e = essai()
  for (let i = 0; i <= 12; i++) {
    e.sonde(T0 + i * MIN, boucle)
    await e.passer(T0 + i * MIN)
  }
  await new Promise((r) => setImmediate(r))
  assert.equal(e.demandes.length, 1)
  assert.deepEqual([e.demandes[0].id, e.demandes[0].par], [1, PAR_PILOTE])
  assert.match(e.demandes[0].texte, /redémarre en boucle/)
  assert.equal(lireMemoirePilote(e.db).corrections.length, 1)
  const journal = e.db.prepare("SELECT type, message FROM journal WHERE type = 'pilote'").all()
  assert.equal(journal.length, 1)
  assert.match(journal[0].message, /^Correction automatique demandée : Vigie Copro est en panne en ligne depuis 10 min\. L'application s'arrête à chaque démarrage\.$/)
  // La console voit la panne ouverte et la décision.
  const vu = etatPilote(e.ctx, T0 + 12 * MIN)
  assert.equal(vu.mode, "corriger")
  assert.equal(vu.corrections_24h, 1)
  assert.deepEqual(vu.pannes.map((p) => [p.nom, p.decision]), [["Vigie Copro", "corriger"]])
})

test("un passage : sonde trop ancienne ou usine à l'arrêt, le pilote ne fait rien", async () => {
  const e = essai()
  e.sonde(T0, boucle)
  assert.equal(await e.passer(T0 + 10 * MIN), null, "sonde vieille de 10 min : état réel inconnu")
  writeFileSync(join(e.dossier, "STOP"), "admin")
  e.sonde(T0 + 10 * MIN, boucle)
  assert.equal(await e.passer(T0 + 10 * MIN), null)
  assert.equal(lireReglage(e.db, "pilote_memoire"), null)
})

test("une demande refusée par la livraison : une personne est prévenue", async () => {
  const e = essai()
  e.livraison.reponse = async () => ({ ok: false, message: "Le projet est « corrections »." })
  for (let i = 0; i <= 10; i++) {
    e.sonde(T0 + i * MIN, boucle)
    await e.passer(T0 + i * MIN)
  }
  await new Promise((r) => setImmediate(r))
  assert.equal(e.messages.length, 1)
  assert.match(e.messages[0], /n'a pas pu partir : Le projet est « corrections »/)
})

test("en observation, un message ; passer en « corriger » pendant la panne la fait corriger", async () => {
  const e = essai({ mode: "observer" })
  for (let i = 0; i <= 10; i++) {
    e.sonde(T0 + i * MIN, boucle)
    await e.passer(T0 + i * MIN)
  }
  assert.equal(e.demandes.length, 0)
  assert.equal(e.messages.length, 1)
  assert.match(e.messages[0], /observation.*aurait demandé une correction.*Rien n'a été lancé/s)
  assert.match(reglerPilote(e.ctx, "corriger", "admin@exemple.test").message, /jusqu'à l'aperçu/)
  e.sonde(T0 + 11 * MIN, boucle)
  await e.passer(T0 + 11 * MIN)
  assert.equal(e.demandes.length, 1)
  assert.match(e.db.prepare("SELECT message FROM journal WHERE type = 'reglage'").get().message, /Pannes des applications en ligne : corriger jusqu'à l'aperçu \(par admin@exemple\.test\)/)
})

test("coupé, ou sans sonde récente : la console ne montre aucune panne figée", async () => {
  const e = essai({ mode: "observer" })
  for (let i = 0; i <= 10; i++) {
    e.sonde(T0 + i * MIN, boucle)
    await e.passer(T0 + i * MIN)
  }
  assert.equal(etatPilote(e.ctx, T0 + 10 * MIN).pannes.length, 1)
  assert.equal(etatPilote(e.ctx, T0 + 30 * MIN).pannes.length, 0, "sonde de 20 min : rien de suivi")
  reglerPilote(e.ctx, "coupe", "admin@exemple.test")
  assert.equal(etatPilote(e.ctx, T0 + 10 * MIN).pannes.length, 0)
  assert.deepEqual(lireMemoirePilote(e.db).incidents, {}, "coupé, il oublie les pannes en cours")
})
