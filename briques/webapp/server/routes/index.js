// Le routeur de l'API. Chaque fonctionnalité ajoute son fichier dans routes/,
// qui n'appelle que des fonctions de actions/ (la logique métier, testée à part).
import { Router } from "express"

export function routes() {
  const r = Router()
  // Exemple : r.use("/contacts", contactsRoutes())
  return r
}
