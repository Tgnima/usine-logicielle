// La santé de l'usine : chaque minute, l'état de chaque composant (ok, alerte,
// panne). Une alerte Slack seulement quand un état CHANGE, et seulement après
// deux constats identiques de suite : une coupure passagère ne fait pas de bruit.
//
// Sources : /app/etat/sante.json (écrit par le déployeur : disque, mémoire,
// conteneurs, place des produits, mise à jour), les serveurs de travaux, le
// portier, GitHub, et un contrôle des connexions Claude et Codex toutes les 6 h.
import { limitesEnCours, nomMode } from "./moteurs.mjs"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { sante as santeServeurTravaux, executer, lireFichier } from "./travaux.mjs"
import { ecrireReglage, lireReglage } from "./couts.mjs"

const SERVICES = [
  ["orchestrateur", "usine-logicielle-orchestrateur-1"],
  ["atelier", "usine-logicielle-atelier-1-1"],
  ["vérificateur", "usine-logicielle-verificateur-1"],
  ["déployeur", "usine-logicielle-deployeur-1"],
  ["portier", "usine-logicielle-portier-1"],
  ["caddy (HTTPS)", "usine-caddy"],
  ["mailpit", "usine-logicielle-mailpit-1"],
]

export function lireSanteServeur(config) {
  try {
    return JSON.parse(readFileSync(join(config.etatDir, "sante.json"), "utf8"))
  } catch {
    return null
  }
}

// Le contrôle des connexions aux modèles, mémorisé (il coûte un appel ; toutes les 6 h).
const connexions = { claude: null, codex: null }

export async function verifierConnexions(ctx) {
  const { config } = ctx
  const a = await santeServeurTravaux(config.atelier.url)
  if (a && !a.occupe) {
    const r = await executer(config.atelier.url, config.secrets.worker, [
      "cd /tmp && claude -p 'Réponds seulement : OK' --model claude-haiku-4-5 --max-turns 1 --output-format json > /tmp/sorties/connexion.json 2>&1",
      "echo \"@@ CODE $?\"",
    ].join("\n"), { minutes: 3 }).catch(() => null)
    let detail = "pas de réponse"
    try {
      const j = JSON.parse(await lireFichier(config.atelier.url, config.secrets.worker, "/tmp/sorties/connexion.json"))
      detail = j.is_error ? String(j.result ?? "erreur").slice(0, 160) : "connecté"
      connexions.claude = { ok: !j.is_error, detail, le: new Date().toISOString() }
    } catch {
      connexions.claude = { ok: false, detail: r ? "réponse illisible (connexion expirée ?)" : detail, le: new Date().toISOString() }
    }
  }
  const v = await santeServeurTravaux(config.verificateur.url)
  if (v && !v.occupe) {
    const r = await executer(config.verificateur.url, config.secrets.worker, "codex login status 2>&1 | tail -1; echo \"@@ CODE ${PIPESTATUS[0]}\"", { minutes: 2 }).catch(() => null)
    const sortie = String(r?.journal ?? "").trim().split("\n")[0] ?? ""
    connexions.codex = { ok: r?.marqueurs?.CODE === "0" && /logged in/i.test(sortie), detail: sortie.slice(0, 120) || "pas de réponse", le: new Date().toISOString() }
  }
}

async function ping(url, options = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000), ...options })
    return res
  } catch {
    return null
  }
}

