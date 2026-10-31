// Google Drive : l'usine lit les documents d'un dossier que l'entreprise lui partage, pour
// créer un persona à partir de ce qui existe déjà (études, entretiens, tableaux).
//
// Par un compte de service Google : une adresse (…@….iam.gserviceaccount.com) avec qui on
// partage un dossier, comme avec un collègue. Pas de connexion à renouveler, pas de vérification
// d'application par Google, et l'usine ne voit que ce qu'on lui partage, en lecture seule.
// La clé du compte est chiffrée comme les identifiants des fournisseurs (chiffrer) et ne quitte
// jamais l'orchestrateur : l'agent qui cherche reçoit le contenu des fichiers, jamais la clé.
import { createSign } from "node:crypto"
import { chiffrer, dechiffrer } from "./fournisseurs.mjs"
import { ecrireReglage, lireReglage } from "./couts.mjs"
import { noter } from "./db.mjs"

const CLE = "drive_compte_service"
const API = "https://www.googleapis.com/drive/v3"
const PORTEE = "https://www.googleapis.com/auth/drive.readonly"
const TAILLE_MAX = 2 * 1024 * 1024 // comme une pièce jointe (pieces.mjs)
const erreur = (code, message) => Object.assign(new Error(message), { code })

// Les types lus, et comment : un document Google s'exporte, un fichier ordinaire se télécharge.
const EXPORTS = {
  "application/vnd.google-apps.document": { mime: "text/plain", ext: "txt" },
  "application/vnd.google-apps.spreadsheet": { mime: "text/csv", ext: "csv" },
  "application/vnd.google-apps.presentation": { mime: "text/plain", ext: "txt" },
}
const FICHIERS = { "application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }
const lisible = (mime) => Boolean(EXPORTS[mime] || FICHIERS[mime])
const DOSSIER = "application/vnd.google-apps.folder"

function lireEntree(db) {
  try {
    return JSON.parse(lireReglage(db, CLE, "null"))
  } catch {
    return null
  }
}

// Ce que voit la console : l'adresse avec qui partager, jamais la clé.
export function etatDrive(ctx) {
  const e = lireEntree(ctx.db)
  return e ? { configure: true, email: e.email, projet: e.projet, le: e.le, par: e.par } : { configure: false }
}

// La clé JSON téléchargée depuis Google Cloud (IAM, comptes de service, clés).
export function poserCompteDrive(ctx, texte, par) {
  let k
  try {
    k = JSON.parse(String(texte ?? "").trim())
  } catch {
    throw erreur(400, "Ce n'est pas le fichier de clé attendu : colle tout le contenu du fichier .json téléchargé depuis Google Cloud.")
  }
  if (k?.type !== "service_account" || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(String(k.client_email ?? "")) || !String(k.private_key ?? "").includes("BEGIN PRIVATE KEY")) {
    throw erreur(400, "Ce fichier n'est pas une clé de compte de service Google (type « service_account », avec client_email et private_key).")
  }
  const garde = JSON.stringify({ client_email: k.client_email, private_key: k.private_key, token_uri: k.token_uri ?? "https://oauth2.googleapis.com/token" })
  ecrireReglage(ctx.db, CLE, JSON.stringify({ ...chiffrer(ctx, garde), email: k.client_email, projet: String(k.project_id ?? "").slice(0, 100), le: new Date().toISOString(), par }))
  jeton = null
  noter(ctx.db, { projet: null, type: "reglage", message: `Google Drive branché (${k.client_email}) par ${par}` })
  return { ok: true, message: `Google Drive est branché. Partage tes dossiers avec ${k.client_email}.` }
}

export function retirerCompteDrive(ctx, par) {
  ctx.db.prepare("DELETE FROM reglages WHERE cle = ?").run(CLE)
  jeton = null
  noter(ctx.db, { projet: null, type: "reglage", message: `Google Drive débranché par ${par}` })
  return { ok: true, message: "Google Drive est débranché." }
}

// Le jeton d'accès : un JWT signé par la clé du compte, échangé contre un jeton d'une heure.
let jeton = null
const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url")
export function jwtCompte(compte, maintenant = Math.floor(Date.now() / 1000)) {
  const corps = `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ iss: compte.client_email, scope: PORTEE, aud: compte.token_uri, iat: maintenant, exp: maintenant + 3600 })}`
  return `${corps}.${createSign("RSA-SHA256").update(corps).sign(compte.private_key, "base64url")}`
}

async function jetonAcces(ctx) {
  if (jeton && jeton.expire > Date.now() + 60_000) return jeton.valeur
  const e = lireEntree(ctx.db)
  if (!e) throw erreur(409, "Google Drive n'est pas branché : Réglages, Intégrations, Google Drive.")
  const compte = JSON.parse(dechiffrer(ctx, e))
  let assertion
  try {
    assertion = jwtCompte(compte)
  } catch {
    throw erreur(400, "La clé du compte de service est illisible : dans Réglages, Intégrations, Google Drive, débranche puis recolle le fichier .json.")
  }
  const r = await fetch(compte.token_uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(20_000),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) throw erreur(502, `Google refuse la clé du compte de service (${j.error_description ?? j.error ?? r.status}). Vérifie qu'elle n'a pas été supprimée dans Google Cloud.`)
  jeton = { valeur: j.access_token, expire: Date.now() + Number(j.expires_in ?? 3600) * 1000 }
  return jeton.valeur
}

async function drive(ctx, chemin, { brut = false } = {}) {
  const r = await fetch(`${API}/${chemin}`, { headers: { authorization: `Bearer ${await jetonAcces(ctx)}` }, signal: AbortSignal.timeout(60_000) })
  if (!r.ok) {
    const j = await r.json().catch(() => ({}))
    throw Object.assign(new Error(j.error?.message ?? `Google Drive ${r.status}`), { statut: r.status })
  }
  return brut ? Buffer.from(await r.arrayBuffer()) : r.json()
}

// L'identifiant d'un dossier ou d'un fichier, quel que soit le lien collé.
export function idDepuisLien(lien) {
  const v = String(lien ?? "").trim()
  const m = /\/(?:folders|d)\/([A-Za-z0-9_-]{10,})/.exec(v) ?? /[?&]id=([A-Za-z0-9_-]{10,})/.exec(v) ?? /^([A-Za-z0-9_-]{10,})$/.exec(v)
  return m?.[1] ?? null
}

export async function testerDrive(ctx) {
  const e = lireEntree(ctx.db)
  if (!e) throw erreur(409, "Google Drive n'est pas branché.")
  await jetonAcces(ctx)
  const r = await drive(ctx, "files?pageSize=10&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true")
  const n = r.files?.length ?? 0
  return { ok: true, message: n ? `Google Drive répond : l'usine voit déjà ${n === 10 ? "au moins 10" : n} fichier(s) partagé(s).` : `Google Drive répond, mais rien n'est encore partagé avec ${e.email}.` }
}

// Les documents d'un lien (un dossier : ses fichiers lisibles les plus récents ; un fichier : lui),
// au format des pièces jointes ({ nom, type, base64 }) pour verifierPieces().
export async function documentsDrive(ctx, lien, { max = 5 } = {}) {
  const id = idDepuisLien(lien)
  if (!id) throw erreur(400, "Ce lien ne ressemble pas à un lien Google Drive (dossier, document, tableur ou fichier).")
  const email = etatDrive(ctx).email
  let meta
  try {
    meta = await drive(ctx, `files/${id}?fields=id,name,mimeType,size&supportsAllDrives=true`)
  } catch (e) {
    if (e.statut === 404 || e.statut === 403) throw erreur(409, `L'usine ne voit pas ce lien : partage le dossier ou le fichier avec ${email} (lecteur suffit).`)
    throw e
  }
  let fichiers = [meta]
  if (meta.mimeType === DOSSIER) {
    const q = encodeURIComponent(`'${id}' in parents and trashed = false`)
    const r = await drive(ctx, `files?q=${q}&orderBy=modifiedTime desc&pageSize=50&fields=files(id,name,mimeType,size)&supportsAllDrives=true&includeItemsFromAllDrives=true`)
    fichiers = (r.files ?? []).filter((f) => lisible(f.mimeType))
    if (!fichiers.length) throw erreur(409, `Ce dossier ne contient aucun document lisible (Google Docs, Sheets, Slides, PDF, texte, CSV, images).`)
  } else if (!lisible(meta.mimeType)) {
    throw erreur(400, `« ${meta.name} » : ce type de fichier n'est pas lu (Google Docs, Sheets, Slides, PDF, texte, CSV, images).`)
  }
  const docs = []
  for (const f of fichiers.slice(0, max)) {
    const exp = EXPORTS[f.mimeType]
    if (!exp && Number(f.size ?? 0) > TAILLE_MAX) continue
    const contenu = await drive(ctx, exp ? `files/${f.id}/export?mimeType=${encodeURIComponent(exp.mime)}` : `files/${f.id}?alt=media&supportsAllDrives=true`, { brut: true })
    const ext = exp?.ext ?? FICHIERS[f.mimeType]
    // Un export trop long est coupé (le début d'un long document suffit à la recherche) ; un binaire trop lourd est sauté.
    const garde = exp ? contenu.subarray(0, TAILLE_MAX) : contenu
    if (garde.length > TAILLE_MAX || !garde.length) continue
    docs.push({ nom: `${f.name.replace(/\.[a-z0-9]{2,5}$/i, "")}.${ext}`, type: ext === "pdf" ? "application/pdf" : exp ? exp.mime : f.mimeType, base64: garde.toString("base64") })
  }
  if (!docs.length) throw erreur(409, "Aucun document n'a pu être lu (fichiers vides ou de plus de 2 Mo).")
  return { docs, total: fichiers.length }
}
