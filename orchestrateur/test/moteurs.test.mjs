// Les limites d'usage des moteurs : bascule abonnement → clé API → passerelle, sans fausse alerte.
import { test } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { heureDeReprise, modelePasserelle, modesDisponibles, noterLimites, scriptClaude } from "../src/moteurs.mjs"

const ctxDe = () => {
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)")
  return { db, config: { secours: {} } }
}

test("l'heure de reprise est lue dans le message", () => {
  const t = new Date("2026-10-05T11:28:00Z")
  assert.equal(heureDeReprise("You've hit your session limit · resets 12:40pm (UTC)", t).toISOString(), "2026-10-05T12:42:00.000Z")
  assert.equal(heureDeReprise("resets 3am (UTC)", t).toISOString(), "2026-10-06T03:02:00.000Z")
  assert.equal(heureDeReprise("try again in 2 hours", t).toISOString(), "2026-10-05T13:30:00.000Z")
  assert.equal(heureDeReprise("rien de lisible", t).toISOString(), "2026-10-05T11:58:00.000Z")
})

test("une façon épuisée n'est plus tentée jusqu'à sa reprise", () => {
  const ctx = ctxDe()
  assert.deepEqual(modesDisponibles(ctx, "claude-code"), ["abonnement", "cle", "passerelle"])
  const r = noterLimites(ctx, "claude-code", { LIMITE_ABONNEMENT: "resets 11pm (UTC)", MODE_CLAUDE: "passerelle" })
  assert.equal(r.mode, "passerelle")
  assert.equal(r.epuise, false)
  assert.deepEqual(modesDisponibles(ctx, "claude-code"), ["cle", "passerelle"])
  assert.deepEqual(modesDisponibles(ctx, "codex"), ["abonnement", "cle", "passerelle"])
  assert.equal(noterLimites(ctx, "claude-code", { EPUISE_CLAUDE: "" }).epuise, true)
})

test("le nom d'un modèle sur la passerelle", () => {
  assert.equal(modelePasserelle({}, "claude-sonnet-5-5"), "anthropic/claude-sonnet-5.5")
  assert.equal(modelePasserelle({}, "anthropic/claude-opus-5.5"), "anthropic/claude-opus-5.5")
})

// Un faux « claude » : l'abonnement est épuisé, la passerelle répond ; il écrit un résultat « stream-json ».
function lancerAvecFauxClaude(ctx, env) {
  const d = mkdtempSync(join(tmpdir(), "moteurs-"))
  writeFileSync(join(d, "claude"), `#!/bin/sh
if [ -n "$ANTHROPIC_BASE_URL" ]; then echo '{"type":"assistant","message":{"content":[{"type":"text","text":"je code un rate limit"}]}}'; echo '{"type":"result","is_error":false,"result":"fini"}'; exit 0; fi
echo '{"type":"result","is_error":true,"api_error_status":429,"result":"You have hit your session limit · resets 12:40pm (UTC)"}'; exit 1
`)
  chmodSync(join(d, "claude"), 0o755)
  // Les chemins vus par bash (sous Windows, Git Bash attend /c/…).
  const posix = (p) => (process.platform === "win32" ? p.replace(/^([A-Za-z]):/, (_, l) => `/${l.toLowerCase()}`).replaceAll("\\", "/") : p)
  const script = `set -e\nexport PATH="${posix(d)}:$PATH"\n${scriptClaude(ctx, { args: "-p essai", modele: "claude-sonnet-5-5", sortie: posix(join(d, "sortie.jsonl")) })}`
  const r = spawnSync("bash", ["-c", script], { env: { ...process.env, ...env }, encoding: "utf8" })
  return { sortie: r.stdout, fichier: readFileSync(join(d, "sortie.jsonl"), "utf8") }
}

test("abonnement épuisé : bascule sur la passerelle dans le même travail, même sous set -e", () => {
  const ctx = ctxDe()
  const { sortie, fichier } = lancerAvecFauxClaude(ctx, { AI_GATEWAY_API_KEY: "cle-passerelle", ANTHROPIC_API_KEY: "" })
  assert.match(sortie, /@@ LIMITE_ABONNEMENT resets 12:40pm/)
  assert.match(sortie, /@@ MODE_CLAUDE passerelle/)
  assert.match(fichier, /"result":"fini"/)
  const r = noterLimites(ctx, "claude-code", Object.fromEntries(sortie.split("\n").map((l) => /^@@ ([A-Z_]+)(?: (.*))?$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2] ?? ""])))
  assert.equal(r.mode, "passerelle")
  assert.deepEqual(modesDisponibles(ctx, "claude-code"), ["cle", "passerelle"])
})

test("rien de disponible : épuisé, sans faux succès", () => {
  const { sortie } = lancerAvecFauxClaude(ctxDe(), { AI_GATEWAY_API_KEY: "", ANTHROPIC_API_KEY: "" })
  assert.match(sortie, /@@ LIMITE_ABONNEMENT/)
  assert.match(sortie, /@@ EPUISE_CLAUDE/)
  assert.doesNotMatch(sortie, /@@ MODE_CLAUDE/)
})
