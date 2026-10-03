// La base SQLite du site (node:sqlite, sans dépendance). Le fichier vit dans
// DATA_DIR, un volume persistant en aperçu comme en production.
//
// Les migrations sont ADDITIVES : on ajoute des tables et des colonnes, on n'en
// supprime jamais. Chaque migration a un numéro et n'est jouée qu'une fois.
import { DatabaseSync } from "node:sqlite"
import { mkdirSync } from "node:fs"
import { join } from "node:path"

const MIGRATIONS = [
  // 1 : les messages du formulaire de contact.
  "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, nom TEXT NOT NULL, email TEXT NOT NULL, message TEXT NOT NULL, recu_le TEXT NOT NULL)",
  // Ajoutez ici vos migrations, dans l'ordre.
]

let instance = null

export function db() {
  if (instance) return instance
  const dir = process.env.DATA_DIR ?? "./data"
  mkdirSync(dir, { recursive: true })
  instance = new DatabaseSync(process.env.DB_FILE ?? join(dir, "produit.db"))
  instance.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")
  instance.exec("CREATE TABLE IF NOT EXISTS migrations (numero INTEGER PRIMARY KEY, appliquee_le TEXT NOT NULL)")
  const faites = new Set(instance.prepare("SELECT numero FROM migrations").all().map((r) => r.numero))
  MIGRATIONS.forEach((sql, i) => {
    if (faites.has(i + 1)) return
    instance.exec(sql)
    instance.prepare("INSERT INTO migrations (numero, appliquee_le) VALUES (?, datetime('now'))").run(i + 1)
  })
  return instance
}

// Pour les tests : une base neuve en mémoire.
export function dbDeTest() {
  instance = null
  process.env.DB_FILE = ":memory:"
  return db()
}
