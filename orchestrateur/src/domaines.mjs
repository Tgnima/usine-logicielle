// Les domaines personnalisés : servir un produit en production sur l'adresse du
// client (app.client.fr) en plus de <slug>.<base>.
//
//   1. un administrateur le demande dans Slack (`/usine domaine <n°> <adresse>`) ;
//   2. l'usine donne l'enregistrement DNS à créer (A vers l'adresse IP du serveur) ;
//   3. toutes les 2 minutes, elle vérifie le DNS. Dès qu'il pointe vers le serveur,
//      elle l'écrit dans le dépôt d'état (domaines/<slug>.json) : le déployeur ajoute
//      l'adresse à Caddy, qui obtient le certificat HTTPS ;
//   4. quand https://<adresse>/api/health répond, le domaine est actif (message dans le fil).
//
// On attend le DNS AVANT de l'ajouter à Caddy : sinon Caddy demanderait un certificat
// impossible à obtenir (et l'autorité de certification limite les essais).
// Le domaine reste derrière la page de connexion, comme l'adresse de production.
import { resolve4 } from "node:dns/promises"
import { noter, obtenir } from "./db.mjs"
import { ecrireEtat } from "./github.mjs"

export const MAX_DOMAINES = 5

export function ouvrirDomaines(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS domaines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, projet_id INTEGER NOT NULL, hote TEXT NOT NULL,
    statut TEXT NOT NULL DEFAULT 'attente_dns',  -- attente_dns | certificat | actif | retire
    demande_par TEXT, demande_le TEXT NOT NULL DEFAULT (datetime('now')), verifie_le TEXT, actif_le TEXT, message TEXT
  )`)
}

// Une adresse acceptable : un vrai nom de domaine, qui n'est pas une adresse de l'usine.
export function hoteValide(hote, base) {
  // Slack peut transformer l'adresse en lien (<http://app.client.fr|app.client.fr>) : on garde le nom seul.
  const h = String(hote ?? "").trim().toLowerCase().replace(/^<([^|>]+)(\|[^>]*)?>$/, "$1").replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/\.$/, "")
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(h)) return { ok: false, message: "Ce n'est pas une adresse valide (exemple : app.mon-entreprise.fr)." }
  if (base && (h === base || h.endsWith(`.${base}`))) return { ok: false, message: `Les adresses en .${base} sont celles de l'usine : choisis une adresse de ton propre domaine.` }
  return { ok: true, hote: h }
}

const enCours = (db, projetId) => db.prepare("SELECT * FROM domaines WHERE projet_id = ? AND statut != 'retire' ORDER BY id").all(projetId)

// L'adresse IP du serveur : celle du portail de l'usine (connexion.<base>), qui pointe forcément vers lui.
export async function ipServeur(config) {
  if (process.env.IP_PUBLIQUE) return [process.env.IP_PUBLIQUE]
  return resolve4(`connexion.${config.domaine.base}`).catch(() => [])
}

export function instructionsDns(hote, ips) {
  const sous = hote.split(".").length > 2 ? hote.split(".").slice(0, -2).join(".") : "@"
  return `Chez ton fournisseur de nom de domaine, crée cet enregistrement :\n• type *A* · nom *${sous}* (soit \`${hote}\`) · valeur *${ips[0] ?? "l'adresse IP du serveur"}*\nS'il existe déjà un enregistrement A ou CNAME pour \`${hote}\`, remplace-le. La propagation prend de quelques minutes à quelques heures : l'usine vérifie toute seule toutes les 2 minutes et te prévient ici.`
}

export async function ajouterDomaine(ctx, projetId, hote, par) {
  const { config, db } = ctx
  const projet = obtenir(db, "projets", projetId)
  if (!projet) return { ok: false, message: `Pas de projet ${projetId}.` }
  if (projet.statut !== "en_production") return { ok: false, message: `${projet.nom ?? "Ce projet"} n'est pas en production : un domaine personnalisé pointe vers la production. Mets-le d'abord en production.` }
  const v = hoteValide(hote, config.domaine.base)
  if (!v.ok) return v
  const deja = db.prepare("SELECT d.*, p.nom FROM domaines d JOIN projets p ON p.id = d.projet_id WHERE d.hote = ? AND d.statut != 'retire'").get(v.hote)
  if (deja) return { ok: false, message: `\`${v.hote}\` est déjà demandé pour ${deja.projet_id === projetId ? "ce projet" : deja.nom}.` }
  if (enCours(db, projetId).length >= MAX_DOMAINES) return { ok: false, message: `${MAX_DOMAINES} domaines au plus par produit.` }
  db.prepare("INSERT INTO domaines (projet_id, hote, demande_par) VALUES (?, ?, ?)").run(projetId, v.hote, par)
  noter(db, { projet: projetId, type: "domaine", message: `Domaine ${v.hote} demandé par ${par}` })
  const ips = await ipServeur(config)
  await ctx.notifier.etape(projet, `:globe_with_meridians: Domaine personnalisé demandé par ${par} : *${v.hote}*\n${instructionsDns(v.hote, ips)}`)
  verifierDomaines(ctx).catch((e) => console.error("Domaines :", e.message))
  return { ok: true, message: `C'est noté. ${instructionsDns(v.hote, ips)}` }
}

