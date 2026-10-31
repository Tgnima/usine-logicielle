// Google Drive : la clé du compte de service (chiffrée, jamais renvoyée), les liens, le jeton signé,
// et la lecture d'un dossier partagé (Google simulé : aucune connexion réelle).
import { test, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createVerify, generateKeyPairSync } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ouvrirDb } from "../src/db.mjs"
import { ouvrirCouts } from "../src/couts.mjs"
import { documentsDrive, etatDrive, idDepuisLien, jwtCompte, poserCompteDrive, retirerCompteDrive } from "../src/google-drive.mjs"
import { creerPersona, documentsPersona } from "../src/personas.mjs"

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
const CLE_PRIVEE = privateKey.export({ type: "pkcs8", format: "pem" })
const CLE = JSON.stringify({ type: "service_account", project_id: "usine-essai", private_key: CLE_PRIVEE, client_email: "usine@usine-essai.iam.gserviceaccount.com", token_uri: "https://oauth2.googleapis.com/token" })

const ctxDe = () => {
  const dossier = mkdtempSync(join(tmpdir(), "drive-"))
  const db = ouvrirDb(join(dossier, "usine.db"))
  ouvrirCouts(db)
  return { db, config: { atelier: { url: "http://127.0.0.1:1" }, secrets: { worker: "jeton-de-test-du-serveur" }, modeles: { analyste: { modele: "m" } }, dataDir: dossier } }
}
const vrai = globalThis.fetch
afterEach(() => (globalThis.fetch = vrai))

// Un faux Google : le jeton, un dossier avec un Google Doc, un Sheet, un PDF et une vidéo (non lue).
function fauxGoogle({ visible = true } = {}) {
  const appels = []
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url)
    appels.push(u)
    const json = (corps, statut = 200) => new Response(JSON.stringify(corps), { status: statut, headers: { "content-type": "application/json" } })
    if (u.startsWith("https://oauth2.googleapis.com/token")) {
      const assertion = new URLSearchParams(String(options.body)).get("assertion")
      const [entete, corps, signature] = assertion.split(".")
      const ok = createVerify("RSA-SHA256").update(`${entete}.${corps}`).verify(publicKey, signature, "base64url")
      return ok ? json({ access_token: "jeton-acces", expires_in: 3600 }) : json({ error: "invalid_grant" }, 400)
    }
    if (!visible) return json({ error: { message: "File not found" } }, 404)
    if (u.includes("/files/dossier1234567?")) return json({ id: "dossier1234567", name: "Entretiens", mimeType: "application/vnd.google-apps.folder" })
    if (u.includes("/files?q=")) return json({ files: [
      { id: "doc1234567890", name: "Synthèse entretiens", mimeType: "application/vnd.google-apps.document" },
      { id: "feuille123456", name: "Retours clients", mimeType: "application/vnd.google-apps.spreadsheet" },
      { id: "pdf1234567890", name: "Étude.pdf", mimeType: "application/pdf", size: "20" },
      { id: "video12345678", name: "Démo.mp4", mimeType: "video/mp4", size: "9000000" },
    ] })
    if (u.includes("/files/doc1234567890/export")) return new Response("Les gérants manquent de temps.")
    if (u.includes("/files/feuille123456/export")) return new Response("date;avis\n2026-10-01;trop long")
    if (u.includes("/files/pdf1234567890?alt=media")) return new Response(Buffer.from("%PDF-1.4 essai"))
    return json({ error: { message: `inattendu ${u}` } }, 500)
  }
  return appels
}

test("les liens Drive : dossier, document, tableur, fichier, identifiant seul", () => {
  assert.equal(idDepuisLien("https://drive.google.com/drive/folders/1AbC_dEf-GhIjKlMn?usp=sharing"), "1AbC_dEf-GhIjKlMn")
  assert.equal(idDepuisLien("https://docs.google.com/document/d/1XyZ0123456789abc/edit"), "1XyZ0123456789abc")
  assert.equal(idDepuisLien("https://docs.google.com/spreadsheets/d/1Sheet0123456789/edit#gid=0"), "1Sheet0123456789")
  assert.equal(idDepuisLien("https://drive.google.com/open?id=1Open0123456789"), "1Open0123456789")
  assert.equal(idDepuisLien("1Brut0123456789"), "1Brut0123456789")
  assert.equal(idDepuisLien("https://exemple.fr"), null)
})

test("la clé du compte de service : vérifiée, chiffrée, jamais renvoyée ; le jeton est signé par elle", () => {
  const ctx = ctxDe()
  assert.throws(() => poserCompteDrive(ctx, "pas du json", "a"), /fichier de clé/)
  assert.throws(() => poserCompteDrive(ctx, JSON.stringify({ type: "authorized_user" }), "a"), /compte de service/)
  poserCompteDrive(ctx, CLE, "a")
  const base = JSON.stringify(ctx.db.prepare("SELECT * FROM reglages").all())
  assert.ok(!base.includes("PRIVATE KEY") && !base.includes(CLE_PRIVEE.slice(40, 80)))
  assert.deepEqual(Object.keys(etatDrive(ctx)).sort(), ["configure", "email", "le", "par", "projet"])
  assert.equal(etatDrive(ctx).email, "usine@usine-essai.iam.gserviceaccount.com")
  const [entete, corps, signature] = jwtCompte(JSON.parse(CLE), 1_700_000_000).split(".")
  assert.ok(createVerify("RSA-SHA256").update(`${entete}.${corps}`).verify(publicKey, signature, "base64url"))
  assert.equal(JSON.parse(Buffer.from(corps, "base64url")).scope, "https://www.googleapis.com/auth/drive.readonly")
  retirerCompteDrive(ctx, "a")
  assert.equal(etatDrive(ctx).configure, false)
})

test("un dossier partagé : les Docs exportés en texte, les Sheets en CSV, les PDF tels quels ; le reste est ignoré", async () => {
  const ctx = ctxDe()
  poserCompteDrive(ctx, CLE, "a")
  fauxGoogle()
  const { docs, total } = await documentsDrive(ctx, "https://drive.google.com/drive/folders/dossier1234567")
  assert.equal(total, 3)
  assert.deepEqual(docs.map((d) => d.nom), ["Synthèse entretiens.txt", "Retours clients.csv", "Étude.pdf"])
  assert.equal(Buffer.from(docs[0].base64, "base64").toString(), "Les gérants manquent de temps.")
})

test("créer un public depuis Drive : les documents sont gardés ; un lien non partagé dit avec qui partager", async () => {
  const ctx = ctxDe()
  poserCompteDrive(ctx, CLE, "a")
  fauxGoogle()
  const r = await creerPersona(ctx, { nom: "Gérant pressé", drive: "https://drive.google.com/drive/folders/dossier1234567", par: "a@b" })
  assert.ok(r.ok, r.message)
  assert.deepEqual(documentsPersona(ctx.config, r.id).map((d) => d.nom), ["1-Synthese-entretiens.txt", "2-Retours-clients.csv", "3-Etude.pdf"])
  fauxGoogle({ visible: false })
  const refus = await creerPersona(ctx, { nom: "Autre", drive: "https://drive.google.com/drive/folders/inconnu12345678", par: "a@b" })
  assert.equal(refus.ok, false)
  assert.match(refus.message, /usine@usine-essai\.iam\.gserviceaccount\.com/)
})
