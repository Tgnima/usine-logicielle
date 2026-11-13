// Des chiffres honnêtes (bilan.mjs) : la classe et la signature d'un échec, sur des messages réels
// anonymisés (journal de l'usine, statut.json du déployeur) ; le regroupement, où un échec passager
// suivi d'une réussite ne compte plus ; le seuil des 10 essais ; puis « 7 derniers jours » sur une base
// d'essai à date fixe (semaine d'avant, effectifs, échecs par cause).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SEUIL_COMPARAISON, classeEchec, classerEchec, comparerTaux, regrouperEchecs, signatureEchec } from "../src/bilan.mjs"

// Des messages tels que l'usine les note, anonymisés (produits, sha, numéros, adresses factices).
const MESSAGES = {
  passager: [
    "Error: getaddrinfo EAI_AGAIN api.github.com\n    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:120:26)",
    "Livraison du lot 2 à réessayer : fetch failed",
    "Push impossible : remote: Internal Server Error\nfatal: unable to access 'https://github.com/exemple/prospecta.git/': The requested URL returned error: 500",
    "le déployeur n'a pas appliqué 3f9c2a1 en 15 min",
    "déploiement interrompu 3 fois (le déployeur a redémarré pendant le déploiement) : abandonné. Une nouvelle demande le relancera.",
    "API rate limit exceeded for installation ID 41234567. (403)",
    "Error: connect ETIMEDOUT 203.0.113.7:443",
    "Request failed with status code 503 (Service Unavailable)",
  ],
  environnement: [
    "npm ERR! code ENOSPC npm ERR! syscall write npm ERR! errno -28 ENOSPC: no space left on device, write",
    "le conteneur usine-apercu-prospecta s'est arrêté (exited, code de sortie 137, mémoire dépassée)",
    "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
  ],
  configuration: [
    "Error: Bad credentials",
    "Claude : Invalid API key · Please run /login",
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
    "Pull request de livraison impossible : Resource not accessible by integration (403)",
    "worker_token manquant : le coffre est indisponible.",
    "Mise en production refusée : Emails réels demandés, mais aucun service d'envoi n'est configuré sur le serveur.",
  ],
  code: [
    "Aperçu du lot 1 en échec : l'aperçu ne répond pas à /api/health :\n    at writeFileSync (node:fs:2482:20)",
    "Mise en production en échec : /api/health répond 502",
    "Error: Cannot find module '/app/server/index.js'",
    "TypeError: Cannot read properties of undefined (reading 'lots')\n    at creerDepot (file:///app/src/creation.mjs:52:17)",
    "EACCES: permission denied, open '/app/dist/robots.txt'",
    "Réorientation : L'analyste n'a pas rendu de plan lisible (JSON invalide)",
  ],
}

test("la classe d'un échec : passager, environnement, configuration ou code, sur des messages réels", () => {
  for (const [classe, messages] of Object.entries(MESSAGES)) for (const m of messages) assert.equal(classeEchec(m), classe, m.split("\n")[0])
  // Ce qui suit la première ligne (une pile d'appels) ne change pas la classe.
  assert.equal(classeEchec("TypeError: x is not a function\n    at fetch failed (node:internal)"), "code")
  assert.equal(classeEchec(""), "code")
  assert.equal(classeEchec(null), "code")
})

test("la signature : la même cause d'une fois sur l'autre, sans sha, numéro, adresse ni nom de produit", () => {
  assert.equal(signatureEchec("le déployeur n'a pas appliqué 3f9c2a1 en 15 min"), signatureEchec("le déployeur n'a pas appliqué 8be41d0 en 20 min"))
  assert.equal(signatureEchec("le déployeur n'a pas appliqué 3f9c2a1 en 15 min"), "le déployeur n'a pas appliqué en N min")
  // Le préfixe dit où, pas pourquoi : retiré. La pile d'appels aussi.
  assert.equal(signatureEchec(MESSAGES.code[0]), "l'aperçu ne répond pas à /api/health")
  assert.equal(signatureEchec("Livraison du lot 2 à réessayer : fetch failed"), signatureEchec("Livraison du lot 5 à réessayer : fetch failed"))
  assert.equal(signatureEchec("API rate limit exceeded for installation ID 41234567. (403)"), "API rate limit exceeded for installation ID N. (403)")
  // Les codes HTTP restent : 401 et 502 ne sont pas la même cause.
  assert.notEqual(signatureEchec("GitHub répond 401"), signatureEchec("GitHub répond 502"))
  // Une adresse, une adresse IP, un conteneur, une image, un fichier avec sa ligne, un numéro de PR : effacés.
  const s = signatureEchec("build de usine/vigie-copro:fca2fc0 en échec sur 203.0.113.7 (PR #12, https://github.com/exemple/vigie-copro/pull/12, at server/index.js:41:7)")
  for (const interne of ["vigie-copro", "fca2fc0", "203.0.113", "#12", "github.com", ":41"]) assert.ok(!s.includes(interne), `${interne} dans « ${s} »`)
  assert.equal(signatureEchec("le conteneur usine-apercu-prospecta s'est arrêté (exited, code de sortie 137)"), "l'application s'est arrêté (exited, code de sortie N)")
  // Le nom du produit, donné par l'appelant.
  assert.equal(signatureEchec("Vigie Copro : la vérification de vigie-copro a échoué", { retirer: ["vigie-copro", "Vigie Copro"] }), "la vérification de a échoué")
  // Bornée, jamais vide.
  assert.ok(signatureEchec(`Error: ${"x".repeat(500)}`).length <= 80)
  assert.equal(signatureEchec("Error: "), "autre")
  assert.equal(signatureEchec(undefined), "autre")
  assert.deepEqual(classerEchec("Error: Bad credentials"), { classe: "configuration", signature: "Bad credentials" })
})

