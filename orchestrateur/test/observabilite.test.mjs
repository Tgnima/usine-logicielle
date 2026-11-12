// L'envoi vers Sentry et PostHog (commun/observabilite.mjs) : formats, masquage, jamais bloquant.
// Aucun appel réseau : chaque test fournit un faux fetch qui garde les requêtes.
import { test } from "node:test"
import assert from "node:assert/strict"
import { cadresDePile, corpsJournaux, creerObservabilite, enveloppe, evenementSentry, lireDsn, nanos, nettoyer, proprietesSures } from "../../commun/observabilite.mjs"

const DSN = "https://cle0publique@o4500000000000001.ingest.de.sentry.io/4500000000000002"
const JETON = "phc_jetondetestjetondetest1234"

// Un faux fetch : garde chaque requête, répond par la fonction donnée (200 par défaut).
function fauxFetch(repondre = () => new Response(null, { status: 200 })) {
  const appels = []
  const f = async (url, options) => {
    appels.push({ url, ...options, corps: options.body })
    return repondre(url, options)
  }
  f.appels = appels
  return f
}
const silencieux = () => {}
const instance = (options = {}) => creerObservabilite({ sentryDsn: DSN, posthogJeton: JETON, service: "usine-orchestrateur", environnement: "production", signaler: silencieux, ...options })

test("nettoyer : adresses email, téléphones, IBAN, adresses IP, jetons et clés ne sortent jamais", () => {
  const masque = nettoyer([
    "écrit à jean.dupont@exemple.fr et Marie <marie+copro@mail.example.com>",
    "tél. 06 12 34 56 78, +33 6 12 34 56 78, 0612345678",
    "IBAN FR76 3000 6000 0112 3456 7890 189",
    "client 192.168.1.20 et 2001:0db8:85a3:0000:0000:8a2e:0370:7334 et ::1",
    "jetons ghp_abcdefghijklmnopqrstuvwxyz0123, xoxb-1234567890-abcdefghij, sk-ant-api03-abcdefghijklmnopqrstuv, phc_abcdefghijklmnopqrstu",
    "Authorization: Bearer abcdef0123456789abcdef password=hunter2 \"token\":\"t0k3n\"",
    "clone https://x-access-token:ghs_secretsecretsecretsecret12@github.com/a/b.git",
    "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
  ].join("\n"))
  for (const fuite of ["jean.dupont", "marie+copro", "06 12 34", "612345678", "FR76", "192.168.1.20", "2001:0db8", "ghp_", "xoxb-", "sk-ant", "phc_", "abcdef0123456789", "hunter2", "t0k3n", "ghs_", "eyJhbGci"]) {
    assert.ok(!masque.includes(fuite), `« ${fuite} » est sorti : ${masque}`)
  }
  assert.match(masque, /\[email\]/)
  assert.match(masque, /\[téléphone\]/)
  assert.match(masque, /\[iban\]/)
  assert.match(masque, /\[ip\]/)
  assert.match(masque, /\[secret\]/)
})

test("nettoyer : le reste du texte est intact (dates, heures, versions, durées, sha)", () => {
  const texte = "2026-11-10T10:00:00.123Z déploiement production/vigie-copro @ 94f260e5a1b2 en 1234 ms, node 24.20.0, lot 3/5 : 12 tests"
  assert.equal(nettoyer(texte), texte)
  assert.equal(nettoyer("\u001b[31mrouge\u001b[0m\u0007"), "rouge")
  assert.equal(nettoyer("a".repeat(50), 10), `${"a".repeat(9)}…`)
  assert.equal(nettoyer(undefined), "")
})

test("proprietesSures : seulement des valeurs simples, les textes nettoyés et courts", () => {
  const p = proprietesSures({ type: "erreur", projet: 9, duree_s: 1.5, ok: true, vide: null, contact: "a@b.fr", objet: { nom: "Jean" }, liste: [1], f: () => 1, "clé bizarre!": 1, long: "x".repeat(500), infini: Infinity })
  assert.deepEqual(Object.keys(p).sort(), ["contact", "duree_s", "long", "ok", "projet", "type", "vide"])
  assert.equal(p.contact, "[email]")
  assert.equal(p.long.length, 200)
})

