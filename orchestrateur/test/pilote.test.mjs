// Le pilote des pannes : ce sont des règles codées qui décident, jamais un modèle. Une panne du code
// devient une proposition de correction (une personne la lance), le reste va à une personne, une
// seule fois par panne. Le pilote ne lance jamais rien.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ouvrirDb } from "../src/db.mjs"
import { ecrireReglage, lireReglage, ouvrirCouts } from "../src/couts.mjs"
import { RETABLI_MS, choisirAction, classerPanne, deciderPilote, etatPilote, lireMemoirePilote, passagePilote, reglagesPilote, reglerPilote, signalPanne } from "../src/pilote.mjs"

const MIN = 60_000
const T0 = Date.parse("2026-11-18T10:00:00Z")
const reglages = { mode: "proposer", minutes: 10 }
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

test("une panne du code de 10 minutes : une seule proposition, rien avant", () => {
  const { passages, memoire } = derouler(fois(14, { "production/vigie": boucle }))
  const toutes = passages.flat()
  assert.equal(toutes.length, 1, "une seule décision pour toute la panne")
  assert.equal(passages.findIndex((d) => d.length), 10, "décidée au bout de 10 minutes, pas avant")
  assert.equal(toutes[0].type, "proposer")
  assert.equal(toutes[0].projet.id, 8)
  assert.equal(memoire.incidents["production/vigie"].decision, "proposer")
})

test("en observation : il dit ce qu'il aurait proposé", () => {
  const { passages } = derouler(fois(12, { "production/vigie": boucle }), { regl: { ...reglages, mode: "observer" } })
  assert.deepEqual(passages.flat().map((d) => d.type), ["observer"])
})

test("coupé : rien du tout ; un aperçu en panne n'est jamais l'affaire du pilote", () => {
  assert.equal(derouler(fois(12, { "production/vigie": boucle }), { regl: { ...reglages, mode: "coupe" } }).passages.flat().length, 0)
  assert.equal(derouler(fois(12, { "apercu/vigie": boucle })).passages.flat().length, 0)
})

test("une cause hors du code, ou une cause inconnue : une personne, une seule fois", () => {
  const oom = { ...boucle, docker: { ...boucle.docker, oom: true } }
  const { passages } = derouler(fois(15, { "production/vigie": oom }))
  assert.deepEqual(passages.flat().map((d) => [d.type, d.classe]), [["humain", "serveur"]])
  // Deux applications en panne à la fois : cause commune, deux messages, aucune proposition.
  const deux = derouler(fois(11, { "production/vigie": boucle, "production/acte": boucle }), { proj: { ...projets, acte: { id: 9, nom: "Acte Clair", statut: "en_production" } } })
  assert.deepEqual(deux.passages.flat().map((d) => d.type), ["humain", "humain"])
})

test("un projet déjà en travail : noté une fois, puis revu quand il est de nouveau en production", () => {
  const enTravail = { vigie: { ...projets.vigie, statut: "corrections" } }
  const a = derouler(fois(13, { "production/vigie": boucle }), { proj: enTravail })
  assert.deepEqual(a.passages.flat().map((d) => d.type), ["deja"])
  // La correction est mise en ligne (nouvelle version), et la panne continue : le pilote la revoit.
  const b = derouler(fois(11, { "production/vigie": { ...boucle, version: "ffff00001111" } }), { memoire: a.memoire, debut: T0 + 13 * MIN })
  assert.deepEqual(b.passages.flat().map((d) => d.type), ["proposer"])
})

test("une version qui attend sa mise en ligne : une personne, pas une proposition", () => {
  const { passages } = derouler(fois(11, { "production/vigie": boucle }), { proj: { vigie: { ...projets.vigie, statut: "livre" } } })
  assert.equal(passages.flat()[0].type, "humain")
  assert.match(passages.flat()[0].pourquoi, /attend sa mise en ligne/)
})

