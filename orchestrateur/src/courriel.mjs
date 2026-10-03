// Les emails de l'usine elle-même (invitations), par le service d'envoi du
// serveur (SMTP_HOST… dans .env, identifiants dans les secrets).
import nodemailer from "nodemailer"
import { secret } from "./config.mjs"

let transport = null

export const courrielConfigure = () => Boolean(process.env.SMTP_HOST && process.env.EMAIL_EXPEDITEUR)

function obtenirTransport() {
  transport ??= nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "1",
    ...(secret("smtp_user") ? { auth: { user: secret("smtp_user"), pass: secret("smtp_pass") } } : {}),
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  })
  return transport
}

const echapper = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

// L'invitation : un lien personnel (72 h) pour choisir son mot de passe.
export async function envoyerInvitation({ email, lien, role, applis = [], par }) {
  if (!courrielConfigure()) throw new Error("aucun service d'envoi configuré (SMTP_HOST, EMAIL_EXPEDITEUR)")
  const acces = role === "admin" ? "toutes les applications de l'usine, son tableau de bord et ses emails" : applis.includes("*") ? "toutes les applications de l'usine" : `les applications : ${applis.join(", ")}`
  const texte = `Bonjour,

${par} t'invite sur l'usine logicielle, avec accès à ${acces}.

Choisis ton mot de passe ici (lien personnel, valable 72 heures) :
${lien}

Si tu n'attendais pas cette invitation, ignore ce message.`
  const html = `<!doctype html><html lang="fr"><body style="margin:0;padding:24px;background:#f4f5f7;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px">
<p style="margin:0 0 16px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:#6b7280">Usine logicielle</p>
<p style="margin:0 0 12px;font-size:16px">Bonjour,</p>
<p style="margin:0 0 20px;font-size:16px;line-height:1.5">${echapper(par)} t'invite sur l'usine logicielle, avec accès à ${echapper(acces)}.</p>
<p style="margin:0 0 24px"><a href="${echapper(lien)}" style="display:inline-block;background:#1f2937;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">Choisir mon mot de passe</a></p>
<p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5">Lien personnel, valable 72 heures. Si tu n'attendais pas cette invitation, ignore ce message.</p>
</div></body></html>`
  await obtenirTransport().sendMail({ from: process.env.EMAIL_EXPEDITEUR, to: email, subject: "Ton accès à l'usine logicielle", text: texte, html })
}