test("le regroupement : par cause ; un échec passager suivi d'une réussite ne compte plus, un échec de code si", () => {
  const h = (heures) => Date.parse("2026-11-11T00:00:00Z") + heures * 3600_000
  const echecs = [
    { message: "Livraison du lot 2 à réessayer : fetch failed", le: h(8), projet: 1, nom: "Prospecta" }, // suivi d'une fusion de 1
    { message: "Livraison du lot 3 à réessayer : fetch failed", le: h(9), projet: 2, nom: "Relais" }, // rien après pour 2
    { message: "le déployeur n'a pas appliqué 3f9c2a1 en 15 min", le: h(1), projet: 1, nom: "Prospecta" }, // suivi, la veille ? non : le 11
    { message: "le déployeur n'a pas appliqué 8be41d0 en 20 min", le: h(-30), projet: 1, nom: "Prospecta" }, // le 9, suivi
    { message: "Aperçu du lot 1 en échec : l'aperçu ne répond pas à /api/health", le: h(2), projet: 1, nom: "Prospecta" }, // code, suivi : compte
    { message: "Aperçu du lot 1 en échec : l'aperçu ne répond pas à /api/health", le: h(3), projet: 2, nom: "Relais" },
    { message: "Livraison du lot 1 à réessayer : fetch failed", le: h(4), projet: 3, nom: "Atlas", actuel: true }, // toujours en échec
    { message: "Error: getaddrinfo EAI_AGAIN api.github.com", le: h(5), projet: null, nom: null }, // l'usine : n'importe quelle réussite après
  ]
  const reussites = [{ le: h(10), projet: 1 }, { le: h(11), projet: 3 }]
  const r = regrouperEchecs(echecs, reussites, { jour: (le) => new Date(le).toISOString().slice(0, 10), aujourdhui: "2026-11-11" })
  // Le plus fréquent d'abord ; à égalité, le plus récent.
  assert.deepEqual(r.groupes.map((g) => [g.classe, g.cause, g.n, g.projets]), [
    ["passager", "fetch failed", 2, ["Relais", "Atlas"]],
    ["code", "l'aperçu ne répond pas à /api/health", 2, ["Prospecta", "Relais"]],
  ])
  assert.equal(r.total, 4)
  // Quatre erreurs passagères relancées avec succès, dont trois aujourd'hui.
  assert.deepEqual(r.passageres, { aujourdhui: 3, semaine: 4 })
  assert.equal(r.groupes[1].dernier, h(3))
  // La cause montrée passe par texte() ; deux messages qui se disent pareil vont ensemble.
  const t = regrouperEchecs(echecs.slice(4, 6), [], { texte: () => "l'aperçu ne répond pas" })
  assert.deepEqual(t.groupes.map((g) => [g.cause, g.n]), [["l'aperçu ne répond pas", 2]])
  assert.deepEqual(regrouperEchecs([], []), { total: 0, groupes: [], passageres: { aujourdhui: 0, semaine: 0 } })
})

test("comparer deux semaines : « trop peu pour comparer » sous 10 essais, d'un côté ou de l'autre", () => {
  assert.equal(SEUIL_COMPARAISON, 10)
  const c = comparerTaux({ n: 12, sur: 15 }, { n: 9, sur: 14 })
  assert.deepEqual(c, { actuel: { n: 12, sur: 15, pct: 80 }, avant: { n: 9, sur: 14, pct: 64 }, comparable: true, ecart: 16, seuil: 10 })
  assert.equal(comparerTaux({ n: 9, sur: 9 }, { n: 9, sur: 14 }).comparable, false, "9 essais cette semaine")
  assert.equal(comparerTaux({ n: 9, sur: 14 }, { n: 3, sur: 9 }).comparable, false, "9 essais la semaine d'avant")
  assert.equal(comparerTaux({ n: 5, sur: 10 }, { n: 5, sur: 10 }).comparable, true, "10 essais de chaque côté : on compare")
  assert.equal(comparerTaux({ n: 5, sur: 10 }, { n: 5, sur: 10 }).ecart, 0)
  assert.deepEqual(comparerTaux({ n: 0, sur: 0 }, null), { actuel: { n: 0, sur: 0, pct: null }, avant: { n: 0, sur: 0, pct: null }, comparable: false, ecart: null, seuil: 10 })
  assert.equal(comparerTaux({ n: 3, sur: 4 }, { n: 1, sur: 2 }, 2).comparable, true, "un autre seuil")
})

