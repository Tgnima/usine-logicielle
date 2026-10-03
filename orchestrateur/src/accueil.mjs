// L'onglet Accueil de l'app Slack : le tableau de bord de l'usine.
// Les chiffres clés en grille, puis de vrais tableaux (bloc « table » de Slack)
// pour les projets, les modèles et les mois. Si Slack refuse les tableaux, la
// même information est rendue en grilles de champs (vueAccueil(ctx, { tableaux: false })).
// Les courbes sont sur la page web (bouton en haut).
import { bilanMois, bilanProjet, budgetMensuel, budgetProjet, evolution, montant, reglagesCouts } from "./couts.mjs"
import { adresseTableau, duree, nomMois } from "./slack-couts.mjs"
import { PICTO, etatUsine, lireSanteServeur, resumeEtat } from "./sante.mjs"
import { decrireApercu } from "./cycle.mjs"

const tronquer = (t, n = 2900) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
const md = (texte) => ({ type: "mrkdwn", text: tronquer(texte, 1900) })
const section = (texte) => ({ type: "section", text: md(texte) })
const champs = (liste) => ({ type: "section", fields: liste.slice(0, 10).map(md) })
const contexte = (texte) => ({ type: "context", elements: [md(texte)] })
const titre = (texte) => ({ type: "header", text: { type: "plain_text", text: texte, emoji: true } })
const separateur = { type: "divider" }
const pluriel = (n, mot) => `${n} ${mot}${n > 1 ? "s" : ""}`
const jetons = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n))
const NOMS_LONGS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"]
const moisLong = (m) => `${NOMS_LONGS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`
const bouton = (texte, action_id, value, style) => ({ type: "button", text: { type: "plain_text", text: texte, emoji: true }, action_id, value: String(value), ...(style ? { style } : {}) })
const lien = (texte, url, action_id, style) => ({ type: "button", text: { type: "plain_text", text: texte, emoji: true }, url, action_id, ...(style ? { style } : {}) })

// Une barre en carrés de couleur : vert, jaune (50 %), orange (80 %), rouge (100 %).
export function barreCouleur(fraction, n = 10) {
  const f = Math.max(0, Math.min(1, fraction || 0))
  const pleins = Math.round(f * n)
  const couleur = f >= 1 ? "🟥" : f >= 0.8 ? "🟧" : f >= 0.5 ? "🟨" : "🟩"
  return couleur.repeat(pleins) + "⬜".repeat(n - pleins)
}

// Un tableau Slack : la première ligne (en-têtes) en gras ; colonnes numériques à droite.
function tableau(entetes, lignes, droite = []) {
  const gras = (t) => ({ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: String(t), style: { bold: true } }] }] })
  const brut = (t) => ({ type: "raw_text", text: String(t ?? "") || " " })
  return {
    type: "table",
    column_settings: entetes.map((_, i) => (droite.includes(i) ? { align: "right" } : { is_wrapped: true })),
    rows: [entetes.map(gras), ...lignes.slice(0, 99).map((l) => l.map(brut))],
  }
}
// Repli sans tableau : une grille de champs par ligne.
const grille = (entetes, lignes) => lignes.slice(0, 20).map((l) => champs(l.map((v, i) => `*${entetes[i]}*\n${v}`)))
const rendre = (avecTableaux, entetes, lignes, droite) => (avecTableaux ? [tableau(entetes, lignes, droite)] : grille(entetes, lignes))

const STATUTS = {
  analyse: "🧠 analyse", questions: "❓ questions", plan_a_valider: "📋 plan à valider", creation: "🏗️ création",
  fabrication: "🛠️ fabrication", bloque: "🛑 bloqué", livre: "📦 livré", corrections: "📝 corrections",
  mise_en_production: "🚀 mise en prod.", en_production: "🟢 en production", echec: "❌ échec", arrete: "⏹️ arrêté", abandonne: "🗑️ abandonné", supprime: "🗑️ supprimé",
}

