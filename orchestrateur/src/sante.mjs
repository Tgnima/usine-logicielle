// La santé de l'usine : chaque minute, l'état de chaque composant (ok, alerte,
// panne). Une alerte Slack seulement quand un état CHANGE, et seulement après
// deux constats identiques de suite : une coupure passagère ne fait pas de bruit.
//
// Sources : /app/etat/sante.json (écrit par le déployeur : disque, mémoire,
// conteneurs, place des produits, mise à jour), les serveurs de travaux, le
// portier, GitHub, et un contrôle des connexions Claude et Codex toutes les 6 h.
import { facturationsEnCours, limitesEnCours, nomMode } from "./moteurs.mjs"
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

// Le nom de chaque produit, pour des alertes lisibles (« Vigie Copro · production »).
function nomsDesProduits(db) {
  try {
    return Object.fromEntries(db.prepare("SELECT slug, nom FROM projets WHERE slug IS NOT NULL").all().map((p) => [p.slug, p.nom || p.slug]))
  } catch {
    return {}
  }
}

// Les applications en ligne. Avec la sonde du déployeur (sante.json, champ « applications ») :
// une ligne par produit et par environnement, jugée là-bas (état Docker, santé, redémarrages,
// /api/health), plus une ligne de résumé qui n'alerte jamais seule (resume: true), car chaque
// produit alerte déjà pour lui-même. Chaque ligne de produit porte une clé stable (cle :
// « apercu/<slug> ») et la date de la mesure (mesure_le) : la surveillance range ses états par
// clé, et ne compte qu'une fois une même mesure. Sans sonde récente (déployeur plus ancien, ou
// sonde bloquée) : l'ancien constat, une seule ligne, « arrêtées ou non ».
export const SONDE_PERIMEE_S = 180
// L'ancien constat : une seule ligne, « arrêtées ou non ».
function constatSimple(s, listeConnue) {
  if (!listeConnue) return { nom: "applications", etat: "inconnu", detail: "état inconnu pour l'instant" }
  const applis = s.conteneurs.filter((x) => /^usine-(apercu|prod)-/.test(x.nom))
  const arretees = applis.filter((x) => x.etat !== "running")
  return { nom: "applications", etat: arretees.length ? "alerte" : "ok", detail: arretees.length ? `arrêtée(s) : ${arretees.map((x) => x.nom.replace(/^usine-/, "")).join(", ")}` : `${applis.length} en ligne` }
}
export function composantsApplications(s, { perime = false, listeConnue = true, noms = {}, maintenant = Date.now() } = {}) {
  const sonde = !perime ? s?.applications : null
  const recente = sonde?.produits && (maintenant - new Date(sonde.le).getTime()) / 1000 <= SONDE_PERIMEE_S
  if (recente) {
    const lignes = Object.entries(sonde.produits)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cle, p]) => {
        const [environnement, produit] = cle.split("/")
        const version = p.version ? `version ${String(p.version).slice(0, 7)}` : null
        return { nom: `${noms[produit] ?? produit} · ${environnement === "apercu" ? "aperçu" : "production"}`, etat: p.etat, detail: [p.raison, version].filter(Boolean).join(" · "), produit, environnement, cle, mesure_le: sonde.le }
      })
    // Deux produits du même nom (slugs différents) : le slug les distingue à l'affichage.
    const doublons = new Set(lignes.filter((x, i) => lignes.findIndex((y) => y.nom === x.nom) !== i).map((x) => x.nom))
    for (const x of lignes) if (doublons.has(x.nom)) x.nom = x.nom.replace(" · ", ` (${x.produit}) · `)
    const compte = (etat) => lignes.filter((x) => x.etat === etat).length
    const [pannes, alertes] = [compte("panne"), compte("alerte")]
    const resume = [`${compte("ok")} en ligne`, pannes ? `${pannes} en panne` : null, alertes ? `${alertes} en alerte` : null].filter(Boolean).join(" · ")
    // etat_constat : ce que dirait l'ancien constat, gardé sous la clé « applications » ; si la
    // sonde manque un jour, le repli compare ainsi la même chose (jamais un faux « rétabli »).
    return [{ nom: "applications", etat: pannes ? "panne" : alertes ? "alerte" : "ok", detail: resume, resume: true, sonde: true, etat_constat: constatSimple(s, listeConnue).etat }, ...lignes]
  }
  return [constatSimple(s, listeConnue)]
}