test("lireDsn : la région européenne, la clé publique et le projet", () => {
  assert.deepEqual(lireDsn(DSN), { cle: "cle0publique", projet: "4500000000000002", hote: "o4500000000000001.ingest.de.sentry.io", base: "https://o4500000000000001.ingest.de.sentry.io/api/4500000000000002" })
  assert.equal(lireDsn(""), null)
  assert.equal(lireDsn("https://o1.ingest.de.sentry.io/42"), null) // sans clé
  assert.equal(lireDsn("pas une adresse"), null)
})

test("cadresDePile : de l'appelant à l'appelé, le code de l'usine distingué des dépendances", () => {
  const err = new Error("boum")
  err.stack = ["Error: boum", "    at lancer (file:///app/src/fabrique.mjs:12:7)", "    at async tour (/app/server.mjs:40:3)", "    at Object.<anonymous> (/app/node_modules/x/index.js:1:1)", "    at node:internal/main:5:2"].join("\n")
  const cadres = cadresDePile(err.stack)
  assert.equal(cadres.length, 4)
  assert.equal(cadres.at(-1).function, "lancer") // le dernier cadre est celui de l'erreur
  assert.equal(cadres.at(-1).filename, "/app/src/fabrique.mjs")
  assert.equal(cadres.at(-1).lineno, 12)
  assert.equal(cadres.at(-2).function, "tour")
  assert.equal(cadres.find((c) => c.filename.includes("node_modules")).in_app, false)
  assert.equal(cadres[0].in_app, false) // node:internal
})

test("evenementSentry et enveloppe : le format envelope, la longueur en octets, rien de personnel", () => {
  const e = evenementSentry({ erreur: new TypeError("envoi à paul@exemple.fr refusé"), service: "usine-deployeur", environnement: "production", version: "94f260e", etiquettes: { produit: "vigie-copro", vide: "" } })
  assert.match(e.event_id, /^[0-9a-f]{32}$/)
  assert.equal(e.platform, "node")
  assert.equal(e.level, "error")
  assert.equal(e.release, "usine-deployeur@94f260e")
  assert.deepEqual(e.tags, { service: "usine-deployeur", produit: "vigie-copro" })
  assert.equal(e.exception.values[0].type, "TypeError")
  assert.equal(e.exception.values[0].value, "envoi à [email] refusé")
  assert.ok(e.exception.values[0].stacktrace.frames.length > 0)
  const lignes = enveloppe(e, new Date("2026-11-10T10:00:00Z")).split("\n")
  assert.equal(lignes.length, 4) // en-tête, en-tête de l'élément, l'événement, la fin de ligne
  assert.deepEqual(JSON.parse(lignes[0]), { event_id: e.event_id, sent_at: "2026-11-10T10:00:00.000Z" })
  const element = JSON.parse(lignes[1])
  assert.equal(element.type, "event")
  assert.equal(element.length, Buffer.byteLength(lignes[2])) // en octets : « à » en compte deux
  assert.deepEqual(JSON.parse(lignes[2]), e)
  assert.equal(lignes[3], "")
  // Un incident (message), avec son empreinte : toutes les pannes d'un produit dans un même sujet.
  const i = evenementSentry({ message: "vigie-copro en panne", empreinte: ["panne", "production/vigie-copro"], service: "usine-deployeur", environnement: "production" })
  assert.equal(i.message, "vigie-copro en panne")
  assert.equal(i.exception, undefined)
  assert.deepEqual(i.fingerprint, ["panne", "production/vigie-copro"])
})

test("nanos : l'heure exacte de docker logs --timestamps, ou des millisecondes", () => {
  assert.equal(nanos("2026-11-10T10:00:00.123456789Z"), "1794304800123456789")
  assert.equal(nanos("2026-11-10T10:00:00Z"), "1794304800000000000")
  assert.equal(nanos(1794304800123), "1794304800123000000")
})