// Les chiffres clés du mois : l'onglet Accueil et /usine couts.
export function blocsResume(ctx) {
  const { db } = ctx
  const config = reglagesCouts(db, ctx.config)
  const b = bilanMois(db, config)
  const budget = budgetMensuel(db, config)
  const calcul = b.projets.reduce((s, p) => s + p.duree_s, 0)
  const blocs = [
    titre(`📊 Coûts · ${moisLong(b.mois)}`),
    champs([
      `*Équivalent API*\n${montant(config, b.api)}`,
      `*Coût réel*\n${b.fixe > 0 ? montant(config, b.reel) : "_à configurer_"}`,
      `*Budget du mois*\n${budget > 0 ? `${barreCouleur(b.api / budget)}  ${Math.round((b.api / budget) * 100)} % de ${montant(config, budget, { decimales: 0 })}` : "_aucun budget défini_"}`,
      `*Activité*\n${jetons(b.jetons)} jetons · ${pluriel(b.appels, "appel")} · ${duree(calcul)}`,
    ]),
  ]
  const conseils = []
  if (!(b.fixe > 0)) conseils.push("renseigne tes abonnements et ton serveur pour obtenir le coût réel")
  if (!(budget > 0)) conseils.push("fixe un budget mensuel pour recevoir des alertes")
  if (b.projets.some((p) => p.api_inconnu)) conseils.push("ajoute le prix de Codex pour inclure le vérificateur")
  if (conseils.length) blocs.push(contexte(`⚙️ Dans *Réglages* : ${conseils.join(" · ")}.`))
  blocs.push({ type: "actions", elements: [lien("📈 Ouvrir le tableau de bord", adresseTableau(config), "lien_tableau", "primary"), bouton("⚙️ Réglages des coûts", "couts_reglages", "1"), bouton("👥 Accès", "acces_ouvrir", "1")] })
  return blocs
}

function blocsProjets(ctx, config, avecTableaux) {
  const { db } = ctx
  const projets = db.prepare("SELECT * FROM projets ORDER BY id DESC LIMIT 40").all()
  const actifs = projets.filter((p) => !["abandonne", "supprime"].includes(p.statut))
  const place = lireSanteServeur(ctx.config)?.produits ?? {}
  const abandonnes = projets.length - actifs.length
  const blocs = [titre("🏭 Projets")]
  if (!actifs.length) return [...blocs, section("_Aucun projet pour l'instant. Lance-en un avec `/usine <ce que tu veux construire>`._")]
  const lignes = actifs.map((p) => {
    const t = db.prepare("SELECT statut, COUNT(*) AS n FROM taches WHERE projet_id = ? GROUP BY statut").all(p.id)
    const total = t.reduce((s, x) => s + x.n, 0)
    const fusionnees = t.find((x) => x.statut === "fusionnee")?.n ?? 0
    const escalades = db.prepare("SELECT COUNT(*) AS n FROM escalades WHERE projet_id = ? AND statut = 'ouverte'").get(p.id).n
    const c = bilanProjet(db, config, p.id)
    const b = budgetProjet(db, config, p)
    return [
      p.id,
      p.nom ?? p.prompt.slice(0, 40),
      `${STATUTS[p.statut] ?? p.statut}${escalades ? " 🚨" : ""}`,
      total ? `${fusionnees}/${total}` : "—",
      c.mesure ? `${montant(config, c.api)}${c.api_inconnu ? "*" : ""}` : "non mesuré",
      c.mesure && c.reel > 0 ? montant(config, c.reel) : "—",
      c.mesure ? duree(c.calcul_s) : "—",
      b > 0 && c.mesure ? `${Math.round((c.api / b) * 100)} %` : "—",
      decrireApercu(p),
      place[p.slug] ? `${Math.round((place[p.slug].images_mo + place[p.slug].volumes_mo) / 100) / 10} Go` : "—",
    ]
  })
  blocs.push(...rendre(avecTableaux, ["N°", "Projet", "Statut", "Tâches", "Équiv. API", "Coût réel", "Calcul", "Budget", "Aperçu", "Disque"], lignes, [0, 3, 4, 5, 6, 7, 9]))
  blocs.push({
    type: "actions",
    elements: [{
      type: "static_select", action_id: "projet_detail_choix",
      placeholder: { type: "plain_text", text: "🔎 Voir le détail d'un projet…" },
      options: actifs.slice(0, 100).map((p) => ({ value: String(p.id), text: { type: "plain_text", text: tronquer(`${p.id}. ${p.nom ?? p.prompt}`, 75) } })),
    }],
  })
  const notes = []
  if (lignes.some((l) => String(l[4]).endsWith("*"))) notes.push("* sans le vérificateur (prix de Codex à renseigner)")
  if (lignes.some((l) => l[2].includes("🚨"))) notes.push("🚨 une décision est attendue")
  if (abandonnes) notes.push(`🗑️ ${pluriel(abandonnes, "projet abandonné ou supprimé")} masqué${abandonnes > 1 ? "s" : ""}`)
  if (notes.length) blocs.push(contexte(notes.join(" · ")))
  return blocs
}

