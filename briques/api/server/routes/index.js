// Le routeur de l'API. Chaque fonctionnalité ajoute son fichier dans routes/,
// qui n'appelle que des fonctions de actions/ (la logique métier, testée à part).
// Chaque point d'accès est décrit dans docs/API.md.
import { Router } from "express"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const DOC = fileURLToPath(new URL("../../docs/API.md", import.meta.url))

export function routes() {
  const r = Router()
  // La documentation, servie telle quelle.
  r.get("/docs", (_req, res) => res.type("text/markdown; charset=utf-8").send(readFileSync(DOC, "utf8")))
  // L'appelant, d'après l'en-tête posé par l'usine (jamais par le visiteur).
  r.get("/moi", (req, res) => res.json({ appelant: req.get("x-usine-utilisateur") ?? null }))
  return r
}
