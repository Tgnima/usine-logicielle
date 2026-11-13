// La boîte vers le déployeur (services.mjs) et « Appliquer aux applications » : seulement les clés
// posées ou coupées dans la console, une version à chaque changement, jamais une empreinte des
// valeurs ; le volume n'est monté ni dans l'atelier ni dans le vérificateur.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { appliquerAuxApplications, applicationsEtCles, contenuBoite, couperService, etatServices, poserService, retirerService, versionBoite } from "../src/services.mjs"

const DSN = "https://0123456789abcdef0123456789abcdef@o4500000000000001.ingest.de.sentry.io/4500000000000002"
const JETON = "phc_jetondetestjetondetest1234WXYZ"
const regler = () => ({ sentry: false, posthog: false })
const instance = { actif: { sentry: true, posthog: true }, etat: () => ({ battement: {}, erreurs: {}, evenements: {}, journaux: {} }) }

function ctxDe() {
  const dossier = mkdtempSync(join(tmpdir(), "usine-services-"))
  const db = new DatabaseSync(":memory:")
  db.exec("CREATE TABLE reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL)")
  db.exec("CREATE TABLE journal (id INTEGER PRIMARY KEY AUTOINCREMENT, projet_id INTEGER, tache_id INTEGER, type TEXT NOT NULL, message TEXT NOT NULL, le TEXT NOT NULL DEFAULT (datetime('now')))")
  db.exec("CREATE TABLE projets (id INTEGER PRIMARY KEY, slug TEXT, nom TEXT)")
  db.prepare("INSERT INTO projets (slug, nom) VALUES (?, ?), (?, ?)").run("demo-a", "Démo A", "demo-b", "Démo B")
  const ctx = { db, config: { secrets: { worker: "jeton-de-test-du-serveur-de-travaux" }, etatDir: join(dossier, "etat"), boiteDir: join(dossier, "boite") } }
  return { ctx, dossier, fin: () => rmSync(dossier, { recursive: true, force: true }) }
}
const lireBoite = (ctx) => JSON.parse(readFileSync(join(ctx.config.boiteDir, "deployeur.json"), "utf8"))

test("la boîte ne contient que ce que la console a posé ou coupé, et change de version à chaque fois", () => {
  const { ctx, fin } = ctxDe()
  try {
    assert.deepEqual(contenuBoite(ctx).cles, {}, "rien de posé : le serveur sert partout")
    poserService(ctx, "SENTRY_DSN", DSN, "admin@exemple.fr", {}, regler)
    assert.deepEqual(lireBoite(ctx), { ...lireBoite(ctx), version: 1, cles: { SENTRY_DSN: DSN } })
    couperService(ctx, "posthog", "admin@exemple.fr", regler)
    assert.deepEqual(lireBoite(ctx).cles, { SENTRY_DSN: DSN, POSTHOG_TOKEN: "" }, "une coupure part vide : le déployeur n'envoie plus rien")
    assert.equal(lireBoite(ctx).version, 2)
    retirerService(ctx, "SENTRY_DSN", "admin@exemple.fr", regler)
    assert.deepEqual(lireBoite(ctx).cles, { POSTHOG_TOKEN: "" })
    assert.equal(versionBoite(ctx), 3)
    if (process.platform !== "win32") assert.equal(statSync(join(ctx.config.boiteDir, "deployeur.json")).mode & 0o777, 0o600)
    // Aucune empreinte des valeurs dans la base : seulement le compteur.
    assert.equal(ctx.db.prepare("SELECT valeur FROM reglages WHERE cle = 'boite_version'").get().valeur, "3")
  } finally {
    fin()
  }
})

test("sans dossier de boîte (installation d'avant), rien n'est écrit et rien ne casse", () => {
  const { ctx, fin } = ctxDe()
  try {
    const sans = { ...ctx, config: { ...ctx.config, boiteDir: undefined } }
    assert.equal(poserService(sans, "POSTHOG_TOKEN", JETON, "admin@exemple.fr", {}, regler).ok, true)
  } finally {
    fin()
  }
})

