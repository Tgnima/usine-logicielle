// Le formulaire de contact : valider, enregistrer, prévenir (si EMAIL_CONTACT est défini).
import { db } from "../db.js"
import { envoyer } from "../email.js"
import { maintenant } from "../horloge.js"

const erreur = (message) => Object.assign(new Error(message), { status: 400 })

export async function recevoirMessage({ nom, email, message } = {}) {
  const n = String(nom ?? "").trim()
  const e = String(email ?? "").trim()
  const m = String(message ?? "").trim()
  if (n.length < 2 || n.length > 100) throw erreur("Indique ton nom.")
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) throw erreur("L'adresse email n'est pas valide.")
  if (m.length < 10 || m.length > 5000) throw erreur("Le message doit faire entre 10 et 5 000 caractères.")
  const id = Number(db().prepare("INSERT INTO messages (nom, email, message, recu_le) VALUES (?, ?, ?, ?)").run(n, e, m, maintenant().toISOString()).lastInsertRowid)
  if (process.env.EMAIL_CONTACT) {
    await envoyer({ a: process.env.EMAIL_CONTACT, sujet: `Nouveau message de ${n}`, texte: `${n} <${e}>\n\n${m}` }).catch((x) => console.error("Contact :", x.message))
  }
  return { id }
}
