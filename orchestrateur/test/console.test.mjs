// La console de l'usine, de bout en bout : une vraie console sur une base d'essai,
// derrière un faux portier. Accès réservé, actions protégées, règles métier.
import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dossier = mkdtempSync(join(tmpdir(), "console-test-"))
let portier, console_, base, ctx
let invite = null // le dernier compte envoyé au portier
const utilisateurs = [
  { id: 1, email: "admin@exemple.test", role: "admin", applis: ["*"], actif: 1, active: 1 },
  { id: 2, email: "marie@exemple.test", role: "membre", applis: ["prospecta"], actif: 1, active: 0 },
]

before(async () => {
  // Le faux portier : la session vient d'un cookie « s=admin » ou « s=membre ».
  portier = createServer((req, res) => {
    const s = /s=(\w+)/.exec(req.headers.cookie ?? "")?.[1]
    if (req.url === "/_portier/api/utilisateurs" && req.method === "POST") {
      let b = ""
      req.on("data", (x) => (b += x))
      return req.on("end", () => {
        invite = JSON.parse(b)
        // Le vrai portier refuse un email mal formé avec un 400.
        const refus = !invite.email.includes("@")
        res.writeHead(refus ? 400 : 201, { "content-type": "application/json" })
        res.end(JSON.stringify(refus ? { erreur: "email invalide" } : { id: 9, lien: "http://exemple.test/invitation" }))
      })
    }
    res.writeHead(req.url.startsWith("/_portier/qui") && !s ? 401 : 200, { "content-type": "application/json" })
    if (req.url.startsWith("/_portier/qui")) {
      if (!s) return res.end("{}")
      return res.end(JSON.stringify({ email: `${s}@exemple.test`, role: s === "admin" ? "admin" : "membre", autorise: true }))
    }
    if (req.url === "/_portier/api/utilisateurs" && req.method === "GET") return res.end(JSON.stringify(utilisateurs))
    if (req.url.startsWith("/_portier/api/cles")) return res.end(req.method === "GET" ? "[]" : JSON.stringify({ id: 1, cle: "usk_essai" }))
    res.end("{}")
  }).listen(0)
  await new Promise((r) => portier.once("listening", r))
  process.env.PORTIER_URL = `http://127.0.0.1:${portier.address().port}`
  process.env.PORTIER_API_TOKEN = "j".repeat(40)

  const { ouvrirDb } = await import("../src/db.mjs")
  const { ouvrirCouts } = await import("../src/couts.mjs")
  const { ouvrirCycle } = await import("../src/cycle.mjs")
  const { ouvrirDomaines } = await import("../src/domaines.mjs")
  const { traiter } = await import("../src/console.mjs")
  const db = ouvrirDb(join(dossier, "usine.db"))
  ouvrirCouts(db)
  ouvrirCycle(db)
  ouvrirDomaines(db)
  const config = {
    domaine: { base: "exemple.test", https: true }, dataDir: dossier, etatDir: dossier,
    atelier: { url: "http://127.0.0.1:1" }, verificateur: { url: "http://127.0.0.1:1" },
    secrets: { github: "jeton-de-test", worker: "x" }, github: { proprietaire: "essai", depot_etat: "etat" },
    modeles: { analyste: { modele: "m" }, atelier: { modele: "m" } }, slack: { canal: "", admins: [] },
    perimetre_protege: ["Dockerfile", "docs/DESIGN.md"], couts: {}, budget: {},
  }
  const silence = async () => {}
  ctx = { config, db, notifier: { etape: silence, questions: silence, plan: silence, escalade: silence, alerte: silence, progres: silence, lotLivre: silence, rapportFinal: silence, escaladeResolue: silence } }

  const plan = { nom: "Relais", slug: "relais", resume: "r", lots: [{ nom: "Socle", objectif: "o", taches: [{ cle: "T1", titre: "Liste", description: "d", criteres: ["GET /api/x renvoie 200"], depend_de: [] }] }],
    design: { intention: "i", palette: { primaire: "#112233", accent: "#445566", fond: "#ffffff", surface: "#f5f5f5", texte: "#111111", doux: "#555555", succes: "#1d7a46", alerte: "#b35309", danger: "#b42318" }, typographie: { titres: "A", texte: "B" }, ton: "t", references: "r", a_eviter: ["x"] } }
  const ins = db.prepare("INSERT INTO projets (prompt, statut, nom, slug, plan) VALUES (?, ?, ?, ?, ?)")
  ins.run("Une application d'essai", "plan_a_valider", "Relais", "relais", JSON.stringify(plan))
  ins.run("Une autre application", "fabrication", "Prospecta", "prospecta", JSON.stringify(plan))
  db.prepare("INSERT INTO escalades (projet_id, raison, options) VALUES (2, 'criteres', ?)").run(JSON.stringify([{ cle: "A", libelle: "Réessayer", detail: "" }]))

  console_ = createServer((req, res) => traiter(ctx, req, res)).listen(0)
  await new Promise((r) => console_.once("listening", r))
  base = `http://127.0.0.1:${console_.address().port}`
})
after(() => {
  portier.close()
  console_.close()
})

