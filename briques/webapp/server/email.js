// Envoyer un email. En démo, SMTP_HOST pointe vers Mailpit : il capture tous les
// emails et les montre dans une page web ; rien ne part vers de vraies boîtes.
// Sans SMTP_HOST (tests), l'email est seulement renvoyé, pas envoyé.
import nodemailer from "nodemailer"

let transport = null

export async function envoyer({ a, de = process.env.EMAIL_EXPEDITEUR ?? "demo@usine.local", sujet, texte, html }) {
  if (!process.env.SMTP_HOST || process.env.NODE_TEST_CONTEXT) return { envoye: false, a, sujet }
  transport ??= nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 1025), secure: false })
  const info = await transport.sendMail({ from: de, to: a, subject: sujet, text: texte, html })
  return { envoye: true, a, sujet, id: info.messageId }
}