test("corpsJournaux : OTLP JSON, une ressource par service (service.name, deployment.environment)", () => {
  const corps = corpsJournaux([
    { t: "1", niveau: "info", texte: "démarré", service: "vigie-copro", environnement: "production", attributs: { conteneur: "usine-prod-vigie-copro-blue" } },
    { t: "2", niveau: "error", texte: "échec", service: "vigie-copro", environnement: "production", attributs: { essai: 2 } },
    { t: "3", niveau: "warn", texte: "lent", service: "acte-clair", environnement: "apercu", attributs: {} },
  ], 1794304800000)
  assert.equal(corps.resourceLogs.length, 2)
  const [vigie] = corps.resourceLogs
  assert.deepEqual(vigie.resource.attributes, [{ key: "service.name", value: { stringValue: "vigie-copro" } }, { key: "deployment.environment", value: { stringValue: "production" } }])
  const [r1, r2] = vigie.scopeLogs[0].logRecords
  assert.deepEqual(r1, { timeUnixNano: "1", observedTimeUnixNano: "1794304800000000000", severityNumber: 9, severityText: "INFO", body: { stringValue: "démarré" }, attributes: [{ key: "conteneur", value: { stringValue: "usine-prod-vigie-copro-blue" } }] })
  assert.equal(r2.severityNumber, 17)
  assert.deepEqual(r2.attributes, [{ key: "essai", value: { intValue: "2" } }])
})

test("sans clé, rien ne part ; sous node --test sans faux fetch non plus, même avec des clés", async () => {
  const f = fauxFetch()
  const sans = creerObservabilite({ service: "x", fetch: f, signaler: silencieux })
  assert.deepEqual(sans.actif, { sentry: false, posthog: false })
  assert.equal(sans.erreur(new Error("x")), false)
  assert.equal(sans.evenement("x"), false)
  assert.equal(sans.journal("x"), false)
  assert.equal(await sans.battement("x"), false)
  await sans.vider()
  assert.equal(f.appels.length, 0)
  const sousTest = creerObservabilite({ sentryDsn: DSN, posthogJeton: JETON, service: "x", signaler: silencieux })
  assert.deepEqual(sousTest.actif, { sentry: false, posthog: false })
})

test("evenement : un lot /batch/ en région européenne, sans profil de personne", async () => {
  const f = fauxFetch()
  const o = instance({ fetch: f, version: () => "94f260e" })
  o.evenement("journal", { type: "fusion", projet: 9, tache: 41, message_libre: { texte: "jamais" } })
  o.evenement("journal", { type: "erreur", projet: 9 })
  await o.vider()
  assert.equal(f.appels.length, 1)
  const [appel] = f.appels
  assert.equal(appel.url, "https://eu.i.posthog.com/batch/")
  assert.equal(appel.method, "POST")
  const corps = JSON.parse(appel.corps)
  assert.equal(corps.api_key, JETON)
  assert.equal(corps.batch.length, 2)
  const [e] = corps.batch
  assert.equal(e.event, "journal")
  assert.equal(e.distinct_id, "usine-orchestrateur")
  assert.match(e.timestamp, /^\d{4}-\d\d-\d\dT/)
  assert.deepEqual(e.properties, { service: "usine-orchestrateur", environnement: "production", version: "94f260e", type: "fusion", projet: 9, tache: 41, $process_person_profile: false, $geoip_disable: true })
  assert.equal(o.etat().evenements.envoyes, 2)
})

test("journal : OTLP JSON vers /i/v1/logs, jeton en en-tête, textes masqués", async () => {
  const f = fauxFetch()
  const o = instance({ fetch: f })
  o.journal("connexion de lea@exemple.fr", { niveau: "warn", horodatage: "2026-11-10T10:00:00.5Z", service: "vigie-copro", environnement: "apercu", attributs: { conteneur: "usine-apercu-vigie-copro" } })
  await o.vider()
  const [appel] = f.appels
  assert.equal(appel.url, "https://eu.i.posthog.com/i/v1/logs")
  assert.equal(appel.headers.authorization, `Bearer ${JETON}`)
  assert.equal(appel.headers["content-type"], "application/json")
  const ligne = JSON.parse(appel.corps).resourceLogs[0].scopeLogs[0].logRecords[0]
  assert.equal(ligne.body.stringValue, "connexion de [email]")
  assert.equal(ligne.timeUnixNano, "1794304800500000000")
  assert.equal(ligne.severityText, "WARN")
})