const appel = (chemin, { methode = "GET", corps, session = "admin", origine = base, type = "application/json" } = {}) =>
  fetch(`${base}${chemin}`, {
    method: methode,
    headers: { ...(session ? { cookie: `s=${session}` } : {}), ...(origine ? { origin: origine } : {}), ...(corps !== undefined ? { "content-type": type } : {}), host: new URL(base).host },
    body: corps === undefined ? undefined : typeof corps === "string" ? corps : JSON.stringify(corps),
  })
const json = async (r) => ({ statut: r.status, corps: await r.json().catch(() => ({})) })

test("sans session ou sans être administrateur : refusé", async () => {
  assert.equal((await appel("/api/resume", { session: null })).status, 403)
  assert.equal((await appel("/api/resume", { session: "membre" })).status, 403)
  assert.equal((await appel("/", { session: null })).status, 403)
})

test("le résumé liste les projets et ce qui attend une décision", async () => {
  const { statut, corps } = await json(await appel("/api/resume"))
  assert.equal(statut, 200)
  assert.equal(corps.projets.length, 2)
  assert.ok(corps.a_traiter.some((x) => x.type === "plan" && x.projet === 1))
  assert.ok(corps.a_traiter.some((x) => x.type === "decision" && /critères/.test(x.detail)), "la raison d'une décision est écrite en clair")
})

test("une action exige du JSON et la même origine", async () => {
  assert.equal((await appel("/api/usine/stop", { methode: "POST", corps: {}, origine: null })).status, 403)
  assert.equal((await appel("/api/usine/stop", { methode: "POST", corps: {}, origine: "https://ailleurs.example" })).status, 403)
  assert.equal((await appel("/api/usine/stop", { methode: "POST", corps: {}, origine: "null" })).status, 403)
  assert.equal((await appel("/api/usine/stop", { methode: "POST", corps: "x=1", type: "application/x-www-form-urlencoded" })).status, 415)
})

test("une demande trop courte ou une pièce jointe invalide est refusée ; une vraie image est gardée", async () => {
  assert.equal((await appel("/api/projets", { methode: "POST", corps: { prompt: "court" } })).status, 400)
  const faux = await json(await appel("/api/projets", { methode: "POST", corps: { prompt: "Une application de suivi des congés d'équipe", pieces: [{ nom: "x.png", type: "image/png", base64: Buffer.from("pas une image").toString("base64") }] } }))
  assert.equal(faux.statut, 400)
  assert.match(faux.corps.erreur, /vrai fichier PNG/)
  assert.equal((await appel("/api/projets", { methode: "POST", corps: { prompt: "Une application de suivi des congés d'équipe", pieces: [{ nom: "x.gif", type: "image/gif", base64: "R0lG" }] } })).status, 400)
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)])
  const ok = await json(await appel("/api/projets", { methode: "POST", corps: { prompt: "Une application de suivi des congés d'équipe", pieces: [{ nom: "Maquette accueil.png", type: "image/png", base64: png.toString("base64") }] } }))
  assert.equal(ok.statut, 200)
  assert.deepEqual(readdirSync(join(dossier, "pieces", String(ok.corps.id))), ["1-Maquette-accueil.png"])
})

