// Les chemins publics déclarés par un produit : seuls des chemins précis passent.
import { test } from "node:test"
import assert from "node:assert/strict"
import { CHEMINS_INTERNES, CHEMINS_PUBLICS, blocCaddy, cheminsDeclares } from "../chemins.mjs"
import { domainesValides, hotesValides, sousReseau } from "../chemins.mjs"

test("les chemins de l'usine sont publics par défaut", () => {
  assert.ok(CHEMINS_PUBLICS.includes("/api/health"))
  assert.ok(CHEMINS_PUBLICS.includes("/api/public/*"))
})

test("des chemins précis sont acceptés", () => {
  assert.deepEqual(cheminsDeclares('{"chemins_publics": ["/api/t/*", "/merci", "/merci"]}'), { chemins: ["/api/t/*", "/merci"], refuses: [] })
})

test("une déclaration trop large ou piégée est refusée", () => {
  const r = cheminsDeclares('{"chemins_publics": ["/", "/*", "/api/*", "/_portier/connexion", "/x/../admin", "api/t", "/a*b", 42]}')
  assert.deepEqual(r.chemins, [])
  assert.equal(r.refuses.length, 8)
})

test("les chemins réservés à l'usine ne deviennent jamais publics", () => {
  assert.deepEqual(CHEMINS_INTERNES, ["/_usine/*"])
  const r = cheminsDeclares('{"chemins_publics": ["/_usine/observabilite", "/_usine/*", "/merci"]}')
  assert.deepEqual(r, { chemins: ["/merci"], refuses: ["/_usine/observabilite", "/_usine/*"] })
  assert.ok(!CHEMINS_PUBLICS.some((c) => c.startsWith("/_usine")))
})

test("un fichier absent ou illisible ne déclare rien", () => {
  assert.deepEqual(cheminsDeclares(undefined), { chemins: [], refuses: [] })
  assert.deepEqual(cheminsDeclares("pas du json"), { chemins: [], refuses: [] })
})

test("domaines personnalisés : vrais noms, jamais l'usine, une adresse pour un seul produit", () => {
  const r = domainesValides([
    { produit: "prospecta", hotes: ["App.Client.fr", "x.exemple.test", "exemple.test", "pas un domaine", "app.client.fr"] },
    { produit: "autre", hotes: ["app.client.fr", "autre.fr"] },
    { produit: "../x", hotes: ["a.fr"] },
  ], "exemple.test")
  assert.deepEqual(r, { prospecta: ["app.client.fr"], autre: ["autre.fr"] })
})

test("un état souhaité ne prend que l'adresse que l'usine lui donne", () => {
  const base = "exemple.fr"
  assert.ok(hotesValides({ produit: "crm", environnement: "apercu", hote: "crm.apercu.exemple.fr", hote_mails: "mails.apercu.exemple.fr" }, base))
  assert.ok(hotesValides({ produit: "crm", environnement: "production", hote: "crm.exemple.fr" }, base))
  // L'adresse de la console, du portail, d'un autre produit : refusées.
  assert.equal(hotesValides({ produit: "crm", environnement: "production", hote: "console.exemple.fr" }, base), false)
  assert.equal(hotesValides({ produit: "crm", environnement: "production", hote: "autre.exemple.fr" }, base), false)
  assert.equal(hotesValides({ produit: "crm", environnement: "apercu", hote: "crm.apercu.exemple.fr", hote_mails: "console.exemple.fr" }, base), false)
  assert.equal(hotesValides({ produit: "console", environnement: "production", hote: "console.exemple.fr" }, base), false)
})

test("chaque produit a son sous-réseau, stable, et un autre au besoin", () => {
  assert.equal(sousReseau("crm"), sousReseau("crm"))
  assert.notEqual(sousReseau("crm", 0), sousReseau("crm", 1))
  assert.match(sousReseau("crm"), /^10\.231\.\d{1,3}\.(0|32|64|96|128|160|192|224)\/27$/)
})

test("blocCaddy : /_usine/* répond 404 au public, que l'application soit protégée ou publique", () => {
  const protege = blocCaddy("vigie.exemple.test", "usine-prod-vigie-blue:3000")
  const ouvert = blocCaddy("vigie.exemple.test", "usine-prod-vigie-blue:3000", { protege: false })
  for (const bloc of [protege, ouvert]) {
    assert.match(bloc, /\thandle \/_usine\/\* \{\n\t\trespond 404\n\t\}/)
    assert.match(bloc, /request_header -X-Usine-Utilisateur/)
  }
  // Protégée : le portier garde tout le reste, les chemins publics passent sans lui.
  assert.match(protege, /forward_auth portier:8080/)
  assert.match(protege, /@public path \/api\/health /)
  // Publique : tout le reste va à l'application, sans portier.
  assert.ok(!ouvert.includes("forward_auth"))
  assert.match(ouvert, /\thandle \{\n\t\treverse_proxy usine-prod-vigie-blue:3000\n\t\}/)
  assert.ok(blocCaddy("h.test", "c:3000", { https: false }).startsWith("http://h.test {"))
})

test("les chemins réservés ne passent ni en majuscules, ni par un joker qui les couvre", async () => {
  const r = cheminsDeclares('{"chemins_publics": ["/_USINE/observabilite", "/_usin*", "/_u*", "/_Portier/x", "/_p*", "/un-autre/*", "/merci"]}')
  assert.deepEqual(r.chemins, ["/un-autre/*", "/merci"])
  // Le chemin que la sonde appelle est bien couvert par les chemins internes.
  const { CHEMIN_OBSERVABILITE } = await import("../sonde.mjs")
  assert.ok(CHEMINS_INTERNES.some((c) => (c.endsWith("*") ? CHEMIN_OBSERVABILITE.startsWith(c.slice(0, -1)) : c === CHEMIN_OBSERVABILITE)))
})

test("les chemins réservés se comparent par segment, sans contournement par « // » ou « . »", () => {
  const r = cheminsDeclares('{"chemins_publics": ["/_usines/*", "/_uploads/*", "/_up/*", "//_usine/*", "/./_usine/*", "/a/./b", "/_portier*"]}')
  assert.deepEqual(r.chemins, ["/_usines/*", "/_uploads/*", "/_up/*"])
  assert.deepEqual(r.refuses, ["//_usine/*", "/./_usine/*", "/a/./b", "/_portier*"])
})