// --- « 7 derniers jours », sur une base d'essai à date fixe ------------------------------------
// Le 11 novembre 2026 à 16 h 40, heure de Paris : la fenêtre va du 5 au 11, la semaine d'avant du 29 octobre au 4 novembre.
const MAINTENANT = Date.parse("2026-11-11T15:40:00Z")
async function base(nom) {
  const dossier = join(mkdtempSync(join(tmpdir(), "bilan-test-")), nom)
  mkdirSync(dossier)
  const { ouvrirDb } = await import("../src/db.mjs")
  const { ouvrirCouts } = await import("../src/couts.mjs")
  const db = ouvrirDb(join(dossier, "usine.db"))
  ouvrirCouts(db)
  const config = {
    domaine: { base: "exemple.test", https: true }, dataDir: dossier, etatDir: dossier,
    atelier: { url: "http://127.0.0.1:1" }, verificateur: { url: "http://127.0.0.1:1" },
    secrets: { github: "jeton-de-test", worker: "x" }, github: { proprietaire: "essai", depot_etat: "etat" },
    modeles: {}, slack: { canal: "", admins: [] }, perimetre_protege: [], couts: { devise: "USD" }, budget: {},
  }
  return { db, config, dossier }
}
const noter = (b, type, message, le, projet = 1) => b.db.prepare("INSERT INTO journal (projet_id, type, message, le) VALUES (?, ?, ?, ?)").run(projet, type, message, le)

test("7 derniers jours : l'effectif, la semaine d'avant, et le taux comparé seulement au-delà de 10 essais", async () => {
  const b = await base("semaines")
  const { visibilite } = await import("../src/visibilite.mjs")
  b.db.prepare("INSERT INTO projets (id, prompt, statut, nom, slug) VALUES (1, 'p', 'fabrication', 'Prospecta', 'prospecta')").run()
  // Cette semaine : 12 fusions, 3 refus ; la semaine d'avant : 9 fusions, 5 refus, une décision ; plus tôt : ignoré.
  for (let i = 0; i < 12; i++) noter(b, "fusion", `T${i} fusionnée`, "2026-11-10 10:00:00")
  for (let i = 0; i < 3; i++) noter(b, "refus", "T1 refusée (1 motif(s)) : design : trop pâle", "2026-11-09 10:00:00")
  for (let i = 0; i < 9; i++) noter(b, "fusion", `T${i} fusionnée`, "2026-11-02 10:00:00")
  for (let i = 0; i < 5; i++) noter(b, "refus", "T1 refusée (1 motif(s)) : design : trop pâle", "2026-10-29 10:00:00")
  noter(b, "escalade", "T5 : decision", "2026-11-04 22:59:00") // le 4 à 23 h 59 à Paris : la semaine d'avant
  noter(b, "fusion", "T0 fusionnée", "2026-10-28 22:59:00") // le 28 à 23 h 59 : avant la semaine d'avant
  b.db.prepare("INSERT INTO consommations (projet_id, role, moteur, modele, cout_api_usd, duree_s, le) VALUES (1, 'agent', 'claude-code', 'm', ?, ?, ?)").run(4.5, 3600, "2026-11-01 10:00:00")
  const w = visibilite(b, { maintenant: MAINTENANT, processeurs: 1 }).semaine
  assert.deepEqual([w.fusions, w.refus, w.essais], [12, 3, 15])
  const p = w.precedente
  assert.deepEqual([p.du, p.au, p.fusions, p.refus, p.escalades, p.essais, p.acceptes_pct, p.heures], ["2026-10-29", "2026-11-04", 9, 5, 1, 14, 64, 1])
  assert.equal(p.cout_api, 4.5)
  assert.match(p.cout_api_texte, /4,50/)
  assert.deepEqual([w.comparaison.comparable, w.comparaison.actuel.pct, w.comparaison.avant.pct, w.comparaison.ecart], [true, 80, 64, 16])
  // Sous 10 essais cette semaine : trop peu pour comparer.
  b.db.prepare("DELETE FROM journal WHERE type = 'fusion' AND le = '2026-11-10 10:00:00' AND id NOT IN (SELECT id FROM journal WHERE type = 'fusion' AND le = '2026-11-10 10:00:00' LIMIT 6)").run()
  const w2 = visibilite(b, { maintenant: MAINTENANT, processeurs: 1 }).semaine
  assert.deepEqual([w2.essais, w2.comparaison.comparable, w2.comparaison.ecart], [9, false, null])
})