test("choisirAction : sans projet, une personne ; en production, proposer ou observer selon le mode", () => {
  const base = { classe: "code", pourquoi: "x", projet: projets.vigie, reglages }
  assert.equal(choisirAction(base).type, "proposer")
  assert.equal(choisirAction({ ...base, reglages: { ...reglages, mode: "observer" } }).type, "observer")
  assert.equal(choisirAction({ ...base, projet: null }).type, "humain")
  assert.equal(choisirAction({ ...base, projet: { ...projets.vigie, statut: "mise_en_production" } }).type, "deja")
  assert.equal(choisirAction({ ...base, projet: { ...projets.vigie, statut: "bloque" } }).type, "humain")
})

test("une mémoire illisible : les pannes sont oubliées, et le journal le dit", async () => {
  const db = ouvrirDb(":memory:")
  ouvrirCouts(db)
  ecrireReglage(db, "pilote_memoire", "{pas du json")
  assert.deepEqual(lireMemoirePilote(db), { incidents: {}, illisible: true })
  // Une ligne abîmée est écartée, le reste est gardé.
  ecrireReglage(db, "pilote_memoire", JSON.stringify({ incidents: { "production/vigie": { depuis: "hier" }, "production/acte": { depuis: T0 } } }))
  assert.deepEqual(Object.keys(lireMemoirePilote(db).incidents), ["production/acte"])
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
  assert.equal(retour[0].incident.decision, "proposer")
  assert.equal(c.memoire.incidents["production/vigie"], undefined)
  assert.ok(RETABLI_MS === 30 * MIN)
})

test("le signal d'une panne : ce que voit la sonde, une seule clé par application, rien d'autre", () => {
  const s = signalPanne({ produit: "vigie", nom: "Vigie Copro", depuis: T0, panne: boucle, pourquoi: "l'application s'arrête à chaque démarrage" }, T0 + 12 * MIN)
  assert.deepEqual([s.source, s.produit, s.cle], ["sonde", "vigie", "panne:vigie"])
  assert.match(s.titre, /en panne depuis 12 min, l'application s'arrête à chaque démarrage/)
  assert.deepEqual(s.detail, { raison: boucle.raison, version: "a1b2c3d4e5f6", conteneur: "restarting", redemarrages_30_min: 4, code_sortie: 1 })
})