test("erreur : une enveloppe par erreur, la clé dans X-Sentry-Auth, les doublons ne repartent pas", async () => {
  const f = fauxFetch()
  const o = instance({ fetch: f })
  const err = new Error("délai dépassé après 1200 ms")
  assert.equal(o.erreur(err), true)
  assert.equal(o.erreur(new Error("délai dépassé après 3400 ms")), false) // même erreur, autre nombre
  assert.equal(o.erreur(new Error("autre chose")), true)
  await o.vider()
  assert.equal(f.appels.length, 2)
  const [appel] = f.appels
  assert.equal(appel.url, "https://o4500000000000001.ingest.de.sentry.io/api/4500000000000002/envelope/")
  assert.equal(appel.headers["content-type"], "application/x-sentry-envelope")
  assert.equal(appel.headers["x-sentry-auth"], "Sentry sentry_version=7, sentry_client=usine-logicielle/1, sentry_key=cle0publique")
  assert.equal(JSON.parse(appel.corps.split("\n")[2]).exception.values[0].value, "délai dépassé après 1200 ms")
  assert.equal(o.etat().erreurs.ignores, 1)
})

test("erreur : 20 par heure au plus, et une réponse 429 met Sentry en pause", async () => {
  const f = fauxFetch()
  const o = instance({ fetch: f, erreursParHeure: 3 })
  for (let i = 0; i < 5; i++) o.erreur(new Error(`erreur ${"abcde"[i]}`))
  await o.vider()
  assert.equal(f.appels.length, 3)
  const limite = fauxFetch(() => new Response(null, { status: 429, headers: { "retry-after": "120" } }))
  const p = instance({ fetch: limite })
  p.erreur(new Error("une"))
  await p.vider()
  p.erreur(new Error("deux"))
  await p.vider()
  assert.equal(limite.appels.length, 1) // la seconde attend la fin de la pause
  assert.equal(p.etat().files.erreurs, 1)
})

test("battement : l'API cron HTTP, le moniteur créé par l'envoi (une fois par minute)", async () => {
  const f = fauxFetch()
  const o = instance({ fetch: f })
  assert.equal(await o.battement("usine-orchestrateur"), true)
  const [appel] = f.appels
  assert.equal(appel.url, "https://o4500000000000001.ingest.de.sentry.io/api/4500000000000002/cron/usine-orchestrateur/cle0publique/")
  assert.deepEqual(JSON.parse(appel.corps), { status: "ok", monitor_config: { schedule: { type: "crontab", value: "* * * * *" }, checkin_margin: 2, max_runtime: 2, timezone: "UTC", failure_issue_threshold: 2, recovery_threshold: 1 } })
})

test("jamais bloquant : un service muet ou en erreur ne lève rien et ne retient pas l'usine", async () => {
  const muet = async (url, { signal }) => new Promise((_, rejeter) => signal.addEventListener("abort", () => rejeter(signal.reason)))
  const signalements = []
  const o = instance({ fetch: muet, delaiMs: 100, signaler: (t) => signalements.push(t) })
  o.evenement("a")
  o.journal("b")
  o.erreur(new Error("c"))
  const debut = Date.now()
  await o.vider()
  assert.ok(Date.now() - debut < 1_000)
  const etat = o.etat()
  assert.deepEqual([etat.evenements.echecs, etat.journaux.echecs, etat.erreurs.echecs], [1, 1, 1])
  assert.equal(signalements.length, 3) // une fois par canal, au premier échec
  o.evenement("d")
  await o.vider()
  assert.equal(signalements.length, 3) // pas de bruit tant que le service reste injoignable
  const casse = instance({ fetch: async () => { throw new Error("ECONNREFUSED") } })
  casse.evenement("x")
  await casse.vider()
  assert.equal(casse.etat().evenements.echecs, 1)
})

test("file pleine : les plus vieux éléments sont perdus, comptés", async () => {
  const f = fauxFetch()
  const o = instance({ fetch: f })
  for (let i = 0; i < 2005; i++) o.evenement("e", { i })
  assert.equal(o.etat().files.evenements, 2000)
  assert.equal(o.etat().evenements.perdus, 5)
  await o.arreter()
  assert.equal(o.etat().files.evenements, 0) // arreter() vide tout, lot après lot
  assert.equal(JSON.parse(f.appels[0].corps).batch[0].properties.i, 5)
})
