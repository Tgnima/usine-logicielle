// Les emails de l'usine elle-même (invitations). Le service d'envoi : celui branché dans la
// console (services.mjs, reglerCourriel), sinon celui du serveur (SMTP_HOST… dans .env,
// identifiants dans les secrets). Le transport est recréé à chaque changement.
import nodemailer from "nodemailer"
import { secret } from "./config.mjs"

// Le service d'envoi du serveur (.env et secrets), en un bloc.
export const courrielDuServeur = () => ({ hote: process.env.SMTP_HOST ?? "", port: process.env.SMTP_PORT ?? "", securite: process.env.SMTP_SECURE ?? "", expediteur: process.env.EMAIL_EXPEDITEUR ?? "", utilisateur: secret("smtp_user"), motDePasse: secret("smtp_pass") })
let reglage = null // null : le serveur
let transport = null

// Le service d'envoi de la console (un bloc entier, jamais mêlé à celui du serveur), ou null.
export function reglerCourriel(r) {
  reglage = r
  transport?.close?.()
  transport = null
}
const actuel = () => reglage ?? courrielDuServeur()

export const courrielConfigure = () => Boolean(actuel().hote && actuel().expediteur)
// Un service d'envoi existe : les produits en production peuvent envoyer de vrais emails.
export const envoiDisponible = () => Boolean(actuel().hote)

// Toujours chiffré : TLS direct (sécurité « 1 », port 465), sinon STARTTLS exigé (requireTLS). Un
// serveur qui n'annonce pas STARTTLS, ou un intermédiaire qui retire l'annonce, fait échouer la
// connexion avant l'identification : le mot de passe ne part jamais en clair.
export const optionsTransport = (r) => ({
  host: r.hote,
  port: Number(r.port || 587),
  secure: r.securite === "1",
  requireTLS: r.securite !== "1",
  ...(r.utilisateur ? { auth: { user: r.utilisateur, pass: r.motDePasse } } : {}),
  connectionTimeout: 15_000,
  greetingTimeout: 15_000,
})
const creerTransport = (r) => nodemailer.createTransport(optionsTransport(r))
function obtenirTransport() {
  transport ??= creerTransport(actuel())
  return transport
}

// Vérifier sans rien envoyer : connexion, chiffrement et identifiants.
export async function verifierCourriel() {
  const r = actuel()
  if (!r.hote) throw new Error("aucun service d'envoi n'est branché")
  const t = creerTransport(r)
  try {
    await t.verify()
  } finally {
    t.close()
  }
}

// Un email d'essai, à l'administrateur qui le demande.
export async function envoyerEssai(email) {
  if (!courrielConfigure()) throw new Error("le service d'envoi n'est pas complet (serveur et expéditeur)")
  await obtenirTransport().sendMail({ from: actuel().expediteur, to: email, subject: "Essai d'envoi de l'usine logicielle", text: "Bonjour,\n\nCet email d'essai montre que l'usine logicielle sait envoyer des emails : les invitations partiront par ce service.\n" })
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
  await obtenirTransport().sendMail({ from: actuel().expediteur, to: email, subject: "Ton accès à l'usine logicielle", text: texte, html })
}
