// Le relais entre moteurs : quand Codex est épuisé, Claude juge à sa place, dans le même travail.
import { test } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bilanJuge, modesDisponibles, relais, scriptJuge } from "../src/moteurs.mjs"
import { reglerRelais } from "../src/fournisseurs.mjs"

const ctxDe = (config = {}) => {
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)")
  db.exec("CREATE TABLE journal (id INTEGER PRIMARY KEY, projet_id INTEGER, tache_id INTEGER, type TEXT, message TEXT, le TEXT DEFAULT CURRENT_TIMESTAMP)")
  return { db, config: { secours: {}, modeles: { renfort: { modele: "claude-opus-5-5" } }, ...config } }
}
const posix = (p) => (process.platform === "win32" ? p.replace(/^([A-Za-z]):/, (_, l) => `/${l.toLowerCase()}`).replaceAll("\\", "/") : p)
const marqueursDe = (sortie) => Object.fromEntries(sortie.split("\n").map((l) => /^@@ ([A-Z_]+)(?: (.*))?$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2] ?? ""]))

// Le refus réel de la passerelle Vercel sans crédit, vu par Codex (2 nov. 2026).
const REFUS_CODEX = `{"type":"error","message":"A positive credit balance is required for all requests, including BYOK. 402 insufficient_funds"}`

// Codex : l'abonnement à sa limite, la passerelle sans crédit. Claude : répond par un verdict.
function lancer(ctx, role, { claudeRepond = true } = {}) {
  const d = mkdtempSync(join(tmpdir(), "relais-"))
  writeFileSync(join(d, "codex"), `#!/bin/sh
if echo "$*" | grep -q passerelle; then echo '${REFUS_CODEX}'; exit 1; fi
echo '{"type":"error","message":"You have hit your usage limit. Try again at 3pm (UTC)."}'; exit 1
`)
  writeFileSync(join(d, "claude"), claudeRepond
    ? `#!/bin/sh\ncat > /dev/null\necho '{"type":"result","is_error":false,"result":"{\\"decision\\":\\"approuve\\"}","modelUsage":{}}'\n`
    : `#!/bin/sh\necho '{"type":"result","is_error":true,"api_error_status":429,"result":"session limit · resets 11pm (UTC)"}'; exit 1\n`)
  chmodSync(join(d, "codex"), 0o755)
  chmodSync(join(d, "claude"), 0o755)
  writeFileSync(join(d, "consigne.md"), "Juge.")
  const texte = join(d, "verdict.txt")
  const script = `set -e\nexport PATH="${posix(d)}:$PATH"\n${scriptJuge(ctx, role, { texte: posix(texte), entree: posix(join(d, "consigne.md")), journal: posix(join(d, "codex.log")), sortieClaude: posix(join(d, "claude.json")), marqueur: "CODEX_CODE" })}`
  // Par un fichier : sous Windows, « bash -c » reçoit mal un long script plein de guillemets.
  writeFileSync(join(d, "script.sh"), script)
  const r = spawnSync("bash", [posix(join(d, "script.sh"))], { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "jeton", AI_GATEWAY_API_KEY: "cle-passerelle", ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "" }, encoding: "utf8" })
  return { sortie: r.stdout, verdict: existsSync(texte) ? readFileSync(texte, "utf8") : null }
}

test("le relais par défaut : Codex juge d'abord, Claude ensuite", () => {
  const ctx = ctxDe()
  assert.deepEqual(relais(ctx, "verification"), ["codex", "claude-code"])
  assert.deepEqual(relais(ctx, "design"), ["codex", "claude-code"])
  assert.deepEqual(relais(ctxDe({ relais: { verification: ["claude-code"] } }), "verification"), ["claude-code"])
})

test("Codex épuisé (limite et crédit) : Claude rend le verdict dans le même travail", async () => {
  const ctx = ctxDe()
  const { sortie, verdict } = lancer(ctx, "verification")
  assert.match(sortie, /@@ LIMITE_CODEX_ABONNEMENT/)
  assert.match(sortie, /@@ FACTURATION_CODEX_PASSERELLE/)
  assert.match(sortie, /@@ CODEX_CODE_MOTEUR claude-code/)
  assert.doesNotMatch(sortie, /@@ CODEX_CODE_EPUISE/)
  assert.equal(JSON.parse(verdict).decision, "approuve")
  const b = await bilanJuge(ctx, "verification", marqueursDe(sortie), "CODEX_CODE")
  assert.equal(b.moteur, "claude-code")
  assert.equal(b.epuise, false)
  // Les limites de Codex sont retenues : le travail suivant ne le retente pas d'ici là.
  assert.deepEqual(modesDisponibles(ctx, "codex"), ["cle"])
  // Celles de Claude ne sont pas touchées par celles de Codex.
  assert.deepEqual(modesDisponibles(ctx, "claude-code"), ["abonnement", "cle", "passerelle"])
})

test("tous les moteurs du relais épuisés : épuisé, sans faux verdict", async () => {
  const ctx = ctxDe()
  const { sortie, verdict } = lancer(ctx, "verification", { claudeRepond: false })
  assert.match(sortie, /@@ CODEX_CODE_EPUISE/)
  assert.match(sortie, /@@ LIMITE_CLAUDE_ABONNEMENT/)
  assert.ok(!verdict)
  const b = await bilanJuge(ctx, "verification", marqueursDe(sortie), "CODEX_CODE")
  assert.equal(b.epuise, true)
  assert.ok(b.reprise instanceof Date)
})

test("un relais réduit à Codex : la pause, comme avant", async () => {
  const ctx = ctxDe()
  reglerRelais(ctx, "verification", ["codex"], "test")
  const { sortie } = lancer(ctx, "verification")
  assert.match(sortie, /@@ CODEX_CODE_EPUISE/)
  assert.doesNotMatch(sortie, /MOTEUR claude-code/)
})

test("le réglage du relais refuse un rôle ou une liste vide", () => {
  const ctx = ctxDe()
  assert.throws(() => reglerRelais(ctx, "inconnu", ["codex"], "test"), /Rôle inconnu/)
  assert.throws(() => reglerRelais(ctx, "design", ["autre"], "test"), /au moins une IA/)
  reglerRelais(ctx, "design", ["claude-code", "codex", "claude-code"], "test")
  assert.deepEqual(relais(ctx, "design"), ["claude-code", "codex"])
})
