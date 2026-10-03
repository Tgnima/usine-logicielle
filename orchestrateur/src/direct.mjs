// Le journal en direct d'une tâche, pour la console : ce que fait l'agent
// (Claude Code, évènements stream-json) ou le vérificateur (Codex, --json),
// lu au fil de l'eau et traduit en lignes lisibles. Les secrets sont masqués.
import { lireFichier } from "./travaux.mjs"

const FICHIERS = {
  agent: "/tmp/sorties/tache/agent.jsonl",
  verificateur: "/tmp/sorties/verif/codex.log",
  design: "/tmp/sorties/verif/design.log",
}

// Tout ce qui ressemble à un jeton ou à une clé est masqué, ainsi que les secrets connus de l'usine.
const MOTIFS = [
  /sk-[A-Za-z0-9_-]{12,}/g, /gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /usk_[A-Za-z0-9_-]{16,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, /xapp-[A-Za-z0-9-]{10,}/g, /eyJ[\w-]{15,}\.[\w-]{10,}\.[\w-]{10,}/g,
]
// « clé=valeur » : on garde le nom, on masque la valeur.
const AFFECTATION = /(api[_-]?key|token|secret|password|passwd|authorization)(["'\s:=]+)([^\s"',]{8,})/gi
export function masquer(texte, secrets = []) {
  let t = String(texte ?? "")
  for (const s of secrets) if (s && s.length >= 8) t = t.split(s).join("•••")
  for (const m of MOTIFS) t = t.replace(m, "•••")
  return t.replace(AFFECTATION, (_tout, nom, sep) => `${nom}${sep}•••`)
}

const court = (t, n = 240) => {
  const s = String(t ?? "").replace(/\s+/g, " ").trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}
const relatif = (chemin) => String(chemin ?? "").replace(/^\/travail\/[^/]+\/depot\//, "").replace(/^\/tmp\/sorties\//, "")

// Une action d'outil de Claude Code, en une ligne.
function outil(nom, e = {}) {
  switch (nom) {
    case "Read": return { type: "lecture", texte: `lit ${relatif(e.file_path)}` }
    case "Write": return { type: "ecriture", texte: `écrit ${relatif(e.file_path)}` }
    case "Edit": case "MultiEdit": return { type: "ecriture", texte: `modifie ${relatif(e.file_path)}` }
    case "Bash": return { type: "commande", texte: `$ ${court(e.command, 200)}` }
    case "Grep": return { type: "lecture", texte: `cherche « ${court(e.pattern, 60)} »${e.path ? ` dans ${relatif(e.path)}` : ""}` }
    case "Glob": return { type: "lecture", texte: `liste ${court(e.pattern, 80)}` }
    case "TodoWrite": return { type: "plan", texte: `planifie : ${(e.todos ?? []).map((x) => `${x.status === "completed" ? "✓" : x.status === "in_progress" ? "▸" : "·"} ${court(x.content, 60)}`).join("  ")}` }
    case "WebFetch": case "WebSearch": return { type: "lecture", texte: `consulte ${court(e.url ?? e.query, 80)}` }
    default: return { type: "outil", texte: `${nom} ${court(JSON.stringify(e), 120)}` }
  }
}

// Claude Code (--output-format stream-json) : une ligne JSON par évènement.
export function lignesAgent(brut) {
  const lignes = []
  for (const l of String(brut).split("\n")) {
    if (!l.startsWith("{")) continue
    let e
    try {
      e = JSON.parse(l)
    } catch {
      continue // la première ligne d'un extrait peut être coupée
    }
    if (e.type === "system" && e.subtype === "init") lignes.push({ type: "info", texte: `l'agent démarre (${e.model ?? "modèle"})` })
    if (e.type === "assistant") for (const c of e.message?.content ?? []) {
      if (c.type === "text" && c.text?.trim()) lignes.push({ type: "pensee", texte: court(c.text, 400) })
      if (c.type === "tool_use") lignes.push(outil(c.name, c.input))
    }
    if (e.type === "user") for (const c of e.message?.content ?? []) {
      if (c.type === "tool_result" && c.is_error) lignes.push({ type: "erreur", texte: `échec : ${court(typeof c.content === "string" ? c.content : JSON.stringify(c.content), 200)}` })
    }
    if (e.type === "result") lignes.push({ type: e.is_error ? "erreur" : "fin", texte: `terminé${e.num_turns ? ` en ${e.num_turns} tours` : ""}${e.duration_ms ? `, ${Math.round(e.duration_ms / 60000)} min` : ""} : ${court(e.result, 300)}` })
  }
  return lignes
}

// Codex (exec --json) : les évènements « item » (versions récentes) ou « msg » (anciennes).
export function lignesCodex(brut) {
  const lignes = []
  for (const l of String(brut).split("\n")) {
    if (!l.startsWith("{")) continue
    let e
    try {
      e = JSON.parse(l)
    } catch {
      continue
    }
    const item = e.item
    if (item && e.type === "item.started" && item.type === "command_execution") lignes.push({ type: "commande", texte: `$ ${court(item.command, 200)}` })
    else if (item && e.type === "item.completed") {
      if (item.type === "agent_message" && item.text) lignes.push({ type: "pensee", texte: court(item.text, 400) })
      else if (item.type === "reasoning" && item.text) lignes.push({ type: "pensee", texte: court(item.text, 300) })
      else if (item.type === "command_execution" && item.exit_code && item.exit_code !== 0) lignes.push({ type: "erreur", texte: `échec (${item.exit_code}) : ${court(item.command, 120)}` })
      else if (item.type === "file_change") lignes.push({ type: "ecriture", texte: `modifie ${(item.changes ?? []).map((c) => relatif(c.path)).join(", ")}` })
    }
    const m = e.msg
    if (m?.type === "exec_command_begin") lignes.push({ type: "commande", texte: `$ ${court(Array.isArray(m.command) ? m.command.join(" ") : m.command, 200)}` })
    if (m?.type === "agent_message" && m.message) lignes.push({ type: "pensee", texte: court(m.message, 400) })
  }
  return lignes
}

// Le direct d'un projet : selon la tâche en cours, l'agent (atelier) ou le vérificateur.
export async function direct(ctx, tache) {
  const { config } = ctx
  if (!tache) return { source: null, lignes: [] }
  const source = tache.statut === "verification" ? "verificateur" : "agent"
  const serveur = source === "agent" ? config.atelier.url : config.verificateur.url
  const secrets = Object.values(config.secrets ?? {}).filter(Boolean)
  // Le vérificateur juge d'abord les critères, puis le design : on suit le plus récent.
  let brut = ""
  for (const f of source === "agent" ? [FICHIERS.agent] : [FICHIERS.design, FICHIERS.verificateur]) {
    brut = (await lireFichier(serveur, config.secrets.worker, f, { fin: 60_000 }).catch(() => null)) ?? ""
    if (brut) break
  }
  const lignes = (source === "agent" ? lignesAgent(brut) : lignesCodex(brut)).slice(-80).map((l) => ({ ...l, texte: masquer(l.texte, secrets) }))
  return { source, tache: tache.cle, lignes }
}
