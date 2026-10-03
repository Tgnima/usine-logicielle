// Le suivi des coûts : relevés, répartition du coût réel, budgets.
import { test } from "node:test"
import assert from "node:assert/strict"
import { ouvrirDb } from "../src/db.mjs"
import { barre, bilanMois, bilanProjet, budgetProjet, enregistrer, mois, ouvrirCouts, prixApi, reglagesCouts, ecrireReglage, seuilAtteint, usagesClaude, usagesCodex } from "../src/couts.mjs"

const config = {
  couts: { devise: "USD", abonnements: [{ nom: "Claude", mensuel: 100, moteurs: ["claude-code"] }, { nom: "ChatGPT", mensuel: 20, moteurs: ["codex"] }], serveur_mensuel: 30, prix_api: { "gpt-test": { entree: 2, sortie: 8 } } },
  budget: { mensuel: 50, par_projet: 10, alertes: [50, 80, 100] },
}
function base() {
  const db = ouvrirDb(":memory:")
  ouvrirCouts(db)
  db.prepare("INSERT INTO projets (prompt, nom) VALUES ('a', 'Alpha'), ('b', 'Beta')").run()
  return db
}

test("usagesClaude : un relevé par modèle, avec le coût donné par Claude Code", () => {
  const u = usagesClaude({ modelUsage: { "claude-sonnet-5-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40, costUSD: 0.5, canonicalModel: "claude-sonnet-5-5" }, "claude-haiku-4-5": { inputTokens: 1, outputTokens: 2, costUSD: 0.01 } } })
  assert.equal(u.length, 2)
  assert.deepEqual(u[0], { modele: "claude-sonnet-5-5", entree: 10, sortie: 20, cache_lecture: 300, cache_ecriture: 40, cout_api_usd: 0.5 })
})

test("usagesCodex : additionne les tours, sépare le cache, prix d'après la table", () => {
  const journal = [
    '{"type":"thread.started"}',
    '{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":100,"reasoning_output_tokens":50}}',
    '{"type":"turn.completed","usage":{"input_tokens":500,"cached_input_tokens":0,"output_tokens":50}}',
  ].join("\n")
  const [u] = usagesCodex(journal, "gpt-test", config)
  assert.deepEqual({ ...u, cout_api_usd: undefined }, { modele: "gpt-test", entree: 1100, sortie: 200, cache_lecture: 400, cache_ecriture: 0, cout_api_usd: undefined })
  assert.ok(Math.abs(u.cout_api_usd - (1100 * 2 + 200 * 8 + 400 * 0.2) / 1e6) < 1e-12)
  assert.equal(usagesCodex(journal, "inconnu", config)[0].cout_api_usd, null)
  assert.deepEqual(usagesCodex("", "gpt-test", config), [])
})

test("prixApi : accepte un modèle préfixé par son fournisseur", () => {
  assert.equal(prixApi({ couts: { prix_api: { "claude-haiku-4.5": { entree: 1, sortie: 5 } } } }, "anthropic/claude-haiku-4.5", { entree: 1e6, sortie: 1e6 }), 6)
})

test("bilanMois : coût réel = abonnements au prorata de chaque moteur + serveur au prorata du temps", () => {
  const db = base()
  enregistrer(db, { projet: 1, role: "agent", moteur: "claude-code", usages: [{ modele: "s", entree: 1, sortie: 1, cache_lecture: 0, cache_ecriture: 0, cout_api_usd: 3 }], duree_s: 300 })
  enregistrer(db, { projet: 2, role: "agent", moteur: "claude-code", usages: [{ modele: "s", entree: 1, sortie: 1, cache_lecture: 0, cache_ecriture: 0, cout_api_usd: 1 }], duree_s: 100 })
  enregistrer(db, { projet: 2, role: "verificateur", moteur: "codex", usages: [{ modele: "gpt-test", entree: 1e6, sortie: 0, cache_lecture: 0, cache_ecriture: 0, cout_api_usd: null }], duree_s: 0 })
  const b = bilanMois(db, config)
  const alpha = b.projets.find((p) => p.projet_id === 1)
  const beta = b.projets.find((p) => p.projet_id === 2)
  assert.equal(b.api, 4)
  assert.equal(b.reel, 150) // 100 + 20 + 30 : les frais fixes du mois
  assert.ok(Math.abs(alpha.reel - (75 + 22.5)) < 1e-9) // 3/4 de Claude, 3/4 du serveur
  assert.ok(Math.abs(beta.reel - (25 + 20 + 7.5)) < 1e-9) // 1/4 de Claude, tout ChatGPT, 1/4 du serveur
  assert.equal(beta.api_inconnu, true)
})

test("bilanProjet : modèles, rôles, temps", () => {
  const db = base()
  enregistrer(db, { projet: 1, role: "analyste", moteur: "claude-code", usages: [{ modele: "opus", entree: 10, sortie: 10, cache_lecture: 0, cache_ecriture: 0, cout_api_usd: 2 }], duree_s: 60 })
  enregistrer(db, { projet: 1, role: "agent", moteur: "claude-code", usages: [{ modele: "sonnet", entree: 10, sortie: 10, cache_lecture: 0, cache_ecriture: 0, cout_api_usd: 5 }], duree_s: 240 })
  const c = bilanProjet(db, config, 1)
  assert.equal(c.api, 7)
  assert.deepEqual(c.parModele.map((m) => m.modele), ["sonnet", "opus"])
  assert.equal(c.calcul_s, 300)
  assert.equal(bilanProjet(db, config, 2).mesure, false)
})

test("budgets : seuils, supplément de projet, réglages Slack prioritaires", () => {
  assert.equal(seuilAtteint(config, 24, 50), null)
  assert.equal(seuilAtteint(config, 25, 50), 50)
  assert.equal(seuilAtteint(config, 45, 50), 80)
  assert.equal(seuilAtteint(config, 60, 50), 100)
  assert.equal(seuilAtteint(config, 60, 0), null)
  assert.equal(budgetProjet(null, config, { budget_supplement: 5 }), 15)
  const db = base()
  ecrireReglage(db, "couts", JSON.stringify({ budget: { mensuel: 200 } }))
  const c = reglagesCouts(db, config)
  assert.equal(c.budget.mensuel, 200)
  assert.equal(c.budget.par_projet, 10)
  assert.equal(barre(0.5, 10), "▇▇▇▇▇▁▁▁▁▁")
  assert.match(mois(), /^\d{4}-\d{2}$/)
})
