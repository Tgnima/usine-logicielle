// Les fournisseurs d'IA réglés dans la console : coffre chiffré, jamais une valeur renvoyée,
// ordre des façons, modèles par rôle.
import { test } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { appliquerModeles, chiffrer, dechiffrer, migrerCoffre, protegeParAxmaril, effacerIdentifiant, envFournisseurs, etatFournisseurs, lireMarqueursTest, ordreModes, poserIdentifiant, reglerModeles, reglerModes } from "../src/fournisseurs.mjs"
import { modesDisponibles } from "../src/moteurs.mjs"

const ctxDe = () => {
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)")
  db.exec("CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, projet_id INTEGER, tache_id INTEGER, type TEXT NOT NULL, message TEXT NOT NULL, le TEXT NOT NULL DEFAULT (datetime('now')))")
  return { db, config: { secrets: { worker: "jeton-de-test-du-serveur-de-travaux" }, secours: {}, modeles: { analyste: { moteur: "claude-code", modele: "claude-opus-5-5" }, atelier: { moteur: "claude-code", modele: "claude-sonnet-5-5" } } } }
}
const CLE = "sk-ant-api03-ceci-est-une-fausse-cle-WXYZ"

test("le coffre chiffre et déchiffre ; la base ne contient jamais la valeur en clair", () => {
  const ctx = ctxDe()
  assert.equal(dechiffrer(ctx, chiffrer(ctx, CLE)), CLE)
  poserIdentifiant(ctx, "ANTHROPIC_API_KEY", CLE, "admin@exemple.fr")
  const brut = ctx.db.prepare("SELECT valeur FROM reglages WHERE cle = 'coffre_ANTHROPIC_API_KEY'").get().valeur
  assert.ok(!brut.includes(CLE) && !brut.includes("fausse-cle"))
  // Une base copiée ailleurs (autre worker_token) ne se lit pas.
  const autre = { ...ctx, config: { ...ctx.config, secrets: { worker: "un-autre-jeton" } } }
  assert.throws(() => dechiffrer(autre, JSON.parse(brut)))
})

test("l'état affiché ne renvoie jamais la valeur, seulement ses 4 derniers caractères", () => {
  const ctx = ctxDe()
  poserIdentifiant(ctx, "ANTHROPIC_API_KEY", CLE, "admin@exemple.fr")
  const e = etatFournisseurs(ctx)
  assert.ok(!JSON.stringify(e).includes(CLE.slice(0, -4)))
  const i = e.identifiants.find((x) => x.nom === "ANTHROPIC_API_KEY")
  assert.equal(i.console.fin, "WXYZ")
  assert.equal(i.console.par, "admin@exemple.fr")
  assert.match(ctx.db.prepare("SELECT message FROM journal").get().message, /posée dans la console par admin@exemple.fr/)
})

test("chaque serveur ne reçoit que ses identifiants ; retirer rend la main au serveur", () => {
  const ctx = ctxDe()
  poserIdentifiant(ctx, "ANTHROPIC_API_KEY", CLE, "a")
  poserIdentifiant(ctx, "OPENAI_API_KEY", "sk-proj-fausse-cle-openai-1234", "a")
  poserIdentifiant(ctx, "AI_GATEWAY_API_KEY", "vck_fausse-cle-passerelle-5678", "a")
  assert.deepEqual(Object.keys(envFournisseurs(ctx, "claude-code")).sort(), ["AI_GATEWAY_API_KEY", "ANTHROPIC_API_KEY"])
  assert.deepEqual(Object.keys(envFournisseurs(ctx, "codex")).sort(), ["AI_GATEWAY_API_KEY", "OPENAI_API_KEY"])
  assert.equal(envFournisseurs(ctx, "claude-code").ANTHROPIC_API_KEY, CLE)
  effacerIdentifiant(ctx, "ANTHROPIC_API_KEY", "a")
  assert.equal(envFournisseurs(ctx, "claude-code").ANTHROPIC_API_KEY, undefined)
})

test("une valeur incomplète ou inconnue est refusée", () => {
  const ctx = ctxDe()
  assert.throws(() => poserIdentifiant(ctx, "ANTHROPIC_API_KEY", "court", "a"), /incomplète/)
  assert.throws(() => poserIdentifiant(ctx, "ANTHROPIC_API_KEY", "sk-ant-api03 avec espace", "a"), /incomplète/)
  assert.throws(() => poserIdentifiant(ctx, "GITHUB_TOKEN", "ghp_xxxxxxxxxxxxxxxxxxxx", "a"), /inconnu/)
  assert.match(poserIdentifiant(ctx, "CLAUDE_CODE_OAUTH_TOKEN", "pas-le-bon-prefixe-123456", "a").message, /sk-ant-oat/)
})

