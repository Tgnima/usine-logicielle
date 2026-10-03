// Ce que coûte l'usine. Chaque appel d'un modèle est enregistré (projet, tâche,
// rôle, modèle, jetons, durée), avec deux coûts :
//   - l'ÉQUIVALENT API : ce que l'appel coûterait avec des clés payantes. Claude
//     Code le donne lui-même ; pour les autres moteurs, la table couts.prix_api ;
//   - le COÛT RÉEL : les abonnements et le serveur, des montants fixes par mois,
//     répartis entre les projets au prorata de leur usage ce mois-là.
// Tous les montants de la configuration sont dans la devise d'affichage
// (couts.devise) ; les équivalents API arrivent en dollars et sont convertis.

export function ouvrirCouts(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS consommations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      projet_id INTEGER, tache_id INTEGER,
      role TEXT NOT NULL,              -- analyste | agent | verificateur | aiguillage
      moteur TEXT NOT NULL,            -- claude-code | codex | passerelle
      modele TEXT NOT NULL,
      entree INTEGER NOT NULL DEFAULT 0, sortie INTEGER NOT NULL DEFAULT 0,
      cache_lecture INTEGER NOT NULL DEFAULT 0, cache_ecriture INTEGER NOT NULL DEFAULT 0,
      cout_api_usd REAL,               -- null : prix inconnu (à renseigner dans couts.prix_api)
      duree_s REAL NOT NULL DEFAULT 0,
      le TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS consommations_mois ON consommations (le);
    CREATE TABLE IF NOT EXISTS alertes_budget (cle TEXT PRIMARY KEY, le TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS reglages (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL);
  `)
  const colonnes = new Set(db.prepare("PRAGMA table_info(projets)").all().map((c) => c.name))
  if (!colonnes.has("budget_supplement")) db.exec("ALTER TABLE projets ADD COLUMN budget_supplement REAL NOT NULL DEFAULT 0")
}

// --- Relever les usages ---------------------------------------------------------

// La sortie JSON de `claude -p --output-format json` : un usage par modèle (sous-agents compris).
export function usagesClaude(sortie) {
  const parModele = sortie?.modelUsage ?? {}
  const lignes = Object.entries(parModele).map(([modele, u]) => ({
    modele: u.canonicalModel ?? modele,
    entree: u.inputTokens ?? 0,
    sortie: u.outputTokens ?? 0,
    cache_lecture: u.cacheReadInputTokens ?? 0,
    cache_ecriture: u.cacheCreationInputTokens ?? 0,
    cout_api_usd: typeof u.costUSD === "number" ? u.costUSD : null,
  }))
  if (lignes.length) return lignes
  // Repli : l'usage global, sans détail par modèle.
  if (sortie?.usage) return [{ modele: "inconnu", entree: sortie.usage.input_tokens ?? 0, sortie: sortie.usage.output_tokens ?? 0, cache_lecture: sortie.usage.cache_read_input_tokens ?? 0, cache_ecriture: sortie.usage.cache_creation_input_tokens ?? 0, cout_api_usd: sortie.total_cost_usd ?? null }]
  return []
}

// Le journal JSONL de `codex exec --json` : on additionne les « turn.completed ».
export function usagesCodex(journal, modele, config) {
  const u = { entree: 0, sortie: 0, cache_lecture: 0, cache_ecriture: 0 }
  for (const ligne of String(journal ?? "").split("\n")) {
    if (!ligne.includes('"turn.completed"')) continue
    try {
      const e = JSON.parse(ligne).usage ?? {}
      u.entree += (e.input_tokens ?? 0) - (e.cached_input_tokens ?? 0)
      u.cache_lecture += e.cached_input_tokens ?? 0
      u.cache_ecriture += e.cache_write_input_tokens ?? 0
      u.sortie += (e.output_tokens ?? 0) + (e.reasoning_output_tokens ?? 0)
    } catch {}
  }
  if (!u.entree && !u.sortie && !u.cache_lecture) return []
  const m = modele || "codex"
  return [{ modele: m, ...u, cout_api_usd: prixApi(config, m, u) }]
}

// L'équivalent API d'après la table de prix du contrat (dollars par million de jetons).
export function prixApi(config, modele, u) {
  const table = config.couts?.prix_api ?? {}
  const p = table[modele] ?? table[String(modele).replace(/^[a-z]+\//, "")]
  if (!p || typeof p.entree !== "number") return null
  const cacheLecture = p.cache_lecture ?? p.entree * 0.1
  const cacheEcriture = p.cache_ecriture ?? p.entree * 1.25
  return ((u.entree ?? 0) * p.entree + (u.sortie ?? 0) * p.sortie + (u.cache_lecture ?? 0) * cacheLecture + (u.cache_ecriture ?? 0) * cacheEcriture) / 1e6
}

export function enregistrer(db, { projet = null, tache = null, role, moteur, usages, duree_s = 0 }) {
  const ins = db.prepare("INSERT INTO consommations (projet_id, tache_id, role, moteur, modele, entree, sortie, cache_lecture, cache_ecriture, cout_api_usd, duree_s) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
  // La durée est comptée une fois, sur la première ligne de l'appel.
  usages.forEach((u, i) => ins.run(projet, tache, role, moteur, u.modele, u.entree, u.sortie, u.cache_lecture, u.cache_ecriture, u.cout_api_usd, i === 0 ? duree_s : 0))
  if (!usages.length && duree_s) ins.run(projet, tache, role, moteur, "inconnu", 0, 0, 0, 0, null, duree_s)
}

// --- Monnaie ------------------------------------------------------------------------

export const devise = (config) => config.couts?.devise ?? "EUR"
// Un montant API (dollars) dans la devise d'affichage.
export const versDevise = (config, usd) => (devise(config) === "USD" ? usd : usd * Number(config.couts?.taux_usd ?? 0.86))
export function montant(config, valeur, { decimales = 2 } = {}) {
  if (valeur === null || valeur === undefined || Number.isNaN(valeur)) return "—"
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: devise(config), minimumFractionDigits: decimales, maximumFractionDigits: decimales }).format(valeur)
}
export const mois = (d = new Date()) => d.toISOString().slice(0, 7)

// --- Calculs ------------------------------------------------------------------------

// Les frais fixes d'un mois (abonnements et serveur), dans la devise d'affichage.
export function fraisFixes(config) {
  const abonnements = (config.couts?.abonnements ?? []).map((a) => ({ nom: a.nom, montant: Number(a.mensuel ?? 0), moteurs: a.moteurs ?? [] }))
  return { abonnements, serveur: Number(config.couts?.serveur_mensuel ?? 0) }
}

// Les consommations d'un mois, par projet : équivalent API, coût réel réparti, jetons, durée.
export function bilanMois(db, config, m = mois()) {
  const lignes = db.prepare("SELECT * FROM consommations WHERE substr(le, 1, 7) = ?").all(m)
  const fixes = fraisFixes(config)
  const parProjet = new Map()
  const ligneProjet = (id) => {
    if (!parProjet.has(id)) parProjet.set(id, { projet_id: id, api: 0, api_inconnu: false, reel: 0, entree: 0, sortie: 0, cache: 0, duree_s: 0, parModele: {} })
    return parProjet.get(id)
  }
  const totalMoteur = {}
  let dureeTotale = 0
  let variable = 0 // ce qui se paie à l'usage (la passerelle) : coût réel = équivalent API
  for (const l of lignes) {
    const p = ligneProjet(l.projet_id)
    const api = l.cout_api_usd === null ? 0 : versDevise(config, l.cout_api_usd)
    if (l.cout_api_usd === null && (l.entree || l.sortie)) p.api_inconnu = true
    p.api += api
    if (l.moteur === "passerelle") {
      p.reel += api
      variable += api
    }
    p.entree += l.entree
    p.sortie += l.sortie
    p.cache += l.cache_lecture + l.cache_ecriture
    p.duree_s += l.duree_s
    const pm = (p.parModele[l.modele] ??= { modele: l.modele, moteur: l.moteur, api: 0, jetons: 0, appels: 0 })
    pm.api += api
    pm.jetons += l.entree + l.sortie + l.cache_lecture + l.cache_ecriture
    pm.appels += 1
    // Poids pour répartir un abonnement : l'équivalent API, ou à défaut les jetons.
    const poids = api || (l.entree + l.sortie) / 1e6
    totalMoteur[l.moteur] = (totalMoteur[l.moteur] ?? 0) + poids
    p[`poids_${l.moteur}`] = (p[`poids_${l.moteur}`] ?? 0) + poids
    dureeTotale += l.duree_s
  }
  // Répartition : chaque abonnement entre les projets qui ont utilisé ses moteurs ;
  // le serveur au prorata du temps de calcul.
  for (const p of parProjet.values()) {
    for (const a of fixes.abonnements) {
      const total = a.moteurs.reduce((s, mo) => s + (totalMoteur[mo] ?? 0), 0)
      const part = a.moteurs.reduce((s, mo) => s + (p[`poids_${mo}`] ?? 0), 0)
      if (total > 0) p.reel += (a.montant * part) / total
    }
    if (dureeTotale > 0) p.reel += (fixes.serveur * p.duree_s) / dureeTotale
  }
  const projets = [...parProjet.values()].sort((a, b) => b.api - a.api)
  const api = projets.reduce((s, p) => s + p.api, 0)
  const fixe = fixes.abonnements.reduce((s, a) => s + a.montant, 0) + fixes.serveur
  return { mois: m, projets, api, reel: fixe + variable, fixe, variable, appels: lignes.length, jetons: projets.reduce((s, p) => s + p.entree + p.sortie + p.cache, 0) }
}

// L'évolution sur n mois : équivalent API et coût réel (frais fixes) par mois.
export function evolution(db, config, n = 6) {
  const res = []
  const d = new Date()
  d.setUTCDate(1)
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1))
    const b = bilanMois(db, config, mois(x))
    res.push({ mois: b.mois, api: b.api, reel: b.appels ? b.reel : 0, appels: b.appels })
  }
  return res
}

// Tout ce qu'un projet a coûté, depuis le début : modèles, rôles, temps, qualité.
export function bilanProjet(db, config, projetId) {
  const lignes = db.prepare("SELECT * FROM consommations WHERE projet_id = ?").all(projetId)
  const parModele = {}
  const parRole = {}
  let api = 0
  let inconnu = false
  for (const l of lignes) {
    const v = l.cout_api_usd === null ? 0 : versDevise(config, l.cout_api_usd)
    if (l.cout_api_usd === null && (l.entree || l.sortie)) inconnu = true
    api += v
    const m = (parModele[l.modele] ??= { modele: l.modele, api: 0, jetons: 0, appels: 0, duree_s: 0 })
    m.api += v
    m.jetons += l.entree + l.sortie + l.cache_lecture + l.cache_ecriture
    m.appels += 1
    m.duree_s += l.duree_s
    const r = (parRole[l.role] ??= { role: l.role, api: 0, appels: 0, duree_s: 0 })
    r.api += v
    r.appels += 1
    r.duree_s += l.duree_s
  }
  // Le coût réel : la part du projet dans chaque mois où il a consommé.
  const moisActifs = [...new Set(lignes.map((l) => l.le.slice(0, 7)))]
  const reel = moisActifs.reduce((s, m) => s + (bilanMois(db, config, m).projets.find((p) => p.projet_id === projetId)?.reel ?? 0), 0)
  const compte = (type) => db.prepare("SELECT COUNT(*) AS n FROM journal WHERE projet_id = ? AND type = ?").get(projetId, type).n
  const bornes = db.prepare("SELECT MIN(le) AS debut, MAX(le) AS fin FROM journal WHERE projet_id = ? AND type IN ('fabrication', 'fusion', 'livraison')").get(projetId)
  const taches = db.prepare("SELECT statut, COUNT(*) AS n FROM taches WHERE projet_id = ? GROUP BY statut").all(projetId)
  return {
    api,
    api_inconnu: inconnu,
    reel,
    mesure: lignes.length > 0,
    parModele: Object.values(parModele).sort((a, b) => b.api - a.api || b.jetons - a.jetons),
    parRole: Object.values(parRole).sort((a, b) => b.api - a.api),
    calcul_s: lignes.reduce((s, l) => s + l.duree_s, 0),
    debut: bornes?.debut ?? null,
    fin: bornes?.fin ?? null,
    taches: Object.fromEntries(taches.map((t) => [t.statut, t.n])),
    refus: compte("refus"),
    escalades: compte("escalade"),
    corrections: compte("corrections"),
    decisions: compte("decision"),
  }
}

// Les réglages faits dans Slack l'emportent sur le contrat (usine.config.yml).
export function reglagesCouts(db, config) {
  let s = {}
  try {
    s = JSON.parse(lireReglage(db, "couts", "{}"))
  } catch {}
  return { ...config, couts: { ...(config.couts ?? {}), ...(s.couts ?? {}) }, budget: { ...(config.budget ?? {}), ...(s.budget ?? {}) } }
}

// --- Budgets -------------------------------------------------------------------------
// Les budgets portent sur l'équivalent API : c'est lui qui mesure l'usage réel des
// abonnements (et ce qu'on paierait avec des clés).

export const lireReglage = (db, cle, defaut = null) => db.prepare("SELECT valeur FROM reglages WHERE cle = ?").get(cle)?.valeur ?? defaut
export const ecrireReglage = (db, cle, valeur) => db.prepare("INSERT INTO reglages (cle, valeur) VALUES (?, ?) ON CONFLICT(cle) DO UPDATE SET valeur = excluded.valeur").run(cle, String(valeur))

export function budgetMensuel(db, config, m = mois()) {
  const base = Number(config.budget?.mensuel ?? 0)
  return base > 0 ? base + Number(lireReglage(db, `supplement_mensuel_${m}`, 0)) : 0
}
export function budgetProjet(db, config, projet) {
  const base = Number(config.budget?.par_projet ?? 0)
  return base > 0 ? base + Number(projet.budget_supplement ?? 0) : 0
}
export const coutProjetApi = (db, config, projetId) => bilanProjet(db, config, projetId).api

// Le seuil franchi le plus haut (50, 80, 100…) pour un montant et un budget.
export function seuilAtteint(config, depense, budget) {
  if (!(budget > 0)) return null
  const pct = (depense / budget) * 100
  const seuils = [...(config.budget?.alertes ?? [50, 80, 100])].sort((a, b) => b - a)
  return seuils.find((s) => pct >= s) ?? null
}

// Une barre en texte, pour Slack : ▇▇▇▇▇▁▁▁▁▁
export function barre(fraction, largeur = 12) {
  const f = Math.max(0, Math.min(1, fraction || 0))
  const pleins = Math.round(f * largeur)
  return "▇".repeat(pleins) + "▁".repeat(largeur - pleins)
}
