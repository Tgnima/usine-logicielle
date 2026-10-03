// Envoyer un email. Fichier protégé : c'est la barrière qui empêche un produit
// d'écrire à n'importe qui.
//   - démo : SMTP_HOST pointe vers Mailpit, qui capture tout et le montre dans une page web ;
//   - situation réelle : un vrai service d'envoi (SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
//     SMTP_SECURE), et EMAIL_DESTINATAIRES_AUTORISES limite les destinataires à des contacts
//     de test (« alice@exemple.fr, @mon-domaine.fr ») : les autres ne reçoivent rien ;
//   - sans SMTP_HOST (tests), l'email est seulement renvoyé, pas envoyé.
import nodemailer from "nodemailer"

let transport = null

// Vide = tout le monde. Sinon des adresses exactes ou des domaines (« @exemple.fr »).
export function destinataireAutorise(adresse, liste = process.env.EMAIL_DESTINATAIRES_AUTORISES ?? "") {
  const regles = liste.split(/[,;\s]+/).map((r) => r.trim().toLowerCase()).filter(Boolean)
  if (regles.length === 0) return true
  const a = String(adresse).trim().toLowerCase()
  return regles.some((r) => (r.startsWith("@") ? a.endsWith(r) : a === r))
}

export async function envoyer({ a, de = process.env.EMAIL_EXPEDITEUR ?? "demo@usine.local", sujet, texte, html }) {
  if (!process.env.SMTP_HOST || process.env.NODE_TEST_CONTEXT) return { envoye: false, a, sujet }
  if (!destinataireAutorise(a)) {
    console.warn(`Email non envoyé à ${a} : hors des destinataires autorisés.`)
    return { envoye: false, bloque: true, a, sujet }
  }
  transport ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: process.env.SMTP_SECURE === "1",
    ...(process.env.SMTP_USER ? { auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS ?? "" } } : {}),
  })
  const info = await transport.sendMail({ from: de, to: a, subject: sujet, text: texte, html })
  return { envoye: true, a, sujet, id: info.messageId }
}