test("l'ordre des façons vient de la console, sinon du contrat, et sert aux bascules", () => {
  const ctx = ctxDe()
  assert.deepEqual(ordreModes(ctx, "codex"), ["abonnement", "cle", "passerelle"])
  reglerModes(ctx, "codex", ["passerelle", "abonnement", "inconnu"], "a")
  assert.deepEqual(ordreModes(ctx, "codex"), ["passerelle", "abonnement"])
  assert.deepEqual(modesDisponibles(ctx, "codex"), ["passerelle", "abonnement"])
  assert.deepEqual(ordreModes(ctx, "claude-code"), ["abonnement", "cle", "passerelle"]) // l'autre moteur ne change pas
  assert.throws(() => reglerModes(ctx, "codex", [], "a"), /au moins une/)
})

test("les modèles de la console remplacent ceux du contrat ; vide = le contrat", () => {
  const ctx = ctxDe()
  appliquerModeles(ctx)
  reglerModeles(ctx, { atelier: "claude-opus-5-5", analyste: "" }, "a")
  assert.equal(ctx.config.modeles.atelier.modele, "claude-opus-5-5")
  assert.equal(ctx.config.modeles.analyste.modele, "claude-opus-5-5")
  reglerModeles(ctx, { atelier: "" }, "a")
  assert.equal(ctx.config.modeles.atelier.modele, "claude-sonnet-5-5")
  assert.throws(() => reglerModeles(ctx, { atelier: "rm -rf /" }, "a"), /invalide/)
})

test("le résultat d'un test de connexion est lu par façon", () => {
  const r = lireMarqueursTest({ T_CLAUDE_ABONNEMENT: "ok", T_CLAUDE_CLE: "réponse 401 invalid x-api-key", T_CLAUDE_PASSERELLE: "absent", S_ANTHROPIC_API_KEY: "1" }, "claude-code")
  assert.deepEqual(r.resultats.abonnement, { etat: "ok" })
  assert.equal(r.resultats.cle.etat, "erreur")
  assert.equal(r.resultats.passerelle.etat, "absent")
  assert.deepEqual(r.serveur, { ANTHROPIC_API_KEY: true })
})

const MAITRE = "cle-maitresse-de-test-gardee-dans-axmaril-0123456789abcdef"

test("avec la clé maîtresse d'AXMARIL, le coffre chiffre en v2 et une autre clé ne lit rien", () => {
  const ctx = ctxDe()
  ctx.config.secrets.coffreMaitre = MAITRE
  assert.ok(protegeParAxmaril(ctx))
  const e = chiffrer(ctx, CLE)
  assert.equal(e.v, 2)
  assert.equal(dechiffrer(ctx, e), CLE)
  // Même worker_token, autre clé maîtresse : illisible.
  const autre = { ...ctx, config: { ...ctx.config, secrets: { ...ctx.config.secrets, coffreMaitre: "une-autre-cle-maitresse-0123456789abcdef-xyz" } } }
  assert.throws(() => dechiffrer(autre, e))
})

test("les entrées v1 passent sous la clé maîtresse au démarrage ; sans elle, le coffre est verrouillé", () => {
  const ctx = ctxDe()
  poserIdentifiant(ctx, "ANTHROPIC_API_KEY", CLE, "a") // v1 : clé du serveur
  assert.equal(JSON.parse(ctx.db.prepare("SELECT valeur FROM reglages WHERE cle = 'coffre_ANTHROPIC_API_KEY'").get().valeur).v, 1)
  ctx.config.secrets.coffreMaitre = MAITRE
  assert.equal(migrerCoffre(ctx), 1)
  const e = JSON.parse(ctx.db.prepare("SELECT valeur FROM reglages WHERE cle = 'coffre_ANTHROPIC_API_KEY'").get().valeur)
  assert.equal(e.v, 2)
  assert.equal(e.fin, "WXYZ") // les métadonnées restent
  assert.equal(envFournisseurs(ctx, "claude-code").ANTHROPIC_API_KEY, CLE)
  assert.equal(migrerCoffre(ctx), 0) // rien à refaire
  // L'agent AXMARIL est révoqué : plus de clé maîtresse, plus rien de lisible.
  ctx.config.secrets.coffreMaitre = ""
  assert.equal(envFournisseurs(ctx, "claude-code").ANTHROPIC_API_KEY, undefined)
  assert.equal(etatFournisseurs(ctx).verrouille, true)
  assert.equal(etatFournisseurs(ctx).protection, "serveur")
})
