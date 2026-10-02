// Point d'entrée du serveur : l'API sous /api, l'interface (construite par Vite)
// pour tout le reste.
import express from "express"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { routes } from "./routes/index.js"

export function creerApp() {
  const app = express()
  app.use(express.json({ limit: "2mb" }))

  // Le contrôle de santé : l'usine, le vérificateur et le déployeur s'en servent.
  // Il échoue franchement si la base n'est pas joignable.
  app.get("/api/health", async (_req, res) => {
    try {
      const { db } = await import("./db.js")
      db().prepare("SELECT 1").get()
      res.json({ ok: true })
    } catch (error) {
      res.status(503).json({ ok: false, erreur: error.message })
    }
  })

  app.use("/api", routes())

  const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist")
  if (existsSync(dist)) {
    app.use(express.static(dist))
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(join(dist, "index.html")))
  }

  // Les erreurs restent explicites : jamais un état plausible qui cache une panne.
  app.use((error, _req, res, _next) => {
    console.error(error)
    res.status(error.status ?? 500).json({ erreur: error.message })
  })
  return app
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000)
  // Données de démo et tâches de fond : dans server/demarrage.js (modifiable).
  const { auDemarrage } = await import("./demarrage.js")
  await auDemarrage()
  creerApp().listen(port, () => console.log(`Serveur prêt sur le port ${port}`))
}
