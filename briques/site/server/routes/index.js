// Le routeur de l'API. Chaque fonctionnalité ajoute son fichier dans routes/,
// qui n'appelle que des fonctions de actions/ (la logique métier, testée à part).
// Ce qui est sous /public est ouvert sans connexion (formulaire de contact).
import { Router } from "express"
import { limiter } from "../securite.js"
import { recevoirMessage } from "../actions/contact.js"

export function routes() {
  const r = Router()
  r.post("/public/contact", limiter({ max: 5 }), async (req, res, next) => {
    try {
      res.status(201).json(await recevoirMessage(req.body))
    } catch (error) {
      next(error)
    }
  })
  return r
}
