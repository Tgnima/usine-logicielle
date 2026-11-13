// La boîte (boite.mjs) : les clés de la console pour le déployeur. Absente, clé absente, clé vide,
// liste blanche : le serveur sert tant que la console n'a rien posé.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CLES_BOITE, blocSmtp, lireBoite, valeurBoite, variablesSmtp } from "../boite.mjs"

function avecBoite(contenu, corps) {
  const dossier = mkdtempSync(join(tmpdir(), "boite-"))
  try {
    if (contenu !== undefined) writeFileSync(join(dossier, "deployeur.json"), typeof contenu === "string" ? contenu : JSON.stringify(contenu))
    return corps(dossier)
  } finally {
    rmSync(dossier, { recursive: true, force: true })
  }
}

test("boîte absente ou illisible : rien, le serveur sert", () => {
  avecBoite(undefined, (d) => assert.equal(lireBoite(d), null))
  avecBoite("{pas du json", (d) => assert.equal(lireBoite(d), null))
  avecBoite({ cles: {} }, (d) => assert.equal(lireBoite(d), null)) // sans version
  assert.equal(valeurBoite(null, "SENTRY_DSN", "du-serveur"), "du-serveur")
})

test("clé absente : le serveur ; clé vide : envoi coupé ; clé posée : la console", () => avecBoite({ version: 3, le: "2026-11-13T12:00:00.000Z", cles: { SENTRY_DSN: "", POSTHOG_TOKEN: "phc_de_la_console" } }, (d) => {
  const b = lireBoite(d)
  assert.equal(b.version, 3)
  assert.equal(valeurBoite(b, "SENTRY_DSN", "du-serveur"), "", "une clé vide coupe l'envoi, même avec la valeur du serveur")
  assert.equal(valeurBoite(b, "POSTHOG_TOKEN", "du-serveur"), "phc_de_la_console")
  assert.equal(valeurBoite(b, "POSTHOG_HOTE", "eu.i.posthog.com"), "eu.i.posthog.com")
}))

test("liste blanche : une clé inconnue, une valeur sur plusieurs lignes ou trop longue sont ignorées", () => avecBoite({ version: 1, cles: { SENTRY_DSN: "https://a@b.de.sentry.io/1\nX=1", GITHUB_TOKEN: "ghs_jamais", SLACK_BOT_TOKEN: "xoxb-jamais", POSTHOG_TOKEN: "x".repeat(5000), POSTHOG_HOTE: 42 } }, (d) => {
  const b = lireBoite(d)
  assert.deepEqual(b.cles, {})
  for (const jamais of ["SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "AI_GATEWAY_API_KEY", "COFFRE_MAITRE", "WORKER_TOKEN"]) assert.ok(!CLES_BOITE.includes(jamais), jamais)
}))

test("l'envoi d'emails en un bloc : console entière, ou serveur entier, jamais un mélange", () => {
  const serveur = { SMTP_HOST: "smtp.serveur.exemple", SMTP_PORT: "587", SMTP_SECURE: "", EMAIL_EXPEDITEUR: "usine@serveur.exemple", SMTP_USER: "u-serveur", SMTP_PASS: "p-serveur" }
  assert.deepEqual(blocSmtp(null, serveur), serveur)
  assert.deepEqual(blocSmtp({ version: 1, cles: { SENTRY_DSN: "x" } }, serveur), serveur)
  assert.deepEqual(blocSmtp({ version: 2, cles: { SMTP_HOST: "smtp.console.exemple", SMTP_PORT: "465", SMTP_SECURE: "1" } }, serveur), { SMTP_HOST: "smtp.console.exemple", SMTP_PORT: "465", SMTP_SECURE: "1", EMAIL_EXPEDITEUR: "", SMTP_USER: "", SMTP_PASS: "" })
  assert.equal(blocSmtp({ version: 3, cles: { SMTP_HOST: "" } }, serveur).SMTP_HOST, "", "coupé dans la console : pas d'envoi, même avec le serveur")
})

test("emails réels : sans port dans la console, 587 comme l'usine ; jamais le 1025 de Mailpit", () => {
  const serveur = { SMTP_HOST: "", SMTP_PORT: "587", SMTP_SECURE: "", EMAIL_EXPEDITEUR: "", SMTP_USER: "", SMTP_PASS: "" }
  const boite = { version: 4, cles: { SMTP_HOST: "smtp.console.exemple", EMAIL_EXPEDITEUR: "usine@console.exemple", SMTP_USER: "compte", SMTP_PASS: "mot-de-passe-de-test" } }
  assert.deepEqual(variablesSmtp(boite, serveur), { SMTP_HOST: "smtp.console.exemple", SMTP_PORT: "587", EMAIL_EXPEDITEUR: "usine@console.exemple", SMTP_USER: "compte", SMTP_PASS: "mot-de-passe-de-test" })
  // Mailpit et emails réels à la fois : le port de Mailpit ne reste pas sur le vrai serveur d'envoi.
  const v = { SMTP_HOST: "mailpit", SMTP_PORT: "1025", ...variablesSmtp(boite, serveur) }
  assert.equal(v.SMTP_PORT, "587")
  // La sécurité part telle quelle : « 0 » (STARTTLS) aussi.
  assert.equal(variablesSmtp({ version: 5, cles: { SMTP_HOST: "smtp.console.exemple", SMTP_PORT: "465", SMTP_SECURE: "1" } }, serveur).SMTP_SECURE, "1")
  assert.equal(variablesSmtp({ version: 6, cles: { SMTP_HOST: "smtp.console.exemple", SMTP_SECURE: "0" } }, serveur).SMTP_SECURE, "0")
  // Le bloc du serveur, tel qu'il est.
  assert.equal(variablesSmtp(null, { ...serveur, SMTP_HOST: "smtp.serveur.exemple", SMTP_PORT: "2525" }).SMTP_PORT, "2525")
  assert.throws(() => variablesSmtp({ version: 7, cles: { SMTP_HOST: "" } }, { ...serveur, SMTP_HOST: "smtp.serveur.exemple" }), /aucun service d'envoi/, "coupé dans la console : pas d'envoi")
})