// L'état de chaque composant : [{ nom, etat: ok|alerte|panne|inconnu, detail }].
export async function etatUsine(ctx) {
  const { config } = ctx
  const s = lireSanteServeur(config)
  const c = []
  const ajouter = (nom, etat, detail) => c.push({ nom, etat, detail })
  const ageDeployeur = s ? (Date.now() - new Date(s.le).getTime()) / 1000 : Infinity

  // Le serveur. Un bilan trop ancien ne dit plus rien des conteneurs : ils passent en
  // « inconnu » au lieu d'être déclarés absents (la console croirait l'usine en panne).
  const perime = !s || ageDeployeur > 180
  if (perime) ajouter("déployeur", "panne", s ? `dernier signe il y a ${Math.round(ageDeployeur / 60)} min` : "aucun bilan de santé")
  else if (s.boucle_le && Date.now() - new Date(s.boucle_le).getTime() > 20 * 60_000) ajouter("déployeur", "alerte", `aucun tour de déploiement terminé depuis ${Math.round((Date.now() - new Date(s.boucle_le).getTime()) / 60_000)} min (réseau ou GitHub injoignable ?)`)
  const listeConnue = !perime && Array.isArray(s.conteneurs)
  // Les lignes des produits vont à la fin : nombreuses, elles ne doivent pas repousser hors de
  // l'écran (grille de l'onglet Accueil, 20 lignes) celles de l'usine elle-même.
  let applications = []
  if (s) {
    const d = s.disque
    ajouter("disque", d.pct >= 90 ? "panne" : d.pct >= 80 ? "alerte" : "ok", `${d.pct} % utilisés, ${d.libre_go} Go libres sur ${d.total_go}`)
    const m = s.memoire
    ajouter("mémoire", m.dispo_mo < 200 ? "panne" : m.dispo_mo < 400 ? "alerte" : "ok", `${m.dispo_mo} Mo disponibles sur ${m.total_mo}${m.swap_utilise_mo > 500 ? ` · ${m.swap_utilise_mo} Mo en swap` : ""}`)
    // Les conteneurs de l'usine.
    for (const [nom, conteneur] of SERVICES) {
      if (nom === "orchestrateur" || c.some((x) => x.nom === nom)) continue // le déployeur, déjà jugé plus haut
      if (!listeConnue) {
        ajouter(nom, "inconnu", perime ? "bilan du serveur trop ancien" : "liste des conteneurs illisible (Docker trop lent ?)")
        continue
      }
      const ct = s.conteneurs.find((x) => x.nom === conteneur)
      if (!ct) ajouter(nom, "panne", "conteneur absent")
      else if (ct.etat !== "running") ajouter(nom, "panne", ct.statut)
      else ajouter(nom, /unhealthy/i.test(ct.statut) ? "alerte" : "ok", ct.statut.replace(/^Up /, "en marche depuis ").replace(/ \(healthy\)/, ""))
    }
    // Les applications en ligne : une ligne par produit et par environnement (ajoutées à la fin).
    applications = composantsApplications(s, { perime, listeConnue, noms: nomsDesProduits(ctx.db) })
    // Le déployeur n'arrive plus à comparer l'usine à GitHub : elle se croirait à jour.
    const e = s.mise_a_jour?.erreur
    if (e) ajouter("mises à jour", "alerte", `vérification impossible depuis ${new Date(e.depuis).toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })} : ${e.message}`)
  }
  ajouter("orchestrateur", "ok", "en marche")

  // Les serveurs de travaux et le portier, vus d'ici.
  for (const [nom, url] of [["atelier", config.atelier.url], ["vérificateur", config.verificateur.url]]) {
    const r = await santeServeurTravaux(url)
    const ligne = c.find((x) => x.nom === nom)
    if (!r && ligne) Object.assign(ligne, { etat: "panne", detail: "ne répond pas" })
    else if (r && ligne?.etat === "inconnu") Object.assign(ligne, { etat: "ok", detail: r.occupe ? "répond · au travail" : "répond" })
    else if (r && ligne && r.occupe) ligne.detail = `${ligne.detail} · au travail`
  }
  const p = await ping("http://portier:8080/_portier/connexion")
  const lp = c.find((x) => x.nom === "portier")
  if (lp && !p?.ok) Object.assign(lp, { etat: "panne", detail: "ne répond pas" })
  else if (lp?.etat === "inconnu") Object.assign(lp, { etat: "ok", detail: "répond" })

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
  const sansCredit = new Set(facturationsEnCours(ctx.db).map((f) => `${f.moteur}_${f.mode}`))
  for (const l of limitesEnCours(ctx.db)) {
    const heure = new Date(l.jusqua).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" })
    const pourquoi = sansCredit.has(`${l.moteur}_${l.mode}`) ? `refusée faute de crédit, retentée vers ${heure} : ajoute du crédit sur le compte` : `limite d'usage atteinte jusqu'à ${heure}`
    ajouter(`${l.moteur === "codex" ? "Codex" : "Claude"} · ${nomMode(l.mode)}`, "alerte", `${pourquoi} ; l'usine passe par la façon suivante, ou se met en pause sans consommer de tentative`)
  }
  c.push(...applications)
  retenirEtatUsine(c)
  return { composants: c, serveur: s }
}