test("le plan : modifiable avant validation seulement, jamais vers un fichier protégé", async () => {
  const { corps: p } = await json(await appel("/api/projets/1"))
  assert.equal((await appel("/api/projets/2/plan", { methode: "PUT", corps: { plan: p.plan } })).status, 409)
  const protege = structuredClone(p.plan)
  protege.lots[0].taches[0].description = "Ajouter à docs/DESIGN.md une section « Revue »."
  const r = await json(await appel("/api/projets/1/plan", { methode: "PUT", corps: { plan: protege } }))
  assert.equal(r.statut, 400)
  assert.match(r.corps.erreur, /fichier protégé/)
  const modifie = structuredClone(p.plan)
  modifie.lots.push({ nom: "Tableau", objectif: "o", taches: [{ cle: "T2", titre: "Graphique", description: "d", criteres: ["La page /tableau s'affiche"], depend_de: ["T1"] }] })
  assert.equal((await appel("/api/projets/1/plan", { methode: "PUT", corps: { plan: modifie } })).status, 200)
  const { corps: apres } = await json(await appel("/api/projets/1"))
  assert.equal(apres.plan.lots.length, 2)
})

test("la production : confirmation, destinataires et statut obligatoires", async () => {
  assert.equal((await appel("/api/projets/2/production", { methode: "POST", corps: {} })).status, 400)
  assert.equal((await appel("/api/projets/2/production", { methode: "POST", corps: { confirme: true, emails: "reels", destinataires_autorises: "" } })).status, 400)
  const r = await json(await appel("/api/projets/2/production", { methode: "POST", corps: { confirme: true } }))
  assert.equal(r.statut, 409)
  assert.match(r.corps.erreur, /fabrication/)
})

test("une décision inexistante ou une option inconnue est refusée", async () => {
  assert.equal((await appel("/api/escalades/1", { methode: "POST", corps: { choix: "Z" } })).status, 409)
  assert.equal((await appel("/api/escalades/99", { methode: "POST", corps: { choix: "A" } })).status, 409)
})

test("accès : ni son propre compte, ni réinviter un compte existant", async () => {
  assert.equal((await appel("/api/acces/utilisateurs/1", { methode: "DELETE", corps: {} })).status, 409)
  assert.equal((await appel("/api/acces/utilisateurs", { methode: "POST", corps: { email: "marie@exemple.test" } })).status, 409)
})

test("accès : le rôle se change dans la liste, sauf le sien", async () => {
  assert.equal((await appel("/api/acces/utilisateurs/1", { methode: "PATCH", corps: { role: "membre" } })).status, 409)
  const r = await json(await appel("/api/acces/utilisateurs/2", { methode: "PATCH", corps: { role: "admin" } }))
  assert.equal(r.statut, 200)
  assert.match(r.corps.message, /administrateur/)
})

test("audit : textes bornés, projet inconnu en 404, choix d'option contraint", async () => {
  assert.equal((await appel("/api/projets/99/corriger", { methode: "POST", corps: { texte: "Le bouton ne marche pas" } })).status, 404)
  assert.equal((await appel("/api/projets/1/corriger", { methode: "POST", corps: { texte: "  " } })).status, 400)
  assert.equal((await appel("/api/projets/99/corriger-recette", { methode: "POST", corps: {} })).status, 404)
  assert.equal((await appel("/api/escalades/1", { methode: "POST", corps: { choix: "AB" } })).status, 400)
})

test("audit : l'invitation part nettoyée, et un refus du portier garde son message", async () => {
  const r = await appel("/api/acces/utilisateurs", { methode: "POST", corps: { email: "  Nouveau@Exemple.test ", role: "chef", applis: ["prospecta", "../x", "*", "Avec Espace"] } })
  assert.equal(r.status, 200)
  assert.deepEqual({ email: invite.email, role: invite.role, applis: invite.applis }, { email: "nouveau@exemple.test", role: "membre", applis: ["prospecta", "*"] })
  const refus = await json(await appel("/api/acces/utilisateurs", { methode: "POST", corps: { email: "sans-arobase" } }))
  assert.equal(refus.statut, 400)
  assert.match(refus.corps.erreur, /refuse : email invalide/)
})

