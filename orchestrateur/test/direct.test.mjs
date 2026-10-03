// Le direct de la console : évènements de l'agent et du vérificateur en lignes lisibles, secrets masqués.
import { test } from "node:test"
import assert from "node:assert/strict"
import { lignesAgent, lignesCodex, masquer } from "../src/direct.mjs"

test("les évènements de Claude Code deviennent des lignes lisibles", () => {
  const brut = [
    '{"type":"system","subtype":"init","model":"claude-sonnet-5-5"}',
    '{"type":"assistant","message":{"content":[{"type":"text","text":"Je commence par lire le plan."},{"type":"tool_use","name":"Read","input":{"file_path":"/travail/prospecta/depot/docs/PLAN.md"}}]}}',
    '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Edit","input":{"file_path":"/travail/prospecta/depot/client/src/App.jsx"}},{"type":"tool_use","name":"Bash","input":{"command":"npm run verify"}}]}}',
    '{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"1 test échoue"}]}}',
    'ligne coupée {"type":"assi',
    '{"type":"result","is_error":false,"num_turns":12,"duration_ms":420000,"result":"Coque refaite, tests verts."}',
  ].join("\n")
  const l = lignesAgent(brut)
  assert.deepEqual(l.map((x) => x.type), ["info", "pensee", "lecture", "ecriture", "commande", "erreur", "fin"])
  assert.equal(l[2].texte, "lit docs/PLAN.md")
  assert.equal(l[3].texte, "modifie client/src/App.jsx")
  assert.equal(l[4].texte, "$ npm run verify")
  assert.match(l[6].texte, /12 tours, 7 min/)
})

test("les évènements de Codex aussi (format récent et ancien)", () => {
  const brut = [
    '{"type":"item.started","item":{"type":"command_execution","command":"bash -lc \'curl -s localhost:4100/api/health\'"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"Le critère 2 est tenu."}}',
    '{"msg":{"type":"exec_command_begin","command":["npx","playwright","test"]}}',
  ].join("\n")
  assert.deepEqual(lignesCodex(brut).map((x) => x.texte), ["$ bash -lc 'curl -s localhost:4100/api/health'", "Le critère 2 est tenu.", "$ npx playwright test"])
})

test("les secrets sont masqués", () => {
  const t = masquer("GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123 · api_key: abcd1234efgh · sk-ant-api03-xxxxxxxxxxxxxxxx · mot monsecretlong", ["monsecretlong"])
  assert.ok(!/ghp_|abcd1234|sk-ant|monsecretlong/.test(t), t)
  assert.match(t, /api_key: •••/)
})