test("7 derniers jours : les échecs par cause, une erreur passagère relancée à part, statut.json sans doublon", async () => {
  const b = await base("echecs")
  const { visibilite } = await import("../src/visibilite.mjs")
  b.db.prepare("INSERT INTO projets (id, prompt, statut, nom, slug) VALUES (1, 'p', 'fabrication', 'Prospecta', 'prospecta'), (2, 'p', 'echec', 'Relais', 'relais'), (3, 'p', 'fabrication', 'Atlas', 'atlas')").run()
  // Prospecta : une erreur réseau, puis une fusion (relancée avec succès, aujourd'hui) ; un aperçu qui ne démarre pas, puis en ligne (du code : compte).
  noter(b, "erreur", "Livraison du lot 2 à réessayer : fetch failed", "2026-11-11 08:00:00", 1)
  noter(b, "fusion", "T4 fusionnée (PR #4, 12 tests)", "2026-11-11 09:00:00", 1)
  noter(b, "livraison", "Aperçu du lot 1 en échec : l'aperçu ne répond pas à /api/health", "2026-11-08 10:00:00", 1)
  noter(b, "livraison", "Aperçu du lot 1 en ligne (abc1234)", "2026-11-08 11:00:00", 1)
  // Relais : la création échoue sur une clé refusée.
  noter(b, "erreur", "Error: Bad credentials", "2026-11-10 10:00:00", 2)
  // Atlas : le déployeur trop lent, deux fois (même cause, sha différents) ; et la même panne d'aperçu.
  noter(b, "livraison", "Aperçu du lot 1 en échec : le déployeur n'a pas appliqué 3f9c2a1 en 15 min", "2026-11-09 10:00:00", 3)
  noter(b, "livraison", "Aperçu du lot 2 en échec : le déployeur n'a pas appliqué 8be41d0 en 15 min", "2026-11-10 10:00:00", 3)
  // Hors fenêtre, ou une réussite d'un autre type : rien.
  noter(b, "erreur", "Error: Bad credentials", "2026-11-01 10:00:00", 2)
  noter(b, "production", "En production (abc1234, blue) validé par a@exemple.test", "2026-11-10 12:00:00", 2)
  // statut.json : l'aperçu d'Atlas est encore en échec (déjà au journal à 10 h : pas de doublon) ; celui de Relais, une cause à part.
  writeFileSync(join(b.dossier, "statut.json"), JSON.stringify({
    "apercu/atlas": { etat: "echec", sha: "8be41d0aaaa", message: "le déployeur n'a pas appliqué 8be41d0 en 15 min", le: "2026-11-10T10:10:00Z" },
    "apercu/relais": { etat: "echec", sha: "fca2fc0bbbb", message: "le conteneur usine-apercu-relais s'est arrêté (exited, code de sortie 137, mémoire dépassée)\n    at attendre (deployeur/server.mjs:310:11)", le: "2026-11-10T16:00:00Z" },
    "production/prospecta": { etat: "ok", sha: "abc1234", le: "2026-11-10T10:00:00Z" },
    "apercu/ancien": { etat: "echec", message: "fetch failed", le: "2026-10-01T10:00:00Z" },
  }))
  const e = visibilite(b, { maintenant: MAINTENANT, processeurs: 1 }).semaine.echecs
  assert.deepEqual(e.groupes.map((g) => [g.classe, g.cause, g.n, g.projets]), [
    ["passager", "le déployeur n'a pas appliqué en N min", 2, ["Atlas"]],
    ["environnement", "l'application s'est arrêté : mémoire dépassée (code N)", 1, ["Relais"]],
    ["configuration", "Bad credentials", 1, ["Relais"]],
    ["code", "l'aperçu ne répond pas", 1, ["Prospecta"]],
  ])
  assert.equal(e.total, 5)
  assert.deepEqual(e.passageres, { aujourdhui: 1, semaine: 1 }, "l'erreur réseau de Prospecta, suivie d'une fusion")
  assert.match(e.groupes[0].dernier, /^2026-11-10T10:00:00/)
  // Rien de ce que le déployeur garde pour lui : ni sha, ni nom de conteneur, ni chemin de fichier.
  const texte = JSON.stringify(e)
  for (const interne of ["8be41d0", "3f9c2a1", "fca2fc0", "usine-apercu", "server.mjs"]) assert.ok(!texte.includes(interne), interne)
})
