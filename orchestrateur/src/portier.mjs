// Parler au portier (la page de connexion devant les applications) : comptes,
// invitations, et la liste des applications qu'il protège.
import { adresses, secret } from "./config.mjs"
import { domainesActifs } from "./domaines.mjs"

const URL_PORTIER = process.env.PORTIER_URL ?? "http://portier:8080"

export async function portier(chemin, { methode = "GET", corps } = {}) {
  const res = await fetch(`${URL_PORTIER}/_portier/api/${chemin}`, {
    method: methode,
    headers: { authorization: `Bearer ${secret("portier_api_token")}`, "content-type": "application/json" },
    body: corps ? JSON.stringify(corps) : undefined,
    signal: AbortSignal.timeout(10_000),
  })
  const json = await res.json().catch(() => ({}))
  // Un refus du portier (4xx) garde son code et son message ; une panne devient 502.
  if (!res.ok) {
    const refus = res.status < 500
    throw Object.assign(new Error(refus ? `La page de connexion refuse : ${json.erreur ?? `erreur ${res.status}`}.` : `La page de connexion ne répond pas correctement (erreur ${res.status}).`), { code: refus ? res.status : 502 })
  }
  return json
}

// Qui est connecté, d'après le cookie d'une requête arrivée par Caddy (pour le tableau de bord).
export async function quiEstConnecte(req) {
  try {
    const res = await fetch(`${URL_PORTIER}/_portier/qui`, {
      headers: { cookie: String(req.headers.cookie ?? ""), "x-forwarded-host": String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "") },
      signal: AbortSignal.timeout(5_000),
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

// La liste des applications, pour le portail « Mes applications » et les accès par application.
export async function synchroniserApplis(ctx) {
  const projets = ctx.db.prepare("SELECT * FROM projets WHERE slug IS NOT NULL AND statut NOT IN ('abandonne', 'supprime')").all()
  const applis = projets.map((p) => {
    const a = adresses(ctx.config, p.slug)
    return {
      slug: p.slug,
      nom: p.nom ?? p.slug,
      liens: [
        ...(["en_production", "mise_en_production"].includes(p.statut) || ctx.db.prepare("SELECT 1 FROM journal WHERE projet_id = ? AND type = 'production' AND message LIKE 'En production%'").get(p.id) ? [{ url: a.production, libelle: "production" }] : []),
        ...domainesActifs(ctx.db, p.id).map((h) => ({ url: `https://${h}`, libelle: "production (domaine)" })),
        ...(p.lot_livre ? [{ url: a.apercu, libelle: "aperçu" }] : []),
      ],
    }
  })
  await portier("applis", { methode: "PUT", corps: { applis } })
}

export function demarrerSynchronisationPortier(ctx) {
  const tour = () => synchroniserApplis(ctx).catch((e) => console.error("Portier (applications) :", e.message))
  tour()
  setInterval(tour, 60_000)
}