// Le dernier bilan des composants (la surveillance le refait chaque minute, la page État à chaque
// visite) : la file d'attention (attention.mjs) le lit sans refaire les appels réseau. null tant
// qu'aucun bilan n'a été fait depuis le démarrage.
let dernierBilan = null
export const dernierEtatUsine = () => dernierBilan
export function retenirEtatUsine(composants, le = Date.now()) {
  dernierBilan = { composants, le }
}

// Le tri d'un passage de la surveillance : les changements confirmés et les états à garder.
// memoire = { precedents: { clé: état }, candidats: { clé: { etat, mesure } } }. La clé est
// x.cle (« apercu/<slug> ») pour une ligne de produit, son nom pour le reste. Un changement est
// confirmé par deux constats identiques de suite ; pour une ligne de produit, par deux mesures
// distinctes de la sonde (une même mesure relue ne compte pas deux fois).
export function examinerSante(composants, memoire) {
  const { precedents, candidats } = memoire
  const changements = []
  let modifie = false
  for (const x of composants) {
    const cle = x.cle ?? x.nom
    if (x.resume) {
      // Le résumé des applications n'alerte pas (chaque produit alerte pour lui-même). Sous sa
      // clé est gardé l'état de l'ancien constat : si la sonde manque, le repli repart de là.
      const e = x.etat_constat
      if (e && e !== "inconnu" && precedents[cle] !== e) {
        precedents[cle] = e
        modifie = true
      }
      delete candidats[cle]
      continue
    }
    if (x.etat === "inconnu") {
      // Un produit le temps d'un déploiement : sa suite de constats repart de zéro. Les autres
      // lignes gardent l'ancienne règle (un « inconnu » est ignoré, la suite continue).
      if (x.cle) delete candidats[cle]
      continue
    }
    const avant = precedents[cle] ?? "ok"
    if (x.etat === avant) {
      delete candidats[cle]
      continue
    }
    const candidat = candidats[cle]
    if (!candidat || candidat.etat !== x.etat) {
      candidats[cle] = { etat: x.etat, mesure: x.mesure_le ?? null }
      continue
    }
    if (x.mesure_le && candidat.mesure === x.mesure_le) continue
    delete candidats[cle]
    precedents[cle] = x.etat
    modifie = true
    changements.push({ ...x, avant })
  }
  // Un produit que la sonde ne mesure plus (retiré) ne garde aucun état : remis en ligne, il repart de « ok ».
  if (composants.some((x) => x.resume && x.sonde)) {
    const mesures = new Set(composants.map((x) => x.cle).filter(Boolean))
    const produit = (cle) => /^(apercu|production)\//.test(cle) && !mesures.has(cle)
    for (const cle of Object.keys(precedents)) {
      if (produit(cle)) {
        delete precedents[cle]
        modifie = true
      }
    }
    for (const cle of Object.keys(candidats)) if (produit(cle)) delete candidats[cle]
  }
  return { changements, modifie }
}

// Un message d'alerte lisible : au-delà, « et N autres » renvoie à la page de santé.
export const MAX_LIGNES_ALERTE = 15
export function texteAlerte(changements) {
  const lignes = changements.slice(0, MAX_LIGNES_ALERTE).map((x) => `${PICTO[x.etat]} *${x.nom}* : ${x.etat === "ok" ? "rétabli" : x.etat} — ${x.detail}`)
  if (changements.length > MAX_LIGNES_ALERTE) lignes.push(`… et ${changements.length - MAX_LIGNES_ALERTE} autre(s) : voir la santé`)
  const grave = changements.some((x) => x.etat === "panne")
  return `${grave ? ":rotating_light:" : changements.every((x) => x.etat === "ok") ? ":white_check_mark:" : ":warning:"} *Santé de l'usine*\n${lignes.join("\n")}`
}

export const PICTO = { ok: "🟢", alerte: "🟠", panne: "🔴", inconnu: "⚪" }
export const resumeEtat = (composants) => (composants.some((x) => x.etat === "panne") ? "panne" : composants.some((x) => x.etat === "alerte") ? "alerte" : "ok")

// La surveillance : chaque minute ; une alerte quand un état change (confirmé deux fois).
export function surveillerSante(ctx) {
  let precedents = {}
  try {
    precedents = JSON.parse(lireReglage(ctx.db, "sante_etats", "{}"))
  } catch {}
  const memoire = { precedents, candidats: {} }
  const tour = async () => {
    const { composants } = await etatUsine(ctx)
    const { changements, modifie } = examinerSante(composants, memoire)
    if (modifie) ecrireReglage(ctx.db, "sante_etats", JSON.stringify(memoire.precedents))
    if (!changements.length) return
    await ctx.notifier.alerte(texteAlerte(changements), [{ texte: "Voir la santé", action: "sante_voir", valeur: "1" }]).catch((e) => console.error("Alerte santé :", e.message))
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
