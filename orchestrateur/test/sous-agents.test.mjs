// Les sous-agents d'un passage de l'agent : le résumé du flux stream-json (aussi exécuté tel quel
// dans un vrai processus Node, comme dans l'atelier), et la table agents_tache.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { codeResume, noterPassage, ouvrirAgentsTache, resumerFlux, scriptResume } from "../src/sous-agents.mjs"

const ligne = (x) => JSON.stringify(x)
const message = (id, model, content, parent = null) => ligne({ type: "assistant", parent_tool_use_id: parent, message: { id, model, content } })
// Un passage : l'agent (Sonnet) lance un sous-agent Explore (Haiku), puis un autre par l'outil « Agent ».
const FLUX = [
  ligne({ type: "system", subtype: "init", model: "claude-sonnet-5-5", tools: ["Task", "Bash"] }),
  message("m1", "claude-sonnet-5-5", [{ type: "text", text: "Je regarde le dépôt." }]),
  // Le même message livré en deux évènements (un par bloc) : un seul tour.
  message("m1", "claude-sonnet-5-5", [{ type: "tool_use", id: "toolu_1", name: "Task", input: { subagent_type: "Explore", description: "Trouver   les routes\nde l'API", prompt: "…", model: "haiku" } }]),
  message("s1", "claude-haiku-4-5", [{ type: "tool_use", id: "toolu_x", name: "Grep", input: { pattern: "router" } }], "toolu_1"),
  message("s2", "claude-haiku-4-5", [{ type: "text", text: "Trois routes." }], "toolu_1"),
  ligne({ type: "user", parent_tool_use_id: "toolu_1", message: { content: [{ type: "tool_result", tool_use_id: "toolu_x", content: "…" }] } }),
  message("m2", "claude-sonnet-5-5", [{ type: "tool_use", id: "toolu_2", name: "Agent", input: { description: "Écrire les tests" } }, { type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "npm test" } }]),
  message("s3", "claude-sonnet-5-5", [{ type: "tool_use", id: "toolu_y", name: "Write", input: {} }, { type: "tool_use", id: "toolu_z", name: "Bash", input: {} }], "toolu_2"),
  "{coupée",
  "texte libre",
  ligne({ type: "result", modelUsage: { "claude-sonnet-5-5": {}, "claude-haiku-4-5": {} } }),
].join("\n")

const ATTENDU = {
  modele: "claude-sonnet-5-5",
  principal: { modeles: ["claude-sonnet-5-5"], tours: 2, outils: 3 },
  sous_agents: [
    { type: "Explore", description: "Trouver les routes de l'API", modele_demande: "haiku", lance_par: "agent", modeles: ["claude-haiku-4-5"], tours: 2, outils: 1 },
    { type: "general-purpose", description: "Écrire les tests", modele_demande: null, lance_par: "agent", modeles: ["claude-sonnet-5-5"], tours: 1, outils: 2 },
  ],
}

test("le résumé d'un flux : l'agent, ses modèles, ses sous-agents", () => {
  assert.deepEqual(resumerFlux(FLUX), ATTENDU)
})

test("un flux vide, illisible ou sans sous-agent", () => {
  assert.deepEqual(resumerFlux(""), { modele: null, principal: { modeles: [], tours: 0, outils: 0 }, sous_agents: [] })
  assert.deepEqual(resumerFlux(null).sous_agents, [])
  assert.deepEqual(resumerFlux("{]\n[]\n42").principal.tours, 0)
  // Un sous-agent dont l'appel n'a pas été vu (flux coupé) : il compte, de type inconnu.
  const r = resumerFlux(message("s1", "claude-haiku-4-5", [], "toolu_perdu"))
  assert.deepEqual(r.sous_agents.map((s) => [s.type, s.modeles]), [["inconnu", ["claude-haiku-4-5"]]])
  // Au plus 50 sous-agents, et des textes bornés.
  const beaucoup = Array.from({ length: 80 }, (_, i) => message(`m${i}`, "x", [{ type: "tool_use", id: `t${i}`, name: "Task", input: { subagent_type: "y".repeat(500), description: "d".repeat(500) } }])).join("\n")
  const b = resumerFlux(beaucoup)
  assert.equal(b.sous_agents.length, 50)
  assert.ok(b.sous_agents.every((s) => s.type.length <= 60 && s.description.length <= 120))
})

test("le script de l'atelier : le même résumé, calculé par un vrai Node", () => {
  const r = spawnSync(process.execPath, ["-e", codeResume()], { input: FLUX, encoding: "utf8" })
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), ATTENDU)
  const s = scriptResume("/tmp/sorties/tache/agent.jsonl", "/tmp/sorties/tache/agents.json")
  assert.match(s, /base64 -d > '\/tmp\/sorties\/tache\/resume-agents\.cjs'/)
  // Il ne fait jamais échouer le travail.
  assert.match(s, /node '\/tmp\/sorties\/tache\/resume-agents\.cjs' < '\/tmp\/sorties\/tache\/agent\.jsonl' > '\/tmp\/sorties\/tache\/agents\.json' 2>\/dev\/null \|\| true$/)
})

test("la table agents_tache : une ligne pour l'agent, une par sous-agent, tout borné", () => {
  const db = new DatabaseSync(":memory:")
  ouvrirAgentsTache(db)
  ouvrirAgentsTache(db) // deux fois sans erreur (chaque démarrage)
  assert.equal(noterPassage(db, { projet: 1, tache: 7, tentative: 1, approche: 0, resume: ATTENDU }), true)
  const lignes = db.prepare("SELECT tache_id, role, tentative, principal, type, modele_demande, modeles, tours, outils FROM agents_tache ORDER BY id").all().map((x) => ({ ...x }))
  assert.deepEqual(lignes, [
    { tache_id: 7, role: "agent", tentative: 1, principal: 1, type: null, modele_demande: null, modeles: '["claude-sonnet-5-5"]', tours: 2, outils: 3 },
    { tache_id: 7, role: "agent", tentative: 1, principal: 0, type: "Explore", modele_demande: "haiku", modeles: '["claude-haiku-4-5"]', tours: 2, outils: 1 },
    { tache_id: 7, role: "agent", tentative: 1, principal: 0, type: "general-purpose", modele_demande: null, modeles: '["claude-sonnet-5-5"]', tours: 1, outils: 2 },
  ])
  // Rien à noter sans résumé ; un résumé mal formé est borné, jamais recopié tel quel.
  for (const r of [null, "texte", [], 42]) assert.equal(noterPassage(db, { projet: 1, tache: 8, resume: r }), false)
  noterPassage(db, { projet: 1, tache: 9, tentative: "x", resume: { modele: "m".repeat(500), principal: { tours: -5, outils: "beaucoup" }, sous_agents: [{ type: { objet: 1 }, description: "d".repeat(900), modeles: ["a", 3, null, "b".repeat(200)] }, "pas un objet"] } })
  const [p, s] = db.prepare("SELECT tentative, type, description, modeles, tours, outils FROM agents_tache WHERE tache_id = 9 ORDER BY id").all()
  assert.deepEqual([p.tentative, p.tours, p.outils, JSON.parse(p.modeles)[0].length], [0, 0, 0, 60])
  assert.ok(s.type.length <= 60 && s.description.length === 120)
  assert.deepEqual(JSON.parse(s.modeles).map((x) => x.length), [1, 60])
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM agents_tache WHERE tache_id = 9").get().n, 2)
})
