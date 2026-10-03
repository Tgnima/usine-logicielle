// Le serveur de travaux : il tourne dans l'atelier (les agents qui codent) et
// dans le vérificateur. L'orchestrateur lui confie un script bash à la fois ;
// le serveur l'exécute, garde son journal et répond à qui demande où il en est.
//
// Il ne sait rien de l'usine : il exécute, c'est tout. Toutes les décisions
// (quoi lancer, que conclure) sont prises par le code de l'orchestrateur.
//
//   POST /travaux          { script, env?, minutes? }  -> 202 { id }   (409 si occupé)
//   GET  /travaux/:id      -> { etat: en_cours|fini, code, journal, marqueurs }
//   GET  /fichier?chemin=  -> contenu d'un fichier de /travail ou /tmp/sorties (&base64=1 : binaire, une capture)
//   GET  /sante            -> { ok, occupe }
//
// Le script arrive par l'entrée standard de bash, jamais dans un fichier ni sur
// la ligne de commande : un jeton qu'il contiendrait ne traîne nulle part.
// Une ligne « @@ CLE valeur » dans le journal est un marqueur, relevé à part.
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"

const PORT = Number(process.env.PORT || 8080)
const JETON = process.env.WORKER_TOKEN
const RACINES = ["/travail", "/tmp/sorties"]
const JOURNAL_MAX = 400_000 // caractères gardés en mémoire par travail

if (!JETON) throw new Error("WORKER_TOKEN manquant.")
for (const r of RACINES) mkdirSync(r, { recursive: true })

const travaux = new Map()
let courant = null

function lancer({ script, env = {}, minutes = 30 }) {
  const id = randomUUID()
  const travail = { id, etat: "en_cours", code: null, journal: "", debut: Date.now() }
  // setsid : le script et tout ce qu'il lance forment un groupe, arrêté d'un coup.
  const enfant = spawn("setsid", ["bash", "-l", "-s"], { cwd: "/travail", env: { ...process.env, WORKER_TOKEN: "", ...env }, stdio: ["pipe", "pipe", "pipe"] })
  const ajouter = (d) => {
    travail.journal += d
    if (travail.journal.length > JOURNAL_MAX) travail.journal = travail.journal.slice(-JOURNAL_MAX)
  }
  enfant.stdout.on("data", ajouter)
  enfant.stderr.on("data", ajouter)
  const minuteur = setTimeout(() => {
    ajouter(`\n@@ DELAI_DEPASSE ${minutes}min\n`)
    try {
      process.kill(-enfant.pid, "SIGKILL")
    } catch {}
  }, minutes * 60_000)
  enfant.on("close", (code) => {
    clearTimeout(minuteur)
    // Les processus laissés en arrière-plan (un serveur de test…) sont arrêtés.
    try {
      process.kill(-enfant.pid, "SIGKILL")
    } catch {}
    Object.assign(travail, { etat: "fini", code: code ?? 137, fin: Date.now() })
    courant = null
  })
  enfant.stdin.end(`${script}\n`)
  travaux.set(id, travail)
  courant = travail
  // On ne garde que les 20 derniers travaux.
  if (travaux.size > 20) travaux.delete(travaux.keys().next().value)
  return travail
}

const marqueurs = (journal) => {
  const m = {}
  for (const ligne of journal.split("\n")) {
    const r = /^@@ ([A-Z_]+)(?: (.*))?$/.exec(ligne.trim())
    if (r) m[r[1]] = (r[2] ?? "").trim()
  }
  return m
}

const envoyer = (res, statut, corps) => {
  res.writeHead(statut, { "content-type": "application/json" })
  res.end(JSON.stringify(corps))
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x")
  if (url.pathname === "/sante") return envoyer(res, 200, { ok: true, occupe: courant?.etat === "en_cours" })
  if (req.headers.authorization !== `Bearer ${JETON}`) return envoyer(res, 401, { erreur: "non autorisé" })

  if (req.method === "POST" && url.pathname === "/travaux") {
    if (courant?.etat === "en_cours") return envoyer(res, 409, { erreur: "occupé", id: courant.id })
    let brut = ""
    for await (const morceau of req) brut += morceau
    let corps
    try {
      corps = JSON.parse(brut)
    } catch {
      return envoyer(res, 400, { erreur: "JSON invalide" })
    }
    if (!corps.script) return envoyer(res, 400, { erreur: "script manquant" })
    return envoyer(res, 202, { id: lancer(corps).id })
  }

  const m = /^\/travaux\/([\w-]+)$/.exec(url.pathname)
  if (req.method === "GET" && m) {
    const t = travaux.get(m[1])
    if (!t) return envoyer(res, 404, { erreur: "travail inconnu" })
    const lignes = Number(url.searchParams.get("lignes") ?? 200)
    return envoyer(res, 200, { etat: t.etat, code: t.code, duree_s: Math.round(((t.fin ?? Date.now()) - t.debut) / 1000), journal: t.journal.split("\n").slice(-lignes).join("\n"), marqueurs: marqueurs(t.journal) })
  }

  if (req.method === "GET" && url.pathname === "/fichier") {
    const chemin = resolve(url.searchParams.get("chemin") ?? "")
    if (!RACINES.some((r) => chemin === r || chemin.startsWith(`${r}/`))) return envoyer(res, 403, { erreur: "chemin interdit" })
    if (!existsSync(chemin)) return envoyer(res, 404, { erreur: "fichier absent" })
    if (url.searchParams.get("base64") === "1") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
      return res.end(readFileSync(chemin).toString("base64"))
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" })
    return res.end(readFileSync(chemin))
  }

  envoyer(res, 404, { erreur: "inconnu" })
}).listen(PORT, () => console.log(`Serveur de travaux prêt (${process.env.ROLE ?? "atelier"}, port ${PORT}).`))