test("les applications et leurs clés : à jour si elles ont reçu la dernière version", () => {
  const { ctx, fin } = ctxDe()
  try {
    poserService(ctx, "SENTRY_DSN", DSN, "admin@exemple.fr", {}, regler)
    poserService(ctx, "POSTHOG_TOKEN", JETON, "admin@exemple.fr", {}, regler)
    mkdirSync(ctx.config.etatDir, { recursive: true })
    writeFileSync(join(ctx.config.etatDir, "statut.json"), JSON.stringify({
      "production/demo-a": { etat: "ok", conteneur: "usine-prod-demo-a-blue", boite: 2 },
      "apercu/demo-b": { etat: "ok", conteneur: "usine-apercu-demo-b", boite: 1 },
      "apercu/demo-c": { etat: "echec", message: "en panne" },
    }))
    writeFileSync(join(ctx.config.etatDir, "sante.json"), JSON.stringify({ le: "2026-11-13T12:00:00.000Z", boite: { version: 2 }, observabilite: { sentry: true, posthog: true, erreurs: { envoyes: 1, echecs: 0, joignable: true, dernier_ok: "2026-11-13T11:59:00.000Z", dernier_echec: null }, evenements: { envoyes: 3, echecs: 1, joignable: false, dernier_ok: null, dernier_echec: { le: "2026-11-13T11:58:00.000Z", detail: "HTTP 401" } }, journaux: null } }))
    assert.deepEqual(applicationsEtCles(ctx).map((a) => [a.nom, a.environnement, a.a_jour]), [["Démo A", "production", true], ["Démo B", "apercu", false]])
    const e = etatServices(ctx, instance)
    assert.deepEqual({ total: e.applications.total, a_jour: e.applications.a_jour }, { total: 2, a_jour: 1 })
    const sentry = e.services.find((s) => s.id === "sentry")
    assert.equal(sentry.deployeur.a_jour, true)
    assert.equal(sentry.deployeur.envoi.erreurs.dernier_ok, "2026-11-13T11:59:00.000Z")
    assert.match(e.services.find((s) => s.id === "posthog").deployeur.envoi.evenements.dernier_echec.message, /refuse ce jeton/)
  } finally {
    fin()
  }
})

test("Appliquer : confirmation exigée ; seules les applications en retard sont redemandées, la production par PR", async () => {
  const { ctx, fin } = ctxDe()
  try {
    poserService(ctx, "SENTRY_DSN", DSN, "admin@exemple.fr", {}, regler)
    mkdirSync(ctx.config.etatDir, { recursive: true })
    writeFileSync(join(ctx.config.etatDir, "statut.json"), JSON.stringify({
      "production/demo-a": { etat: "ok", conteneur: "usine-prod-demo-a-green", boite: null },
      "apercu/demo-b": { etat: "ok", conteneur: "usine-apercu-demo-b", boite: 1 },
    }))
    await assert.rejects(() => appliquerAuxApplications(ctx, "admin@exemple.fr"), /confirmé/)
    const appels = []
    const redemander = async (_config, chemin, message, options) => (appels.push({ chemin, message, options }), true)
    const r = await appliquerAuxApplications(ctx, "admin@exemple.fr", { confirme: true, redemander })
    assert.match(r.message, /1 application\(s\).*Démo A/)
    await new Promise((f) => setTimeout(f, 20))
    assert.deepEqual(appels.map((a) => [a.chemin, a.options.viaPR]), [["production/demo-a.json", true]])
    assert.ok(!JSON.stringify(appels).includes("0123456789abcdef"), "rien de secret ne part sur GitHub")
  } finally {
    fin()
  }
})

test("docker-compose.yml : la boîte est en mémoire, écrite par l'orchestrateur, lue par le déployeur, et nulle part ailleurs", () => {
  const texte = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docker-compose.yml"), "utf8")
  const services = {}
  let courant = null
  let dansServices = false
  for (const ligne of texte.split("\n")) {
    if (/^\S/.test(ligne)) dansServices = ligne.startsWith("services:")
    const m = dansServices && /^ {2}([a-z0-9-]+):\s*$/.exec(ligne)
    if (m) services[(courant = m[1])] = []
    else if (dansServices && courant) services[courant].push(ligne)
  }
  const monte = (nom) => services[nom].filter((l) => /^\s+- boite:/.test(l)).map((l) => l.trim())
  assert.deepEqual(monte("orchestrateur"), ["- boite:/app/boite"])
  assert.deepEqual(monte("deployeur"), ["- boite:/boite:ro"])
  for (const nom of Object.keys(services).filter((n) => !["orchestrateur", "deployeur"].includes(n))) assert.deepEqual(monte(nom), [], `${nom} ne doit pas monter la boîte`)
  assert.match(texte, /boite:\n\s+driver: local\n\s+driver_opts: \{ type: tmpfs, device: tmpfs, o: "size=1m,uid=1000,gid=1000,mode=0700" \}/)
})

