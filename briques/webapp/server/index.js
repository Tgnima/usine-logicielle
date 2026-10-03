// Point d'entrée du serveur : l'API sous /api, l'interface (construite par Vite)
// pour tout le reste.
import express from "express"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { routes } from "./routes/index.js"
import { entetes, gestionErreurs, limiter } from "./securite.js"

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
  if (existsSync(dist)) {
    app.use(express.static(dist))
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(dist, "index.html")))
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