test("le pilote ne peut ni demander une correction, ni mettre en ligne", () => {
  const source = readFileSync(new URL("../src/pilote.mjs", import.meta.url), "utf8")
  assert.doesNotMatch(source, /demanderCorrections|lancerProposition|mettreEnProduction|ecrireEtat|production_reglages|ctx\.livraison|from "\.\/livraison\.mjs"|from "\.\/propositions\.mjs"/)
  // index.mjs ne lui donne que proposer().
  assert.match(readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8"), /demarrerPilote\(ctx, \{ proposer \}\)/)
})

test("réglages : le mode de la console passe avant le contrat ; l'ancien « corriger » devient « proposer »", () => {
  const db = ouvrirDb(":memory:")
  ouvrirCouts(db)
  assert.deepEqual(reglagesPilote({}, db), { mode: "observer", minutes: 10 })
  assert.equal(reglagesPilote({ pilote: { mode: "proposer" } }, db).mode, "proposer")
  assert.equal(reglagesPilote({ pilote: { mode: "corriger" } }, db).mode, "proposer", "rien ne part plus sans une personne")
  ecrireReglage(db, "pilote_mode", "coupe")
  assert.equal(reglagesPilote({ pilote: { mode: "proposer" } }, db).mode, "coupe")
  ecrireReglage(db, "pilote_mode", "corriger")
  assert.equal(reglagesPilote({}, db).mode, "proposer")
  ecrireReglage(db, "pilote_mode", "n'importe quoi")
  assert.equal(reglagesPilote({}, db).mode, "observer")
  assert.deepEqual(reglagesPilote({ pilote: { minutes_avant_action: 0 } }), { mode: "observer", minutes: 3 })
})

// Un passage réel : sante.json sur disque, une base, une fausse boucle d'amélioration et un faux Slack.
function essai({ mode = "proposer" } = {}) {
  const dossier = mkdtempSync(join(tmpdir(), "pilote-"))
  const db = ouvrirDb(":memory:")
  ouvrirCouts(db)
  db.prepare("INSERT INTO projets (prompt, statut, nom, slug) VALUES ('p', 'en_production', 'Vigie Copro', 'vigie')").run()
  ecrireReglage(db, "pilote_mode", mode)
  const signaux = []
  const messages = []
  const ctx = { config: { dataDir: dossier, etatDir: dossier }, db, notifier: { alerte: async (texte) => messages.push(texte) } }
  const boucleAmelioration = { reponse: async () => ({ action: "creer", id: 1 }) }
  const proposer = async (_ctx, signal) => (signaux.push(signal), boucleAmelioration.reponse())
  const sonde = (maintenant, produit) => writeFileSync(join(dossier, "sante.json"), JSON.stringify({ le: new Date(maintenant).toISOString(), applications: { le: new Date(maintenant).toISOString(), produits: { "production/vigie": produit } } }))
  const passer = (maintenant) => passagePilote(ctx, { maintenant, proposer })
  return { ctx, db, signaux, messages, sonde, dossier, boucleAmelioration, passer }
}

test("un passage complet : le signal part une fois, et tout est au journal", async () => {
  const e = essai()
  for (let i = 0; i <= 12; i++) {
    e.sonde(T0 + i * MIN, boucle)
    await e.passer(T0 + i * MIN)
  }
  assert.equal(e.signaux.length, 1)
  assert.deepEqual([e.signaux[0].cle, e.signaux[0].detail.raison], ["panne:vigie", boucle.raison])
  const journal = e.db.prepare("SELECT type, message FROM journal WHERE type = 'pilote'").all()
  assert.equal(journal.length, 1)
  assert.match(journal[0].message, /^Correction proposée : Vigie Copro est en panne en ligne depuis 10 min\. L'application s'arrête à chaque démarrage\. Elle attend une décision \(proposition n° 1\)\.$/)
  assert.equal(e.messages.length, 0, "la proposition s'annonce elle-même")
  // La console voit la panne ouverte et la décision.
  const vu = etatPilote(e.ctx, T0 + 12 * MIN)
  assert.equal(vu.mode, "proposer")
  assert.deepEqual(vu.pannes.map((p) => [p.nom, p.decision]), [["Vigie Copro", "proposer"]])
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

test("une proposition impossible : une personne est prévenue", async () => {
  const e = essai()
  e.boucleAmelioration.reponse = async () => { throw new Error("base verrouillée") }
  for (let i = 0; i <= 10; i++) {
    e.sonde(T0 + i * MIN, boucle)
    await e.passer(T0 + i * MIN)
  }
  assert.equal(e.messages.length, 1)
  assert.match(e.messages[0], /n'a pas pu en faire une proposition : base verrouillée/)
})

test("en observation, un message ; passer en « proposer » pendant la panne en fait une proposition", async () => {
  const e = essai({ mode: "observer" })
  for (let i = 0; i <= 10; i++) {
    e.sonde(T0 + i * MIN, boucle)
    await e.passer(T0 + i * MIN)
  }
  assert.equal(e.signaux.length, 0)
  assert.equal(e.messages.length, 1)
  assert.match(e.messages[0], /observation.*aurait proposé une correction.*Rien n'a été créé/s)
  assert.match(reglerPilote(e.ctx, "proposer", "admin@exemple.test").message, /Rien ne part sans toi/)
  e.sonde(T0 + 11 * MIN, boucle)
  await e.passer(T0 + 11 * MIN)
  assert.equal(e.signaux.length, 1)
  assert.match(e.db.prepare("SELECT message FROM journal WHERE type = 'reglage'").get().message, /Pannes et erreurs des applications en ligne : proposer une correction \(par admin@exemple\.test\)/)
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
