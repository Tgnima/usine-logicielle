// Le portier de bout en bout : invitation, mot de passe, connexion, vérification
// pour Caddy, cloisonnement entre applications, essais limités, redirections sûres.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHmac } from "node:crypto"
import { request } from "node:http"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BASE = "exemple.test"
const JETON = "j".repeat(40)
const SECRET = "s".repeat(64)
let serveur
const port = 18080
const appel = (chemin, { hote = `prospecta.${BASE}`, methode = "GET", corps, entetes = {} } = {}) =>
  fetch(`http://127.0.0.1:${port}${chemin}`, { method: methode, redirect: "manual", headers: { "x-forwarded-host": hote, ...entetes }, body: corps })
const api = (chemin, methode = "GET", corps) => appel(`/_portier/api/${chemin}`, { methode, corps: corps ? JSON.stringify(corps) : undefined, entetes: { authorization: `Bearer ${JETON}`, "content-type": "application/json" } })
const form = (o) => new URLSearchParams(o).toString()
const formEntetes = { "content-type": "application/x-www-form-urlencoded" }

before(async () => {
  serveur = spawn(process.execPath, [join(import.meta.dirname, "..", "server.mjs")], {
    env: { ...process.env, PORTIER_SECRET: SECRET, PORTIER_API_TOKEN: JETON, DOMAINE_BASE: BASE, DATA_DIR: mkdtempSync(join(tmpdir(), "portier-")), PORT: String(port) },
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

test("sans session : le retour de GitHub sur la console renvoie vers la connexion, pas vers un 401", async () => {
  const retour = (uri, hote = `console.${BASE}`, methode = "GET") => appel("/_portier/verifier", { hote, entetes: { "x-forwarded-uri": uri, "x-forwarded-method": methode } })
  const r = await retour("/api/github/manifeste?code=abc&state=xyz")
  assert.equal(r.status, 302)
  assert.equal(r.headers.get("location"), `/_portier/connexion?retour=${encodeURIComponent("/api/github/manifeste?code=abc&state=xyz")}`)
  assert.equal((await retour("/api/github/installe?installation_id=1&code=c")).status, 302)
  // Les autres adresses d'API, une autre méthode ou une autre application gardent le 401.
  assert.equal((await retour("/api/projets")).status, 401)
  assert.equal((await retour("/api/github/installe", `console.${BASE}`, "POST")).status, 401)
  assert.equal((await retour("/api/github/installe", `prospecta.${BASE}`)).status, 401)
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
  // Le navigateur retire tabulations et retours à la ligne : « /<tab>/evil.example » deviendrait « //evil.example ».
  for (const retour of ["//evil.example", "https://evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "/\r\n/evil.example", "/\t\\evil.example", "/ /evil.example"]) {
    const c = await appel("/_portier/connexion", { methode: "POST", corps: form({ email: "alice@exemple.fr", mot_de_passe: "un mot de passe solide", retour }), entetes: formEntetes })
    assert.equal(c.headers.get("location"), "/")
  }
})

test("un formulaire envoyé depuis un autre site est refusé", async () => {
  const c = await appel("/_portier/connexion", { methode: "POST", corps: form({ email: "alice@exemple.fr", mot_de_passe: "x" }), entetes: { ...formEntetes, origin: "https://evil.example" } })
  assert.equal(c.status, 403)
})

test("nos pages laissent le navigateur annoncer leur origine, et seule celle-ci est acceptée", async () => {
  // Avec no-referrer, le navigateur enverrait Origin: null et tout envoi serait refusé.
  const page = await appel("/_portier/connexion")
  assert.equal(page.headers.get("referrer-policy"), "same-origin")
  const r = await api("utilisateurs", "POST", { email: "bob@exemple.fr", role: "membre", applis: ["prospecta"] })
  const jeton = new URL((await r.json()).lien).searchParams.get("jeton")
  const envoi = (origin) => appel("/_portier/invitation", { methode: "POST", corps: form({ jeton, mot_de_passe: "un mot de passe solide", confirmation: "un mot de passe solide" }), entetes: { ...formEntetes, origin } })
  assert.equal((await envoi("null")).status, 403)
  assert.equal((await envoi("https://evil.example")).status, 403)
  assert.equal((await envoi(`https://prospecta.${BASE}`)).status, 302)
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

// --- Déconnexion ---------------------------------------------------------------------
const connecter = async (email, hote = `prospecta.${BASE}`) => {
  const c = await appel("/_portier/connexion", { hote, methode: "POST", corps: form({ email, mot_de_passe: "un mot de passe solide", retour: "/" }), entetes: formEntetes })
  assert.equal(c.status, 302)
  return c.headers.get("set-cookie").split(";")[0]
}
// La déconnexion passe par node:http et non fetch : fetch impose « Sec-Fetch-Mode: cors », or le portier
// distingue une navigation (un lien suivi) d'une image ou d'un fetch de la page. Par défaut, un GET est
// une navigation de la personne ; navigation: false n'envoie aucun en-tête Sec-Fetch (programme).
const deconnecter = (cookie, { hote = `prospecta.${BASE}`, methode = "POST", chemin = "/_portier/deconnexion", entetes = {}, navigation = true } = {}) =>
  new Promise((ok, ko) => {
    const headers = { "x-forwarded-host": hote, ...(cookie ? { cookie } : {}), ...(methode === "POST" ? { origin: `https://${hote}` } : navigation ? { "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" } : {}), ...entetes }
    request({ host: "127.0.0.1", port, path: chemin, method: methode, headers }, (res) => {
      let corps = ""
      res.setEncoding("utf8").on("data", (x) => (corps += x)).on("end", () => ok({ status: res.statusCode, headers: { get: (n) => [res.headers[n] ?? []].flat().join(", ") || null }, text: async () => corps }))
    }).on("error", ko).end()
  })
const verifier = (cookie, hote = `prospecta.${BASE}`) => appel("/_portier/verifier", { hote, entetes: { cookie, "x-forwarded-uri": "/" } })
const qui = (cookie, hote = `prospecta.${BASE}`) => appel("/_portier/qui", { hote, entetes: { cookie } })
const deconnexionsNotees = async () => (await (await api("evenements")).json()).filter((e) => e.evenement.startsWith("déconnexion")).length
// Le cookie effacé côté navigateur : même nom, mêmes attributs, durée nulle.
const efface = (r) => assert.match(r.headers.get("set-cookie") ?? "", /^usine_session=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/)

test("déconnexion : le cookie est effacé, la session fermée, et le cookie rejoué ensuite est refusé", async () => {
  const cookie = await connecter("alice@exemple.fr")
  assert.equal((await verifier(cookie)).status, 200)
  const avant = await deconnexionsNotees()
  const r = await deconnecter(cookie)
  assert.equal(r.status, 303)
  assert.equal(r.headers.get("location"), "/_portier/connexion")
  assert.equal(r.headers.get("cache-control"), "no-store")
  efface(r)
  assert.equal(await deconnexionsNotees(), avant + 1)
  // Le vieux cookie, rejoué tel quel : Caddy renvoie vers la connexion, une API reçoit 401, le tableau de bord ne voit personne.
  const rejoue = await verifier(cookie)
  assert.equal(rejoue.status, 302)
  assert.match(rejoue.headers.get("location"), /^\/_portier\/connexion\?retour=/)
  assert.equal((await appel("/_portier/verifier", { entetes: { cookie, "x-forwarded-uri": "/api/contacts" } })).status, 401)
  assert.equal((await qui(cookie)).status, 401)
  // Le compte, lui, n'est pas touché : une nouvelle connexion ouvre une nouvelle session.
  assert.equal((await verifier(await connecter("alice@exemple.fr"))).status, 200)
})

test("deux connexions du même compte, même à la même seconde : fermer l'une ne ferme pas l'autre", async () => {
  const [une, autre] = await Promise.all([connecter("alice@exemple.fr"), connecter("alice@exemple.fr")])
  assert.notEqual(une, autre)
  await deconnecter(une)
  assert.equal((await verifier(une)).status, 302)
  assert.equal((await verifier(autre)).status, 200)
})

test("une session ouverte avant cette version (cookie sans aléa) reste valable, et la déconnexion la ferme", async () => {
  const r = await api("utilisateurs", "POST", { email: "dora@exemple.fr", role: "membre", applis: ["prospecta"] })
  const { id, lien } = await r.json()
  await appel("/_portier/invitation", { methode: "POST", corps: form({ jeton: new URL(lien).searchParams.get("jeton"), mot_de_passe: "un mot de passe solide", confirmation: "un mot de passe solide" }), entetes: formEntetes })
  // L'ancien format, signé comme le faisait le portier : id.version.hôte.expiration.signature (version 2 : le mot de passe choisi).
  const corps = `${id}.2.${Buffer.from(`prospecta.${BASE}`).toString("base64url")}.${Math.floor(Date.now() / 1000) + 3600}`
  const ancien = `usine_session=${corps}.${createHmac("sha256", SECRET).update(corps).digest("base64url")}`
  assert.equal((await verifier(ancien)).status, 200)
  await deconnecter(ancien)
  assert.equal((await verifier(ancien)).status, 302)
})

test("déconnexion par un lien de l'application (GET) : la session est fermée aussi", async () => {
  // Un lien suivi dans l'application, une adresse tapée ou ouverte depuis un email, un programme sans en-têtes Sec-Fetch.
  for (const [entetes, navigation] of [[{ "sec-fetch-site": "same-origin" }, true], [{ "sec-fetch-site": "none" }, true], [{}, false]]) {
    const cookie = await connecter("alice@exemple.fr")
    const r = await deconnecter(cookie, { methode: "GET", entetes, navigation })
    assert.equal(r.status, 303)
    assert.equal(r.headers.get("location"), "/_portier/connexion")
    efface(r)
    assert.equal((await verifier(cookie)).status, 302, JSON.stringify(entetes))
  }
})

test("déconnexion : un autre site ne peut pas fermer la session à l'insu de la personne", async () => {
  const cookie = await connecter("alice@exemple.fr")
  // Un formulaire posté depuis un autre site, ou avec Origin: null : refusé, rien n'est fermé.
  for (const origin of ["https://evil.example", "null", `https://autre.${BASE}`]) {
    const r = await deconnecter(cookie, { entetes: { origin } })
    assert.equal(r.status, 403, origin)
    assert.equal(r.headers.get("set-cookie"), null)
  }
  // Un lien venu d'ailleurs, un préchargement, ou l'adresse affichée comme image ou appelée par un fetch
  // dans une application : une page demande confirmation, par un formulaire de la page même.
  const meme = { "sec-fetch-site": "same-origin" }
  for (const entetes of [{ "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "same-site" }, { ...meme, "sec-purpose": "prefetch" }, { ...meme, "sec-fetch-mode": "no-cors", "sec-fetch-dest": "image" }, { ...meme, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" }]) {
    const r = await deconnecter(cookie, { methode: "GET", entetes })
    assert.equal(r.status, 200, JSON.stringify(entetes))
    assert.equal(r.headers.get("set-cookie"), null)
    assert.match(await r.text(), /<form method="post" action="\/_portier\/deconnexion"><button type="submit">Se déconnecter<\/button><\/form>/)
  }
  assert.equal((await verifier(cookie)).status, 200)
})

test("déconnexion sans session : retour à la connexion, sans erreur et sans rien noter", async () => {
  const avant = await deconnexionsNotees()
  const faux = "usine_session=1.1.eA.9999999999.faux"
  for (const [cookie, methode, entetes] of [[null, "POST"], [null, "GET"], [null, "GET", { "sec-fetch-site": "cross-site" }], [faux, "POST"], ["usine_session=", "GET"], ["usine_session=n.importe.quoi", "POST"]]) {
    const r = await deconnecter(cookie, { methode, entetes })
    assert.equal(r.status, 303, `${cookie} ${methode}`)
    assert.equal(r.headers.get("location"), "/_portier/connexion")
    efface(r)
  }
  assert.equal(await deconnexionsNotees(), avant)
})

test("déconnexion : la redirection ne mène jamais vers une autre adresse", async () => {
  const pieges = ["https://evil.example", "//evil.example", "/\\evil.example", "https:evil.example", "%2F%2Fevil.example", "javascript:alert(1)"]
  const avec = (nom, p) => `/_portier/deconnexion?${nom}=${encodeURIComponent(p)}`
  // Sans session, tous les noms de paramètre courants ; avec une session ouverte, le paramètre « retour » du portier.
  for (const chemin of pieges.flatMap((p) => ["retour", "next", "redirect", "url", "continue"].map((nom) => avec(nom, p)))) {
    for (const methode of ["GET", "POST"]) {
      const r = await deconnecter(null, { methode, chemin })
      assert.equal(r.status, 303, `${methode} ${chemin}`)
      assert.equal(r.headers.get("location"), "/_portier/connexion", `${methode} ${chemin}`)
    }
  }
  for (const p of pieges) {
    for (const methode of ["GET", "POST"]) {
      const cookie = await connecter("alice@exemple.fr")
      const r = await deconnecter(cookie, { methode, chemin: avec("retour", p) })
      assert.equal(r.status, 303, `${methode} ${p}`)
      assert.equal(r.headers.get("location"), "/_portier/connexion", `${methode} ${p}`)
      assert.equal((await verifier(cookie)).status, 302)
    }
  }
  // Un corps de formulaire avec un retour n'est pas lu non plus.
  const corps = await appel("/_portier/deconnexion", { methode: "POST", corps: form({ retour: "https://evil.example" }), entetes: { ...formEntetes, origin: `https://prospecta.${BASE}` } })
  assert.equal(corps.headers.get("location"), "/_portier/connexion")
  // Une adresse annoncée par l'en-tête ne change rien non plus : la redirection reste relative.
  const r = await deconnecter(null, { hote: "evil.example" })
  assert.equal(r.headers.get("location"), "/_portier/connexion")
  // Et la page de connexion qui suit ne repart pas vers un autre site après la connexion.
  const p = await appel("/_portier/connexion?retour=https%3A%2F%2Fevil.example")
  assert.match(await p.text(), /name="retour" value="\/"/)
})

test("déconnexion de la console : la session d'administrateur est fermée, son cookie rejoué refusé", async () => {
  const r = await api("utilisateurs", "POST", { email: "chef@exemple.fr", role: "admin", applis: ["*"] })
  const jeton = new URL((await r.json()).lien).searchParams.get("jeton")
  await appel("/_portier/invitation", { methode: "POST", corps: form({ jeton, mot_de_passe: "un mot de passe solide", confirmation: "un mot de passe solide" }), entetes: formEntetes })
  const console_ = `console.${BASE}`
  const cookie = await connecter("chef@exemple.fr", console_)
  assert.equal((await verifier(cookie, console_)).status, 200)
  assert.deepEqual(await (await qui(cookie, console_)).json(), { email: "chef@exemple.fr", role: "admin", autorise: true })
  const d = await deconnecter(cookie, { hote: console_ })
  assert.equal(d.status, 303)
  assert.equal(d.headers.get("location"), "/_portier/connexion")
  efface(d)
  assert.equal((await verifier(cookie, console_)).status, 302)
  assert.equal((await appel("/_portier/verifier", { hote: console_, entetes: { cookie, "x-forwarded-uri": "/api/resume" } })).status, 401)
  assert.equal((await qui(cookie, console_)).status, 401)
})

test("se déconnecter d'une adresse ne ferme pas la session d'une autre", async () => {
  const ici = await connecter("alice@exemple.fr")
  const ailleurs = await connecter("alice@exemple.fr", `autre.${BASE}`)
  // Le cookie de prospecta présenté à la déconnexion d'« autre » (un cookie posé pour tout le domaine, par exemple) n'y vaut rien.
  await deconnecter(`${ailleurs}; ${ici}`, { hote: `autre.${BASE}` })
  assert.equal((await verifier(ailleurs, `autre.${BASE}`)).status, 302)
  assert.equal((await verifier(ici)).status, 200)
})

test("cinq échecs bloquent les essais", async () => {
  let dernier
  for (let i = 0; i < 6; i++) dernier = await appel("/_portier/connexion", { hote: `x${i}.${BASE}`, methode: "POST", corps: form({ email: "bob@exemple.fr", mot_de_passe: "faux" }), entetes: formEntetes })
  assert.equal(dernier.status, 429)
})
