// Le portier de bout en bout : invitation, mot de passe, connexion, vérification
// pour Caddy, cloisonnement entre applications, essais limités, redirections sûres.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BASE = "exemple.test"
const JETON = "j".repeat(40)
let serveur
const port = 18080
const appel = (chemin, { hote = `prospecta.${BASE}`, methode = "GET", corps, entetes = {} } = {}) =>
  fetch(`http://127.0.0.1:${port}${chemin}`, { method: methode, redirect: "manual", headers: { "x-forwarded-host": hote, ...entetes }, body: corps })
const api = (chemin, methode = "GET", corps) => appel(`/_portier/api/${chemin}`, { methode, corps: corps ? JSON.stringify(corps) : undefined, entetes: { authorization: `Bearer ${JETON}`, "content-type": "application/json" } })
const form = (o) => new URLSearchParams(o).toString()
const formEntetes = { "content-type": "application/x-www-form-urlencoded" }

before(async () => {
  serveur = spawn(process.execPath, [join(import.meta.dirname, "..", "server.mjs")], {
    env: { ...process.env, PORTIER_SECRET: "s".repeat(64), PORTIER_API_TOKEN: JETON, DOMAINE_BASE: BASE, DATA_DIR: mkdtempSync(join(tmpdir(), "portier-")), PORT: String(port) },
    stdio: "ignore",
  })
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${port}/_portier/connexion`)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 100))
    }
  }
})
after(() => serveur.kill())

let cookie
test("sans session : une page renvoie vers la connexion, une API reçoit 401", async () => {
  const r = await appel("/_portier/verifier", { entetes: { "x-forwarded-uri": "/campagnes?x=1" } })
  assert.equal(r.status, 302)
  assert.equal(r.headers.get("location"), "/_portier/connexion?retour=%2Fcampagnes%3Fx%3D1")
  assert.equal((await appel("/_portier/verifier", { entetes: { "x-forwarded-uri": "/api/contacts" } })).status, 401)
})

test("l'API d'administration exige le jeton", async () => {
  assert.equal((await appel("/_portier/api/utilisateurs")).status, 401)
})

test("invitation, mot de passe, puis accès à la seule application autorisée", async () => {
  await api("applis", "PUT", { applis: [{ slug: "prospecta", nom: "Prospecta", liens: [{ url: `https://prospecta.${BASE}`, libelle: "production" }] }, { slug: "autre", nom: "Autre" }] })
  const r = await api("utilisateurs", "POST", { email: "Alice@Exemple.fr", role: "membre", applis: ["prospecta"] })
  assert.equal(r.status, 201)
  const { lien } = await r.json()
  const jeton = new URL(lien).searchParams.get("jeton")
  assert.equal((await appel(`/_portier/invitation?jeton=${jeton}`)).status, 200)
  const court = await appel("/_portier/invitation", { methode: "POST", corps: form({ jeton, mot_de_passe: "court", confirmation: "court" }), entetes: formEntetes })
  assert.equal(court.status, 400)
  const ok = await appel("/_portier/invitation", { methode: "POST", corps: form({ jeton, mot_de_passe: "un mot de passe solide", confirmation: "un mot de passe solide" }), entetes: formEntetes })
  assert.equal(ok.status, 302)
  // Le lien ne sert qu'une fois.
  assert.equal((await appel(`/_portier/invitation?jeton=${jeton}`)).status, 410)

  const c = await appel("/_portier/connexion", { methode: "POST", corps: form({ email: "alice@exemple.fr", mot_de_passe: "un mot de passe solide", retour: "/campagnes" }), entetes: formEntetes })
  assert.equal(c.status, 302)
  assert.equal(c.headers.get("location"), "/campagnes")
  cookie = c.headers.get("set-cookie").split(";")[0]
  assert.match(c.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/)
  const v = await appel("/_portier/verifier", { entetes: { cookie } })
  assert.equal(v.status, 200)
  assert.equal(v.headers.get("x-usine-utilisateur"), "alice@exemple.fr")
})

test("une session ne vaut que pour son adresse, et pas pour les adresses d'administration", async () => {
  assert.equal((await appel("/_portier/verifier", { hote: `autre.${BASE}`, entetes: { cookie } })).status, 302)
  assert.equal((await appel("/_portier/verifier", { hote: `usine-tableau.${BASE}`, entetes: { cookie } })).status, 302)
})