function blocsModeles(config, b, avecTableaux) {
  const parModele = {}
  for (const p of b.projets) for (const m of Object.values(p.parModele)) {
    const x = (parModele[m.modele] ??= { modele: m.modele, api: 0, jetons: 0, appels: 0, inconnu: false })
    x.api += m.api
    x.jetons += m.jetons
    x.appels += m.appels
    if (m.api === 0 && m.jetons > 0 && m.moteur === "codex") x.inconnu = true
  }
  const liste = Object.values(parModele).sort((a, c) => c.api - a.api || c.jetons - a.jetons)
  if (!liste.length) return []
  return [
    titre("🤖 Modèles ce mois-ci"),
    ...rendre(avecTableaux, ["Modèle", "Équiv. API", "Jetons", "Appels"], liste.map((m) => [m.modele, m.inconnu ? "prix à renseigner" : montant(config, m.api), jetons(m.jetons), m.appels]), [1, 2, 3]),
  ]
}

function blocsHistorique(config, evo, avecTableaux) {
  const actifs = evo.filter((e) => e.appels > 0)
  if (actifs.length <= 1) return [contexte("📅 L'historique mois par mois se remplira au fil des mois. Les courbes sont sur le tableau de bord web.")]
  return [
    titre("📅 Mois par mois"),
    ...rendre(avecTableaux, ["Mois", "Équiv. API", "Coût réel", "Appels"], actifs.reverse().map((e) => [nomMois(e.mois), montant(config, e.api), montant(config, e.reel), e.appels]), [1, 2, 3]),
  ]
}

// La santé de l'usine : un tableau des composants, la mise à jour si elle est disponible.
export async function blocsSante(ctx, { avecTableaux = true, complet = false } = {}) {
  const { composants, serveur } = await etatUsine(ctx)
  const etat = resumeEtat(composants)
  const affiches = complet ? composants : composants.filter((x) => x.etat !== "ok" || ["disque", "mémoire", "applications"].includes(x.nom))
  const blocs = [
    titre(`🩺 Santé de l'usine · ${etat === "ok" ? "tout va bien" : etat === "alerte" ? "à surveiller" : "panne"}`),
    ...rendre(avecTableaux, ["État", "Composant", "Détail"], affiches.map((x) => [PICTO[x.etat], x.nom, x.detail]), []),
  ]
  const m = serveur?.mise_a_jour
  const elements = [bouton("🩺 Santé détaillée", "sante_voir", "1")]
  if (m?.disponible) {
    blocs.push(section(`⬆️ *Mise à jour disponible* : ${pluriel(m.disponible, "changement")}\n${m.commits.slice(0, 5).map((c) => `• ${c.replace(/^\w+ /, "")}`).join("\n")}`))
    elements.unshift({ ...bouton("⬆️ Mettre à jour l'usine", "usine_mettre_a_jour", "1", "primary"), confirm: { title: { type: "plain_text", text: "Mettre à jour l'usine ?" }, text: { type: "mrkdwn", text: "L'usine termine la tâche en cours, se reconstruit et redémarre (quelques minutes), puis reprend seule. Les données et les secrets ne bougent pas." }, confirm: { type: "plain_text", text: "Mettre à jour" }, deny: { type: "plain_text", text: "Annuler" } } })
  }
  if (serveur?.entretien) blocs.push(contexte(`🧹 Dernier entretien : ${new Date(serveur.entretien.le).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })} · ${serveur.entretien.libere_mo} Mo libérés${m?.version ? ` · version ${m.version}` : ""}`))
  else if (m?.version) blocs.push(contexte(`Version ${m.version}`))
  blocs.push({ type: "actions", elements })
  return blocs
}

export async function vueAccueil(ctx, { tableaux = true } = {}) {
  const config = reglagesCouts(ctx.db, ctx.config)
  const b = bilanMois(ctx.db, config)
  const sante = await blocsSante(ctx, { avecTableaux: tableaux }).catch((e) => [section(`🩺 Santé indisponible : ${e.message}`)])
  const blocs = [
    ...sante,
    separateur,
    ...blocsResume(ctx),
    separateur,
    ...blocsProjets(ctx, config, tableaux),
    separateur,
    ...blocsModeles(config, b, tableaux),
    ...blocsHistorique(config, evolution(ctx.db, config, 12), tableaux),
    separateur,
    contexte("Commandes : `/usine <demande>` · `/usine corriger <n°> …` · `/usine couts <n°>` · `/usine sante` · `/usine supprimer <n°>` · `/usine acces` · `/usine tableau` · `/usine statut`"),
  ]
  return { type: "home", blocks: blocs.slice(0, 100) }
}