export async function retirerDomaine(ctx, projetId, hote, par) {
  const { db } = ctx
  const projet = obtenir(db, "projets", projetId)
  const d = db.prepare("SELECT * FROM domaines WHERE projet_id = ? AND hote = ? AND statut != 'retire'").get(projetId, hoteValide(hote).hote ?? "")
  if (!projet || !d) return { ok: false, message: `\`${hote}\` n'est pas un domaine de ce projet.` }
  db.prepare("UPDATE domaines SET statut = 'retire', message = ? WHERE id = ?").run(`retiré par ${par}`, d.id)
  await publier(ctx, projet)
  noter(db, { projet: projetId, type: "domaine", message: `Domaine ${d.hote} retiré par ${par}` })
  await ctx.notifier.etape(projet, `:globe_with_meridians: Domaine *${d.hote}* retiré par ${par}. Le produit reste sur son adresse de l'usine. Tu peux supprimer l'enregistrement DNS.`)
  return { ok: true, message: `${d.hote} retiré.` }
}

export function listerDomaines(db, projetId) {
  const PICTO = { attente_dns: "⏳ en attente du DNS", certificat: "🔐 DNS bon, certificat HTTPS en cours", actif: "✅ actif" }
  return enCours(db, projetId).map((d) => `• \`${d.hote}\` · ${PICTO[d.statut] ?? d.statut}${d.message && d.statut !== "actif" ? ` (${d.message})` : ""}`)
}

// L'état souhaité pour le déployeur : les adresses dont le DNS pointe vers le serveur.
async function publier(ctx, projet) {
  const hotes = ctx.db.prepare("SELECT hote FROM domaines WHERE projet_id = ? AND statut IN ('certificat', 'actif') ORDER BY id").all(projet.id).map((d) => d.hote)
  await ecrireEtat(ctx.config, `domaines/${projet.slug}.json`, { produit: projet.slug, hotes, demande_le: new Date().toISOString() }, { message: `Domaines ${projet.slug} : ${hotes.join(", ") || "aucun"}` })
}

const repond = async (hote) => {
  try {
    const r = await fetch(`https://${hote}/api/health`, { redirect: "manual", signal: AbortSignal.timeout(10_000) })
    return r.ok
  } catch {
    return false
  }
}

// Le tour de vérification (toutes les 2 minutes).
export async function verifierDomaines(ctx) {
  const { db, config } = ctx
  const aVoir = db.prepare("SELECT d.* FROM domaines d JOIN projets p ON p.id = d.projet_id WHERE d.statut IN ('attente_dns', 'certificat') AND p.statut = 'en_production'").all()
  if (!aVoir.length) return
  const ips = await ipServeur(config)
  if (!ips.length) return
  const aPublier = new Set()
  for (const d of aVoir) {
    const projet = obtenir(db, "projets", d.projet_id)
    const maintenant = new Date().toISOString()
    if (d.statut === "attente_dns") {
      const trouve = await resolve4(d.hote).catch(() => [])
      const bon = trouve.some((ip) => ips.includes(ip))
      db.prepare("UPDATE domaines SET verifie_le = ?, message = ? WHERE id = ?").run(maintenant, trouve.length ? (bon ? null : `pointe vers ${trouve.join(", ")}`) : "aucun enregistrement A pour l'instant", d.id)
      if (bon) {
        db.prepare("UPDATE domaines SET statut = 'certificat', message = NULL WHERE id = ?").run(d.id)
        aPublier.add(projet.id)
      }
      continue
    }
    if (await repond(d.hote)) {
      db.prepare("UPDATE domaines SET statut = 'actif', actif_le = ?, verifie_le = ? WHERE id = ?").run(maintenant, maintenant, d.id)
      noter(db, { projet: projet.id, type: "domaine", message: `Domaine ${d.hote} actif` })
      await ctx.notifier.etape(projet, `:white_check_mark: *${projet.nom}* répond maintenant sur https://${d.hote} (certificat HTTPS en place, même page de connexion que la production).`)
    }
  }
  for (const id of aPublier) await publier(ctx, obtenir(db, "projets", id))
}

export function demarrerDomaines(ctx) {
  ouvrirDomaines(ctx.db)
  setInterval(() => verifierDomaines(ctx).catch((e) => console.error("Domaines :", e.message)), 120_000)
}

// Les adresses servies d'un produit (dès que Caddy les a), pour le portier et « Mes applications ».
export const domainesActifs = (db, projetId) => {
  try {
    return db.prepare("SELECT hote FROM domaines WHERE projet_id = ? AND statut IN ('certificat', 'actif')").all(projetId).map((d) => d.hote)
  } catch {
    return []
  }
}
