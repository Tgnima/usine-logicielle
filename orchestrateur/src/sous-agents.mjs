// Les sous-agents d'un passage de l'agent. Claude Code peut confier une partie du travail à des
// sous-agents (l'outil Task, appelé Agent dans les versions récentes), parfois avec un autre
// modèle. Le flux stream-json de l'agent le décrit : chaque appel de l'outil, puis les messages
// du sous-agent, marqués par parent_tool_use_id. La table consommations ne garde que les modèles
// d'un passage (modelUsage) : elle ne dit ni qu'un sous-agent est intervenu, ni lequel.
//
// resumerFlux() tire du flux un résumé court. Il est calculé dans l'atelier, à la fin du passage
// (le flux peut peser plusieurs Mo, et il est effacé au passage suivant), puis noté ici, dans
// la table agents_tache : une ligne pour l'agent lui-même, une par sous-agent.
import { ecrireFichier, q } from "./travaux.mjs"

// Le résumé d'un flux stream-json. Autonome (sans rien du module) : il est recopié tel quel dans
// le script de l'atelier par scriptResume().
//   { modele, principal: { modeles, tours, outils }, sous_agents: [{ type, description, modele_demande, lance_par, modeles, tours, outils }] }
export function resumerFlux(texte) {
  const OUTILS_SOUS_AGENT = ["Task", "Agent"]
  const MAX_SOUS_AGENTS = 50
  const coupe = (t, n) => String(t ?? "").replace(/\s+/g, " ").trim().slice(0, n)
  const nouveau = () => ({ type: null, description: "", modele_demande: null, lance_par: null, modeles: {}, messages: new Set(), sansId: 0, outils: 0 })
  const principal = nouveau()
  let init = null
  const sous = new Map() // l'identifiant de l'appel de l'outil -> le sous-agent
  const sousAgent = (id) => {
    if (!sous.has(id) && sous.size < MAX_SOUS_AGENTS) sous.set(id, nouveau())
    return sous.get(id) ?? null
  }
  for (const ligne of String(texte ?? "").split("\n")) {
    if (!ligne.startsWith("{")) continue
    let e
    try {
      e = JSON.parse(ligne)
    } catch {
      continue
    }
    if (e?.type === "system" && e.subtype === "init" && typeof e.model === "string") init = coupe(e.model, 60)
    if (e?.type !== "assistant") continue
    const parent = typeof e.parent_tool_use_id === "string" && e.parent_tool_use_id ? e.parent_tool_use_id : null
    const qui = parent ? sousAgent(parent) : principal
    if (!qui) continue
    // Un tour : un message du modèle (le flux peut en livrer un par bloc, sous le même identifiant).
    if (typeof e.message?.id === "string") qui.messages.add(e.message.id)
    else qui.sansId += 1
    if (typeof e.message?.model === "string" && e.message.model) {
      const m = coupe(e.message.model, 60)
      qui.modeles[m] = (qui.modeles[m] ?? 0) + 1
    }
    for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (c?.type !== "tool_use") continue
      qui.outils += 1
      if (!OUTILS_SOUS_AGENT.includes(c.name) || typeof c.id !== "string") continue
      const s = sousAgent(c.id)
      if (!s) continue
      s.type = coupe(c.input?.subagent_type || "general-purpose", 60)
      s.description = coupe(c.input?.description, 120)
      s.modele_demande = c.input?.model ? coupe(c.input.model, 30) : null
      s.lance_par = parent ? "sous-agent" : "agent"
    }
  }
  const fin = (x) => ({ modeles: Object.keys(x.modeles), tours: x.messages.size + x.sansId, outils: x.outils })
  return {
    modele: init ?? Object.keys(principal.modeles)[0] ?? null,
    principal: fin(principal),
    sous_agents: [...sous.values()].map((s) => ({ type: s.type ?? "inconnu", description: s.description, modele_demande: s.modele_demande, lance_par: s.lance_par, ...fin(s) })),
  }
}

// Le script qui, dans l'atelier, résume le flux de l'agent dans un fichier JSON. Il ne fait jamais
// échouer le travail (|| true) : sans résumé, le passage n'est simplement pas noté.
export function codeResume() {
  return `const resumerFlux = ${resumerFlux.toString()};\nlet t = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (d) => (t += d)).on("end", () => process.stdout.write(JSON.stringify(resumerFlux(t))));\n`
}
export function scriptResume(entree, sortie, script = "/tmp/sorties/tache/resume-agents.cjs") {
  return [ecrireFichier(script, codeResume()), `node ${q(script)} < ${q(entree)} > ${q(sortie)} 2>/dev/null || true`].join("\n")
}

// --- La table ---------------------------------------------------------------------------
export function ouvrirAgentsTache(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents_tache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projet_id INTEGER, tache_id INTEGER,
      role TEXT NOT NULL,                  -- agent (la construction)
      tentative INTEGER NOT NULL DEFAULT 0, approche INTEGER NOT NULL DEFAULT 0,
      principal INTEGER NOT NULL DEFAULT 0, -- 1 : l'agent lui-même ; 0 : un sous-agent
      type TEXT, description TEXT, modele_demande TEXT,
      modeles TEXT NOT NULL DEFAULT '[]',  -- JSON : les modèles vus dans ses messages
      tours INTEGER NOT NULL DEFAULT 0, outils INTEGER NOT NULL DEFAULT 0,
      le TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS agents_tache_tache ON agents_tache (tache_id);
  `)
}

// Le résumé vient de l'atelier : chaque champ est typé et borné avant d'être noté.
const MODELE_MAX = 60
const TYPE_MAX = 60
const DESCRIPTION_MAX = 120
const SOUS_AGENTS_MAX = 50
const entier = (x) => (Number.isFinite(Number(x)) ? Math.max(0, Math.min(1e6, Math.round(Number(x)))) : 0)
const listeModeles = (l) => JSON.stringify((Array.isArray(l) ? l : []).filter((x) => typeof x === "string" && x).map((x) => x.slice(0, MODELE_MAX)).slice(0, 10))

export function noterPassage(db, { projet = null, tache = null, role = "agent", tentative = 0, approche = 0, resume }) {
  if (!resume || typeof resume !== "object" || Array.isArray(resume)) return false
  const ins = db.prepare(`INSERT INTO agents_tache (projet_id, tache_id, role, tentative, approche, principal, type, description, modele_demande, modeles, tours, outils)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const p = resume.principal && typeof resume.principal === "object" ? resume.principal : {}
  const modeles = Array.isArray(p.modeles) && p.modeles.length ? p.modeles : [resume.modele]
  ins.run(projet, tache, role, entier(tentative), entier(approche), 1, null, null, null, listeModeles(modeles), entier(p.tours), entier(p.outils))
  for (const s of (Array.isArray(resume.sous_agents) ? resume.sous_agents : []).slice(0, SOUS_AGENTS_MAX)) {
    if (!s || typeof s !== "object") continue
    ins.run(projet, tache, role, entier(tentative), entier(approche), 0, String(s.type ?? "inconnu").slice(0, TYPE_MAX), String(s.description ?? "").slice(0, DESCRIPTION_MAX),
      typeof s.modele_demande === "string" && s.modele_demande ? s.modele_demande.slice(0, 30) : null, listeModeles(s.modeles), entier(s.tours), entier(s.outils))
  }
  return true
}
