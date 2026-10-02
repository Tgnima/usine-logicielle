// L'état de l'usine dans SQLite : projets, tâches, journal, décisions humaines.
//
// Statuts d'un projet :
//   analyse -> questions | plan_a_valider -> creation -> fabrication -> livre -> en_production
//   (bloque si une escalade arrête tout, echec si l'analyse échoue)
// Statuts d'une tâche :
//   attente -> prete -> en_cours -> verification -> fusionnee
//   (bloquee : escalade en cours ; abandonnee)
import { DatabaseSync } from "node:sqlite"

export function ouvrirDb(chemin) {
  const db = new DatabaseSync(chemin)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS projets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      slug        TEXT,
      nom         TEXT,
      prompt      TEXT NOT NULL,
      statut      TEXT NOT NULL DEFAULT 'analyse',
      plan        TEXT,
      retours     TEXT,
      depot       TEXT,
      demandeur   TEXT,
      canal       TEXT,
      fil         TEXT,
      plancher_tests INTEGER NOT NULL DEFAULT 0,
      lot_livre   INTEGER NOT NULL DEFAULT 0,
      debut_fabrication TEXT,
      cree_le     TEXT NOT NULL DEFAULT (datetime('now')),
      maj_le      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS taches (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      projet_id   INTEGER NOT NULL,
      cle         TEXT NOT NULL,
      lot         INTEGER NOT NULL,
      titre       TEXT NOT NULL,
      description TEXT NOT NULL,
      criteres    TEXT NOT NULL,
      depend_de   TEXT NOT NULL DEFAULT '[]',
      issue       INTEGER,
      statut      TEXT NOT NULL DEFAULT 'attente',
      tentative   INTEGER NOT NULL DEFAULT 0,
      approche    INTEGER NOT NULL DEFAULT 0,
      retours     TEXT,
      branche     TEXT,
      pr          INTEGER,
      tests       INTEGER,
      verdict     TEXT,
      maj_le      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT, projet_id INTEGER, tache_id INTEGER,
      type TEXT NOT NULL, message TEXT NOT NULL, le TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, projet_id INTEGER NOT NULL, tache_id INTEGER,
      question TEXT NOT NULL, reponse TEXT NOT NULL, par TEXT, le TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS escalades (
      id INTEGER PRIMARY KEY AUTOINCREMENT, projet_id INTEGER NOT NULL, tache_id INTEGER,
      issue INTEGER, raison TEXT NOT NULL, options TEXT NOT NULL, statut TEXT NOT NULL DEFAULT 'ouverte',
      message_ts TEXT, cree_le TEXT NOT NULL DEFAULT (datetime('now')), relance_le TEXT
    );
  `)
  return db
}

export const obtenir = (db, table, id) => db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id)

export function maj(db, table, id, champs) {
  const cles = Object.keys(champs)
  if (cles.length === 0) return
  db.prepare(`UPDATE ${table} SET ${cles.map((k) => `${k} = ?`).join(", ")}, maj_le = datetime('now') WHERE id = ?`).run(...cles.map((k) => champs[k]), id)
}

export function noter(db, { projet, tache = null, type, message }) {
  db.prepare("INSERT INTO journal (projet_id, tache_id, type, message) VALUES (?, ?, ?, ?)").run(projet, tache, type, String(message).slice(0, 4000))
  console.log(`[projet ${projet}${tache ? ` · tâche ${tache}` : ""}] ${type} : ${String(message).split("\n")[0].slice(0, 300)}`)
}

export const plan = (projet) => (projet.plan ? JSON.parse(projet.plan) : null)
export const taches = (db, projetId) => db.prepare("SELECT * FROM taches WHERE projet_id = ? ORDER BY lot, id").all(projetId)
export const decisions = (db, projetId) => db.prepare("SELECT * FROM decisions WHERE projet_id = ? ORDER BY id").all(projetId)