// L'état de chaque composant : [{ nom, etat: ok|alerte|panne|inconnu, detail }].
export async function etatUsine(ctx) {
  const { config } = ctx
  const s = lireSanteServeur(config)
  const c = []
  const ajouter = (nom, etat, detail) => c.push({ nom, etat, detail })
  const ageDeployeur = s ? (Date.now() - new Date(s.le).getTime()) / 1000 : Infinity

  // Le serveur.
  if (!s || ageDeployeur > 180) ajouter("déployeur", "panne", s ? `dernier signe il y a ${Math.round(ageDeployeur / 60)} min` : "aucun bilan de santé")
  if (s) {
    const d = s.disque
    ajouter("disque", d.pct >= 90 ? "panne" : d.pct >= 80 ? "alerte" : "ok", `${d.pct} % utilisés, ${d.libre_go} Go libres sur ${d.total_go}`)
    const m = s.memoire
    ajouter("mémoire", m.dispo_mo < 200 ? "panne" : m.dispo_mo < 400 ? "alerte" : "ok", `${m.dispo_mo} Mo disponibles sur ${m.total_mo}${m.swap_utilise_mo > 500 ? ` · ${m.swap_utilise_mo} Mo en swap` : ""}`)
    // Les conteneurs de l'usine.
    for (const [nom, conteneur] of SERVICES) {
      if (nom === "orchestrateur") continue
      const ct = s.conteneurs.find((x) => x.nom === conteneur)
      if (!ct) ajouter(nom, "panne", "conteneur absent")
      else if (ct.etat !== "running") ajouter(nom, "panne", ct.statut)
      else ajouter(nom, /unhealthy/i.test(ct.statut) ? "alerte" : "ok", ct.statut.replace(/^Up /, "en marche depuis ").replace(/ \(healthy\)/, ""))
    }
    // Les applications en ligne.
    const applis = s.conteneurs.filter((x) => /^usine-(apercu|prod)-/.test(x.nom))
    const arretees = applis.filter((x) => x.etat !== "running")
    ajouter("applications", arretees.length ? "alerte" : "ok", arretees.length ? `arrêtée(s) : ${arretees.map((x) => x.nom.replace(/^usine-/, "")).join(", ")}` : `${applis.length} en ligne`)
  }
  ajouter("orchestrateur", "ok", "en marche")

  // Les serveurs de travaux et le portier, vus d'ici.
  for (const [nom, url] of [["atelier", config.atelier.url], ["vérificateur", config.verificateur.url]]) {
    const r = await santeServeurTravaux(url)
    const ligne = c.find((x) => x.nom === nom)
    if (!r && ligne) Object.assign(ligne, { etat: "panne", detail: "ne répond pas" })
    else if (r && ligne && r.occupe) ligne.detail = `${ligne.detail} · au travail`
  }
  const p = await ping("http://portier:8080/_portier/connexion")
  const lp = c.find((x) => x.nom === "portier")
  if (lp && !p?.ok) Object.assign(lp, { etat: "panne", detail: "ne répond pas" })

  // GitHub (et le quota d'appels).
  const g = await ping("https://api.github.com/rate_limit", { headers: { authorization: `Bearer ${config.secrets.github}` } })
  if (!g?.ok) ajouter("GitHub", "alerte", g ? `réponse ${g.status}` : "injoignable")
  else {
    const restant = (await g.json().catch(() => ({})))?.rate?.remaining
    ajouter("GitHub", restant !== undefined && restant < 200 ? "alerte" : "ok", restant !== undefined ? `${restant} appels restants cette heure` : "joignable")
  }

  // Les connexions aux modèles (contrôle toutes les 6 h).
  for (const [nom, cle] of [["Claude (agents)", "claude"], ["Codex (vérificateur)", "codex"]]) {
    const x = connexions[cle]
    ajouter(nom, !x ? "inconnu" : x.ok ? "ok" : "panne", !x ? "pas encore contrôlé" : `${x.detail} · ${new Date(x.le).toLocaleString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" })}`)
  }
  // Les limites d'usage en cours (abonnements, clés) : l'usine bascule seule, on le montre.
  for (const l of limitesEnCours(ctx.db)) {
    const heure = new Date(l.jusqua).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })
    ajouter(`${l.moteur === "codex" ? "Codex" : "Claude"} · ${nomMode(l.mode)}`, "alerte", `limite d'usage atteinte jusqu'à ${heure} : l'usine passe par la façon suivante (clé API ou passerelle)`)
  }
  return { composants: c, serveur: s }
}

export const PICTO = { ok: "🟢", alerte: "🟠", panne: "🔴", inconnu: "⚪" }
export const resumeEtat = (composants) => (composants.some((x) => x.etat === "panne") ? "panne" : composants.some((x) => x.etat === "alerte") ? "alerte" : "ok")

// La surveillance : chaque minute ; une alerte quand un état change (confirmé deux fois).
export function surveillerSante(ctx) {
  let precedents = {}
  try {
    precedents = JSON.parse(lireReglage(ctx.db, "sante_etats", "{}"))
  } catch {}
  const candidats = {}
  const tour = async () => {
    const { composants } = await etatUsine(ctx)
    const changements = []
    for (const x of composants) {
      if (x.etat === "inconnu") continue
      const avant = precedents[x.nom] ?? "ok"
      if (x.etat === avant) {
        delete candidats[x.nom]
        continue
      }
      // Deux constats identiques de suite avant d'alerter.
      if (candidats[x.nom] !== x.etat) {
        candidats[x.nom] = x.etat
        continue
      }
      delete candidats[x.nom]
      precedents[x.nom] = x.etat
      changements.push({ ...x, avant })
    }
    if (!changements.length) return
    ecrireReglage(ctx.db, "sante_etats", JSON.stringify(precedents))
    const lignes = changements.map((x) => `${PICTO[x.etat]} *${x.nom}* : ${x.etat === "ok" ? "rétabli" : x.etat} — ${x.detail}`)
    const grave = changements.some((x) => x.etat === "panne")
    await ctx.notifier.alerte(`${grave ? ":rotating_light:" : changements.every((x) => x.etat === "ok") ? ":white_check_mark:" : ":warning:"} *Santé de l'usine*\n${lignes.join("\n")}`, [{ texte: "Voir la santé", action: "sante_voir", valeur: "1" }]).catch((e) => console.error("Alerte santé :", e.message))
  }
  setTimeout(() => tour().catch((e) => console.error("Santé :", e.message)), 20_000)
  setInterval(() => tour().catch((e) => console.error("Santé :", e.message)), 60_000)
  // Les connexions : un contrôle toutes les 6 h ; tant qu'un serveur est occupé, on réessaie toutes les 15 min.
  const recent = (x) => x && Date.now() - new Date(x.le).getTime() < 6 * 3600_000
  const connexionsTour = () => {
    if (recent(connexions.claude) && recent(connexions.codex)) return
    verifierConnexions(ctx).catch((e) => console.error("Connexions :", e.message))
  }
  setTimeout(connexionsTour, 90_000)
  setInterval(connexionsTour, 15 * 60_000)
}
