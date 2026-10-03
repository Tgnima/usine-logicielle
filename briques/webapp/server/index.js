// Point d'entrée du serveur : l'API sous /api, l'interface (construite par Vite)
// pour tout le reste.
import express from "express"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { routes } from "./routes/index.js"
import { entetes, gestionErreurs, limiter } from "./securite.js"

const echapper = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
let meta = null
const chargerMeta = () => (meta ??= import("./meta.js").catch(() => ({})))
// Remplace le titre et la description de la page dans index.html.
function injecterMeta(html, { titre, description }) {
  let h = html
  if (titre) h = h.replace(/<title>[^<]*<\/title>/, `<title>${echapper(titre)}</title>`)
  if (description) h = h.replace(/<meta name="description" content="[^"]*"\s*\/?>/, `<meta name="description" content="${echapper(description)}" />`)
  return h
}

export function creerApp() {
  const app = express()
  // Derrière Caddy : la vraie adresse du visiteur sert à limiter les requêtes.
  app.set("trust proxy", 1)
  app.disable("x-powered-by")
  app.use(entetes())
  app.use("/api", limiter())
  app.use(express.json({ limit: "2mb" }))

  // Le contrôle de santé : l'usine, le vérificateur et le déployeur s'en servent.
  // Il échoue franchement si la base n'est pas joignable.
  app.get("/api/health", async (_req, res) => {
    try {
      const { db } = await import("./db.js")
      db().prepare("SELECT 1").get()
      res.json({ ok: true })
    } catch (error) {
      console.error("Santé :", error)
      res.status(503).json({ ok: false, erreur: "base de données indisponible" })
    }
  })

  app.use("/api", routes())

  const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist")
  if (existsSync(join(dist, "index.html"))) {
    app.use(express.static(dist, { index: false }))
    // server/meta.js (facultatif, modifiable) : le titre et la description de chaque page,
    // et la liste des pages publiques (plan du site). Utile au référencement d'un site.
    const gabarit = readFileSync(join(dist, "index.html"), "utf8")
    const base = (req) => process.env.PUBLIC_URL ?? `${req.protocol}://${req.get("host")}`
    app.get("/sitemap.xml", async (req, res, next) => {
      const m = await chargerMeta()
      if (typeof m.pages !== "function") return next()
      const urls = (await m.pages()).map((p) => `<url><loc>${echapper(base(req) + p)}</loc></url>`).join("")
      res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`)
    })
    app.get("/robots.txt", async (req, res) => {
      const m = await chargerMeta()
      res.type("text/plain").send(`User-agent: *\nAllow: /\n${typeof m.pages === "function" ? `Sitemap: ${base(req)}/sitemap.xml\n` : ""}`)
    })
    app.get(/^(?!\/api\/).*/, async (req, res) => {
      const m = await chargerMeta()
      const info = typeof m.meta === "function" ? await m.meta(req.path) : null
      res.type("html").send(info ? injecterMeta(gabarit, info) : gabarit)
    })
  }

  // Les erreurs restent explicites pour qui exploite (journal), jamais un détail
  // technique pour le visiteur ; une erreur métier garde son message (securite.js).
  app.use(gestionErreurs())
  return app
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000)
  // Données de démo et tâches de fond : dans server/demarrage.js (modifiable).
  const { auDemarrage } = await import("./demarrage.js")
  await auDemarrage()
  creerApp().listen(port, () => console.log(`Serveur prêt sur le port ${port}`))
}