test("un cookie falsifié est refusé", async () => {
  const faux = cookie.replace(/.$/, (c) => (c === "A" ? "B" : "A"))
  assert.equal((await appel("/_portier/verifier", { entetes: { cookie: faux } })).status, 302)
})

test("retirer l'accès coupe la session existante", async () => {
  const [u] = await (await api("utilisateurs")).json()
  await api(`utilisateurs/${u.id}`, "PATCH", { applis: [] })
  assert.notEqual((await appel("/_portier/verifier", { entetes: { cookie } })).status, 200)
})

test("le retour après connexion ne peut pas mener vers un autre site", async () => {
  const [u] = await (await api("utilisateurs")).json()
  await api(`utilisateurs/${u.id}`, "PATCH", { applis: ["*"] })
  for (const retour of ["//evil.example", "https://evil.example", "/\\evil.example"]) {
    const c = await appel("/_portier/connexion", { methode: "POST", corps: form({ email: "alice@exemple.fr", mot_de_passe: "un mot de passe solide", retour }), entetes: formEntetes })
    assert.equal(c.headers.get("location"), "/")
  }
})

test("un formulaire envoyé depuis un autre site est refusé", async () => {
  const c = await appel("/_portier/connexion", { methode: "POST", corps: form({ email: "alice@exemple.fr", mot_de_passe: "x" }), entetes: { ...formEntetes, origin: "https://evil.example" } })
  assert.equal(c.status, 403)
})

test("une clé d'API ouvre ses applications, et elles seules, jusqu'à sa révocation", async () => {
  const r = await api("cles", "POST", { nom: "intégration CRM", applis: ["prospecta"], par: "test" })
  assert.equal(r.status, 201)
  const { id, cle } = await r.json()
  assert.match(cle, /^usk_/)
  const avec = (hote, c = cle) => appel("/_portier/verifier", { hote, entetes: { authorization: `Bearer ${c}`, "x-forwarded-uri": "/api/contacts" } })
  const ok = await avec(`prospecta.${BASE}`)
  assert.equal(ok.status, 200)
  assert.equal(ok.headers.get("x-usine-utilisateur"), "cle:intégration CRM")
  assert.equal((await avec(`autre.${BASE}`)).status, 401)
  assert.equal((await avec(`usine-tableau.${BASE}`)).status, 401)
  assert.equal((await avec(`prospecta.${BASE}`, cle.slice(0, -2) + "zz")).status, 401)
  // La liste ne montre jamais la clé elle-même.
  const liste = await (await api("cles")).json()
  assert.ok(!JSON.stringify(liste).includes(cle))
  await api(`cles/${id}`, "DELETE")
  assert.equal((await avec(`prospecta.${BASE}`)).status, 401)
})

test("un faux cookie posé pour tout le domaine ne masque pas la vraie session", async () => {
  const c = await appel("/_portier/connexion", { methode: "POST", corps: form({ email: "alice@exemple.fr", mot_de_passe: "un mot de passe solide", retour: "/" }), entetes: formEntetes })
  const vrai = c.headers.get("set-cookie").split(";")[0]
  const v = await appel("/_portier/verifier", { entetes: { cookie: `${vrai}; usine_session=1.1.eA.9999999999.faux` } })
  assert.equal(v.status, 200)
})

test("l'API refuse un rôle ou des applications inventés", async () => {
  const [u] = await (await api("utilisateurs")).json()
  assert.equal((await api(`utilisateurs/${u.id}`, "PATCH", { role: "superadmin" })).status, 400)
  assert.equal((await api(`utilisateurs/${u.id}`, "PATCH", { applis: ["../x"] })).status, 400)
})

test("une adresse avec des jokers SQL ne désigne aucune application", async () => {
  const { cle } = await (await api("cles", "POST", { nom: "jokers", applis: ["prospecta"], par: "test" })).json()
  const r = await appel("/_portier/verifier", { hote: "%", entetes: { authorization: `Bearer ${cle}`, "x-forwarded-uri": "/api/x" } })
  assert.equal(r.status, 401)
})

test("cinq échecs bloquent les essais", async () => {
  let dernier
  for (let i = 0; i < 6; i++) dernier = await appel("/_portier/connexion", { hote: `x${i}.${BASE}`, methode: "POST", corps: form({ email: "bob@exemple.fr", mot_de_passe: "faux" }), entetes: formEntetes })
  assert.equal(dernier.status, 429)
})
