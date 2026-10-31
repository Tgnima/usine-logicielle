// Les jetons « depuis ma machine » : un script, ou l'assistant de la personne (Claude Code…),
// envoie une fiche de persona à l'usine sans passer par le navigateur.
//
// Un jeton (usp_…) ne sert qu'à une chose : POST /api/import/personas sur la console. Le portier
// laisse passer cette seule adresse quand elle porte un jeton de ce format (portier/server.mjs),
// et la console le vérifie ici : empreinte HMAC (jamais le jeton en clair), comparaison à temps
// constant, et trop d'échecs depuis une même adresse bloquent les essais.
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto"
import { ecrireReglage, lireReglage } from "./couts.mjs"
import { noter } from "./db.mjs"

const CLE = "jetons_personas"
const JETONS_MAX = 10
export const FORMAT = /^usp_[A-Za-z0-9_-]{40,60}$/
const erreur = (code, message) => Object.assign(new Error(message), { code })

const secret = (ctx) => {
  const base = String(ctx.config.secrets.worker ?? "")
  if (!base) throw erreur(503, "Le serveur n'a pas de secret pour signer les jetons (worker_token).")
  return Buffer.from(hkdfSync("sha256", base, "usine-logicielle", "jetons des personas", 32))
}
const empreinte = (ctx, jeton) => createHmac("sha256", secret(ctx)).update(jeton).digest("hex")
const lire = (db) => {
  try {
    return JSON.parse(lireReglage(db, CLE, "[]")) ?? []
  } catch {
    return []
  }
}

// Ce que voit la console : le nom, le début du jeton, qui l'a créé et quand il a servi.
export const listerJetons = (ctx) => lire(ctx.db).map(({ empreinte: _e, ...j }) => j)

export function creerJeton(ctx, nom, par) {
  const n = String(nom ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60)
  if (n.length < 2) throw erreur(400, "Donne un nom au jeton (par exemple : « Mon ordinateur »).")
  const liste = lire(ctx.db)
  if (liste.length >= JETONS_MAX) throw erreur(409, `Au plus ${JETONS_MAX} jetons : retires-en un d'abord.`)
  const jeton = `usp_${randomBytes(36).toString("base64url")}`
  const id = Math.max(0, ...liste.map((j) => j.id)) + 1
  ecrireReglage(ctx.db, CLE, JSON.stringify([...liste, { id, nom: n, debut: jeton.slice(0, 9), empreinte: empreinte(ctx, jeton), le: new Date().toISOString(), par, utilise_le: null }]))
  noter(ctx.db, { projet: null, type: "reglage", message: `Jeton « ${n} » (envoi de personas) créé par ${par}` })
  // Le jeton n'est montré qu'une fois, à qui vient de le créer.
  return { ok: true, id, jeton, message: "Jeton créé. Copie-le maintenant : il ne sera plus affiché." }
}

export function retirerJeton(ctx, id, par) {
  const liste = lire(ctx.db)
  const j = liste.find((x) => x.id === Number(id))
  if (!j) throw erreur(404, "Jeton introuvable.")
  ecrireReglage(ctx.db, CLE, JSON.stringify(liste.filter((x) => x.id !== j.id)))
  noter(ctx.db, { projet: null, type: "reglage", message: `Jeton « ${j.nom} » (envoi de personas) retiré par ${par}` })
  return { ok: true, message: "Jeton retiré : il ne fonctionne plus." }
}

// Le jeton présenté (« Authorization: Bearer usp_… ») : son nom s'il est valide, sinon null.
export function verifierJeton(ctx, entete) {
  const [type, valeur] = String(entete ?? "").split(" ")
  if (type !== "Bearer" || !FORMAT.test(valeur ?? "")) return null
  const e = Buffer.from(empreinte(ctx, valeur), "hex")
  const liste = lire(ctx.db)
  const j = liste.find((x) => {
    const autre = Buffer.from(x.empreinte, "hex")
    return autre.length === e.length && timingSafeEqual(autre, e)
  })
  if (!j) return null
  ecrireReglage(ctx.db, CLE, JSON.stringify(liste.map((x) => (x.id === j.id ? { ...x, utilise_le: new Date().toISOString() } : x))))
  return j.nom
}

// Trop d'échecs depuis une adresse : 10 par quart d'heure.
const echecs = new Map()
export function tropDEchecs(ip) {
  const maintenant = Date.now()
  const l = (echecs.get(ip) ?? []).filter((t) => maintenant - t < 15 * 60_000)
  echecs.set(ip, l)
  return l.length >= 10
}
export const noterEchec = (ip) => echecs.set(ip, [...(echecs.get(ip) ?? []), Date.now()])