test("connecteurs : le catalogue sans clé, un identifiant inconnu en 404, une adresse non https refusée", async () => {
  const r = await json(await appel("/api/connecteurs"))
  assert.equal(r.statut, 200)
  assert.ok(r.corps.connecteurs.some((c) => c.id === "documentation") && r.corps.connecteurs.every((c) => !c.serveur))
  assert.equal((await appel("/api/connecteurs/inconnu", { methode: "PUT", corps: { actif: true, roles: ["plan"] } })).status, 404)
  assert.equal((await appel("/api/connecteurs", { methode: "POST", corps: { nom: "Outil", adresse: "http://outil.exemple.test" } })).status, 400)
  const a = await json(await appel("/api/connecteurs/documentation", { methode: "PUT", corps: { actif: true, roles: ["plan"] } }))
  assert.equal(a.statut, 200)
})

test("depuis une machine : une fiche s'importe avec un jeton, sans session ; sans jeton valide, rien", async () => {
  const { corps: { jeton } } = await json(await appel("/api/personas/jetons", { methode: "POST", corps: { nom: "Mon ordinateur" } }))
  const envoyer = (entete, corps) => fetch(`${base}/api/import/personas`, { method: "POST", headers: { "content-type": "application/json", ...(entete ? { authorization: entete } : {}) }, body: JSON.stringify(corps) })
  const fiche = { nom: "Gérante de salon", fiche: { resume: "Gérante d'un salon de coiffure de quartier." } }
  assert.equal((await envoyer(null, fiche)).status, 401)
  assert.equal((await envoyer("Bearer usp_" + "x".repeat(48), fiche)).status, 401)
  const r = await json(await envoyer(`Bearer ${jeton}`, fiche))
  assert.equal(r.statut, 201)
  assert.match(r.corps.adresse, /^\/#\/personas\/\d+$/)
  assert.equal((await envoyer(`Bearer ${jeton}`, { fiche: {} })).status, 400)
  // Le jeton n'ouvre rien d'autre de la console.
  const autre = await fetch(`${base}/api/personas`, { headers: { authorization: `Bearer ${jeton}` } })
  assert.equal(autre.status, 403)
})

test("aucun fichier hors de la console, aucune capture hors de son dossier", async () => {
  assert.equal((await appel("/..%2f..%2fsrc%2fconsole.mjs")).status, 404)
  assert.equal((await appel("/api/captures/1/T1/..%2f..%2fusine.db")).status, 404)
  assert.ok(!existsSync(join(dossier, "captures")))
})

test("l'historique dit qui a fait quoi ; l'estimation n'invente rien sans historique", async () => {
  const { corps: h } = await json(await appel("/api/historique?type=demande"))
  assert.ok(h.some((x) => x.type === "demande" && x.par === "admin@exemple.test"))
  const { corps: plan } = await json(await appel("/api/historique?type=plan"))
  assert.ok(plan.some((x) => /modifié dans la console par admin@exemple.test/.test(x.message)))
  const { corps: e } = await json(await appel("/api/estimation"))
  assert.equal(e.disponible, false)
})

test("personas : création par la console, et un persona non validé ne sert à aucun projet", async () => {
  const cree = await json(await appel("/api/personas", { methode: "POST", corps: { nom: "Commerçant de quartier", brief: "Une boulangerie de quartier sans site web, avec des avis Google." } }))
  assert.equal(cree.statut, 200)
  const liste = await json(await appel("/api/personas"))
  assert.ok(liste.corps.personas.some((p) => p.id === cree.corps.id))
  assert.equal((await appel("/api/personas", { methode: "POST", corps: { nom: "X", brief: "court" } })).status, 409)
  const refuse = await json(await appel("/api/projets", { methode: "POST", corps: { prompt: "Une application de suivi pour les commerçants du quartier.", persona_id: cree.corps.id } }))
  assert.equal(refuse.statut, 409)
  assert.match(refuse.corps.erreur, /pas validé/)
})

test("reprendre un dépôt : une adresse illisible est refusée avant tout appel à GitHub", async () => {
  const r = await json(await appel("/api/projets/reprendre", { methode: "POST", corps: { adresse: "https://gitlab.com/o/r" } }))
  assert.equal(r.statut, 409)
  assert.match(r.corps.erreur, /illisible/)
  assert.equal((await appel("/api/projets/reprendre", { methode: "POST", corps: {} })).status, 400)
})
