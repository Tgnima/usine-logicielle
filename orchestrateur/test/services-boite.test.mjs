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
import { appliquerAuxApplications, applicationsEtCles, contenuBoite, couperService, etatServices, poserService, reprendreService, retirerService, valeurService, versionBoite } from "../src/services.mjs"

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

const ecrireStatut = (ctx, statut) => {
  mkdirSync(ctx.config.etatDir, { recursive: true })
  writeFileSync(join(ctx.config.etatDir, "statut.json"), JSON.stringify(statut))
}

test("la version ne change que si la boîte change : jamais pour Slack, ni pour une valeur reposée à l'identique", () => {
  const { ctx, fin } = ctxDe()
  try {
    ctx.config.secrets = { ...ctx.config.secrets, slackBot: "", slackApp: "" }
    ctx.config.serveur = { slackCanal: "", slackAdmins: "" }
    poserService(ctx, "SENTRY_DSN", DSN, "admin@exemple.fr", {}, regler)
    ecrireStatut(ctx, { "production/demo-a": { etat: "ok", conteneur: "usine-prod-demo-a-blue", boite: 1 } })
    assert.equal(versionBoite(ctx), 1)
    poserService(ctx, "SLACK_CANAL", "C0123456789", "admin@exemple.fr", {}, regler)
    poserService(ctx, "SENTRY_DSN", DSN, "admin@exemple.fr", {}, regler) // la même clé
    retirerService(ctx, "SMTP_PASS", "admin@exemple.fr", regler) // jamais posée
    assert.equal(versionBoite(ctx), 1, "rien de neuf pour le déployeur ni pour les applications")
    assert.deepEqual(applicationsEtCles(ctx).map((a) => a.a_jour), [true], "l'application reste à jour")
    assert.equal(etatServices(ctx, instance).applications.a_faire, 0, "« Appliquer » n'est pas proposé")
  } finally {
    fin()
  }
})

test("une mise en ligne en échec : l'ancienne version, toujours servie avec ses anciennes clés, reste comptée en retard", () => {
  const { ctx, fin } = ctxDe()
  try {
    poserService(ctx, "SENTRY_DSN", DSN, "admin@exemple.fr", {}, regler)
    couperService(ctx, "sentry", "admin@exemple.fr", regler)
    ecrireStatut(ctx, { "production/demo-a": { etat: "echec", conteneur: "usine-prod-demo-a-blue", couleur: "blue", boite: 1, message: "aucun service d'envoi" } })
    const e = etatServices(ctx, instance)
    assert.deepEqual({ total: e.applications.total, a_jour: e.applications.a_jour, a_faire: e.applications.a_faire }, { total: 1, a_jour: 0, a_faire: 1 })
    assert.deepEqual(e.applications.en_retard, [{ nom: "Démo A", environnement: "production", echec: true, en_cours: false }])
  } finally {
    fin()
  }
})

test("Appliquer : une application redemandée reste « en cours » jusqu'à ce que le déployeur la prenne ; un second clic ne la refait pas", async () => {
  const { ctx, fin } = ctxDe()
  try {
    poserService(ctx, "SENTRY_DSN", DSN, "admin@exemple.fr", {}, regler)
    ecrireStatut(ctx, { "production/demo-a": { etat: "ok", conteneur: "usine-prod-demo-a-blue", boite: null, demande_le: "2026-11-01T00:00:00.000Z" } })
    const demandes = []
    const redemander = async (_c, chemin) => {
      const le = `2026-11-13T12:00:0${demandes.length}.000Z`
      demandes.push(chemin)
      return le
    }
    await appliquerAuxApplications(ctx, "admin@exemple.fr", { confirme: true, redemander })
    await new Promise((f) => setTimeout(f, 20))
    assert.deepEqual(demandes, ["production/demo-a.json"])
    let e = etatServices(ctx, instance).applications
    assert.deepEqual([e.en_cours, e.a_faire], [true, 0], "demandée, pas encore prise : pas de bouton")
    assert.match((await appliquerAuxApplications(ctx, "admin@exemple.fr", { confirme: true, redemander })).message, /déjà en cours/)
    assert.equal(demandes.length, 1, "aucune seconde demande")
    // Le déployeur la prend (il recopie la date demandée), puis la met en ligne avec la dernière boîte.
    ecrireStatut(ctx, { "production/demo-a": { etat: "en_cours", conteneur: "usine-prod-demo-a-blue", boite: null, demande_le: "2026-11-13T12:00:00.000Z" } })
    assert.equal(etatServices(ctx, instance).applications.en_cours, true)
    ecrireStatut(ctx, { "production/demo-a": { etat: "ok", conteneur: "usine-prod-demo-a-green", boite: versionBoite(ctx), demande_le: "2026-11-13T12:00:00.000Z" } })
    e = etatServices(ctx, instance).applications
    assert.deepEqual([e.a_jour, e.total, e.en_cours], [1, 1, false])
  } finally {
    fin()
  }
})

test("couper garde la valeur de la console ; « Ne plus couper » la rétablit ; « Retirer » efface tout", () => {
  const { ctx, fin } = ctxDe()
  try {
    poserService(ctx, "SENTRY_DSN", DSN, "admin@exemple.fr", {}, regler)
    couperService(ctx, "sentry", "admin@exemple.fr", regler)
    assert.deepEqual(valeurService(ctx, "SENTRY_DSN"), { valeur: "", source: "coupe" })
    assert.equal(lireBoite(ctx).cles.SENTRY_DSN, "", "coupé : le déployeur n'envoie plus rien")
    const c = etatServices(ctx, instance).services.find((s) => s.id === "sentry").cles[0]
    assert.ok(c.coupe && c.console, "la coupure et la valeur de la console, toutes deux montrées")
    const r = reprendreService(ctx, "sentry", "admin@exemple.fr", regler)
    assert.match(r.message, /valeur de la console/)
    assert.deepEqual(valeurService(ctx, "SENTRY_DSN"), { valeur: DSN, source: "console" })
    assert.equal(lireBoite(ctx).cles.SENTRY_DSN, DSN)
    couperService(ctx, "sentry", "admin@exemple.fr", regler)
    retirerService(ctx, "SENTRY_DSN", "admin@exemple.fr", regler)
    assert.equal(valeurService(ctx, "SENTRY_DSN").source, "aucune", "ni valeur ni coupure : le serveur (ici, rien)")
    // Une coupure écrite à l'ancienne (à la place de la valeur) se lit encore, et « Ne plus couper » l'efface.
    ctx.db.prepare("INSERT INTO reglages (cle, valeur) VALUES ('service_POSTHOG_TOKEN', ?)").run(JSON.stringify({ coupe: true, le: "2026-11-12T10:00:00.000Z", par: "admin@exemple.fr" }))
    assert.equal(valeurService(ctx, "POSTHOG_TOKEN").source, "coupe")
    reprendreService(ctx, "posthog", "admin@exemple.fr", regler)
    assert.equal(valeurService(ctx, "POSTHOG_TOKEN").source, "aucune")
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

