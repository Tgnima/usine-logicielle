// Les limites d'usage des moteurs : bascule abonnement → clé API → passerelle, sans fausse alerte.
import { test } from "node:test"
import assert from "node:assert/strict"
import { DatabaseSync } from "node:sqlite"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { facturationsEnCours, heureDeReprise, modelePasserelle, modesDisponibles, noterLimites, scriptClaude, scriptCodex, signalerFacturation } from "../src/moteurs.mjs"

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
  assert.equal(modelePasserelle({}, "claude-sonnet-5-5"), "claude-sonnet-5-5")
  assert.equal(modelePasserelle({ secours: { modeles_passerelle: { "claude-sonnet-5-5": "autre" } } }, "claude-sonnet-5-5"), "autre")
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

// Le refus réel de la passerelle quand le compte n'a plus de crédit (relevé le 22/10/2026).
const REFUS_402 = `{"type":"result","subtype":"success","is_error":true,"api_error_status":402,"terminal_reason":"api_error","result":"API Error: 402 A positive credit balance is required for all requests, including BYOK, so fallback providers remain available. Add credits at https://vercel.com/d?to=%2F%5Bteam%5D to continue."}`

// Un faux « claude » : abonnement à sa limite, passerelle sans crédit, clé API qui fonctionne.
function lancerSansCredit(ctx, env) {
  const d = mkdtempSync(join(tmpdir(), "moteurs-"))
  writeFileSync(join(d, "claude"), `#!/bin/sh
if [ -n "$ANTHROPIC_BASE_URL" ]; then echo '${REFUS_402}'; exit 1; fi
if [ -n "$ANTHROPIC_API_KEY" ]; then echo '{"type":"result","is_error":false,"result":"fini avec la clé"}'; exit 0; fi
echo '{"type":"result","is_error":true,"api_error_status":429,"result":"You have hit your session limit · resets 6:40pm (UTC)"}'; exit 1
`)
  chmodSync(join(d, "claude"), 0o755)
  const posix = (p) => (process.platform === "win32" ? p.replace(/^([A-Za-z]):/, (_, l) => `/${l.toLowerCase()}`).replaceAll("\\", "/") : p)
  const script = `set -e\nexport PATH="${posix(d)}:$PATH"\n${scriptClaude(ctx, { args: "-p essai", modele: "claude-sonnet-5-5", sortie: posix(join(d, "sortie.jsonl")) })}`
  return spawnSync("bash", ["-c", script], { env: { ...process.env, ...env }, encoding: "utf8" }).stdout
}
const marqueursDe = (sortie) => Object.fromEntries(sortie.split("\n").map((l) => /^@@ ([A-Z_]+)(?: (.*))?$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2] ?? ""]))

test("passerelle sans crédit (402) : reconnue, jamais prise pour un travail fait", () => {
  const ctx = ctxDe()
  const sortie = lancerSansCredit(ctx, { AI_GATEWAY_API_KEY: "cle-passerelle", ANTHROPIC_API_KEY: "" })
  assert.match(sortie, /@@ LIMITE_ABONNEMENT resets 6:40pm/)
  assert.match(sortie, /@@ FACTURATION_PASSERELLE API Error: 402 A positive credit balance/)
  assert.match(sortie, /@@ EPUISE_CLAUDE/)
  assert.doesNotMatch(sortie, /@@ MODE_CLAUDE/)
  const r = noterLimites(ctx, "claude-code", marqueursDe(sortie))
  // Épuisé : la fabrication se met en pause au lieu de consommer une tentative.
  assert.equal(r.epuise, true)
  assert.deepEqual(r.facturation.map((f) => f.mode), ["passerelle"])
  assert.deepEqual(modesDisponibles(ctx, "claude-code"), ["cle"])
  assert.equal(facturationsEnCours(ctx.db)[0].mode, "passerelle")
  // Le même refus au travail suivant n'est pas signalé une seconde fois.
  assert.deepEqual(noterLimites(ctx, "claude-code", marqueursDe(sortie)).facturation, [])
})

test("passerelle sans crédit mais clé API posée : le travail se fait avec la clé", () => {
  const ctx = ctxDe()
  const sortie = lancerSansCredit(ctx, { AI_GATEWAY_API_KEY: "cle-passerelle", ANTHROPIC_API_KEY: "cle-api" })
  assert.match(sortie, /@@ MODE_CLAUDE cle/)
  assert.doesNotMatch(sortie, /@@ FACTURATION_/)
  assert.doesNotMatch(sortie, /@@ EPUISE_CLAUDE/)
})

test("le crédit revenu : la façon qui sert de nouveau n'est plus marquée sans crédit", () => {
  const ctx = ctxDe()
  noterLimites(ctx, "claude-code", { FACTURATION_PASSERELLE: "API Error: 402", EPUISE_CLAUDE: "" })
  assert.equal(facturationsEnCours(ctx.db).length, 1)
  noterLimites(ctx, "claude-code", { MODE_CLAUDE: "passerelle" })
  assert.equal(facturationsEnCours(ctx.db).length, 0)
})

test("le signal Slack : une alerte par refus, qui dit quoi faire", async () => {
  const alertes = []
  const ctx = { ...ctxDe(), notifier: { alerte: async (t) => alertes.push(t) } }
  await signalerFacturation(ctx, "claude-code", { epuise: true, facturation: [{ mode: "passerelle", message: "API Error: 402 A positive credit balance is required" }] })
  await signalerFacturation(ctx, "claude-code", { epuise: false, facturation: [] })
  assert.equal(alertes.length, 1)
  assert.match(alertes[0], /passerelle refuse les appels, faute de crédit/)
  assert.match(alertes[0], /sans consommer de tentative/)
  assert.match(alertes[0], /Vercel AI Gateway/)
})

test("Codex : un refus de facturation n'est pas pris pour une limite d'usage ni pour un travail fait", () => {
  const d = mkdtempSync(join(tmpdir(), "moteurs-"))
  writeFileSync(join(d, "codex"), `#!/bin/sh
echo '{"type":"error","message":"You exceeded your current quota, please check your plan and billing details. (insufficient_quota)"}'; exit 1
`)
  chmodSync(join(d, "codex"), 0o755)
  const posix = (p) => (process.platform === "win32" ? p.replace(/^([A-Za-z]):/, (_, l) => `/${l.toLowerCase()}`).replaceAll("\\", "/") : p)
  const ctx = ctxDe()
  const script = `export PATH="${posix(d)}:$PATH"\n${scriptCodex(ctx, { args: "essai", journal: posix(join(d, "journal.jsonl")) })}`
  const sortie = spawnSync("bash", ["-c", script], { env: { ...process.env, AI_GATEWAY_API_KEY: "", OPENAI_API_KEY: "" }, encoding: "utf8" }).stdout
  assert.match(sortie, /@@ FACTURATION_ABONNEMENT You exceeded your current quota/)
  assert.doesNotMatch(sortie, /@@ LIMITE_ABONNEMENT/)
  assert.match(sortie, /@@ EPUISE_CODEX/)
})
