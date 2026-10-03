// Les coûts dans Slack : le tableau de bord de l'onglet Accueil, le détail d'un
// projet (/usine couts <n°>) et la fenêtre « Réglages des coûts ».
// Slack n'affiche pas de graphiques : des barres en texte, et un lien vers la page web.
import { barre, bilanMois, bilanProjet, budgetMensuel, budgetProjet, evolution, lireReglage, montant, reglagesCouts } from "./couts.mjs"
import { obtenir } from "./db.mjs"

const tronquer = (t, n = 2900) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)
const section = (texte) => ({ type: "section", text: { type: "mrkdwn", text: tronquer(texte) } })
const contexte = (texte) => ({ type: "context", elements: [{ type: "mrkdwn", text: tronquer(texte, 2900) }] })
const jetons = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} M` : n >= 1e3 ? `${Math.round(n / 1e3)} k` : String(n))
export const duree = (s) => {
  const m = Math.round((s ?? 0) / 60)
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${m} min`
}
const NOMS_MOIS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]
export const nomMois = (m) => `${NOMS_MOIS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`

export const adresseTableau = (config) => `${config.domaine?.https === false ? "http" : "https"}://usine-tableau.${config.domaine?.base}`

// Le tableau de bord des coûts, pour l'onglet Accueil.
export function blocsTableauCouts(ctx) {
  const { db } = ctx
  const config = reglagesCouts(db, ctx.config)
  const b = bilanMois(db, config)
  const budget = budgetMensuel(db, config)
  const evo = evolution(db, config, 6)
  const max = Math.max(...evo.map((e) => Math.max(e.api, e.reel)), 0.01)
  const nomProjet = (id) => (id ? obtenir(db, "projets", id)?.nom ?? `projet ${id}` : "Frais généraux (aiguillage)")
  const parModele = {}
  for (const p of b.projets) for (const m of Object.values(p.parModele)) {
    const x = (parModele[m.modele] ??= { modele: m.modele, api: 0, jetons: 0, appels: 0 })
    x.api += m.api
    x.jetons += m.jetons
    x.appels += m.appels
  }
  const fixesRenseignes = b.fixe > 0
  const blocs = [
    { type: "header", text: { type: "plain_text", text: `Coûts · ${nomMois(b.mois)}` } },
    section([
      `*Équivalent API* : *${montant(config, b.api)}*${budget > 0 ? `   ${barre(b.api / budget)}  ${Math.round((b.api / budget) * 100)} % du budget (${montant(config, budget)})` : "   _(pas de budget mensuel)_"}`,
      `*Coût réel* : *${montant(config, b.reel)}*${fixesRenseignes ? " (abonnements et serveur, plus la passerelle)" : " _(frais fixes à renseigner dans les réglages)_"}`,
      `${jetons(b.jetons)} jetons · ${b.appels} appels de modèles ce mois-ci`,
    ].join("\n")),
    section(`*Évolution sur 6 mois* (équivalent API · coût réel)\n${evo.map((e) => `\`${nomMois(e.mois).padEnd(10)}\` ${barre(e.api / max, 10)} ${montant(config, e.api)} · ${montant(config, e.reel)}`).join("\n")}`),
  ]
  if (b.projets.length) {
    blocs.push(section(`*Par projet, ce mois-ci*\n${b.projets.slice(0, 8).map((p) => `• *${nomProjet(p.projet_id)}* : ${montant(config, p.api)}${p.api_inconnu ? "*" : ""} API · ${montant(config, p.reel)} réel · ${jetons(p.entree + p.sortie + p.cache)} jetons · ${duree(p.duree_s)} de calcul`).join("\n")}`))
    blocs.push(section(`*Par modèle, ce mois-ci*\n${Object.values(parModele).sort((a, c) => c.api - a.api || c.jetons - a.jetons).slice(0, 8).map((m) => `• \`${m.modele}\` : ${montant(config, m.api)} · ${jetons(m.jetons)} jetons · ${m.appels} appels`).join("\n")}`))
    if (b.projets.some((p) => p.api_inconnu)) blocs.push(contexte("* une partie des jetons n'a pas de prix connu (Codex) : ajoute son prix dans les réglages pour l'inclure."))
  } else {
    blocs.push(contexte("Aucune consommation mesurée ce mois-ci. Le suivi a commencé le 3 octobre 2026 : les projets plus anciens ne sont pas mesurés."))
  }
  blocs.push({
    type: "actions",
    elements: [
      { type: "button", text: { type: "plain_text", text: "Tableau de bord complet" }, url: adresseTableau(config), action_id: "lien_tableau" },
      { type: "button", text: { type: "plain_text", text: "Réglages des coûts" }, action_id: "couts_reglages", value: "1" },
    ],
  })
  return blocs
}

// Le détail d'un projet : ce qu'il a coûté, en argent et en temps.
export function blocsCoutProjet(ctx, projetId) {
  const { db } = ctx
  const config = reglagesCouts(db, ctx.config)
  const projet = obtenir(db, "projets", projetId)
  if (!projet) return [section(`Pas de projet ${projetId}.`)]
  const c = bilanProjet(db, config, projetId)
  const b = budgetProjet(db, config, projet)
  if (!c.mesure) return [section(`*${projet.nom ?? projet.prompt.slice(0, 50)}* : aucune consommation mesurée (projet antérieur au suivi des coûts, ou pas encore commencé).`)]
  const fusionnees = c.taches.fusionnee ?? 0
  const total = Object.values(c.taches).reduce((s, n) => s + n, 0)
  return [
    section(`*${projet.nom}* : *${montant(config, c.api)}*${c.api_inconnu ? "*" : ""} en équivalent API · *${montant(config, c.reel)}* en coût réel${b > 0 ? `\nBudget : ${barre(c.api / b)} ${Math.round((c.api / b) * 100)} % de ${montant(config, b)}` : ""}`),
    section(`*Modèles*\n${c.parModele.map((m) => `• \`${m.modele}\` : ${montant(config, m.api)} · ${jetons(m.jetons)} jetons · ${m.appels} appels · ${duree(m.duree_s)}`).join("\n")}`),
    section(`*Par rôle*\n${c.parRole.map((r) => `• ${r.role} : ${montant(config, r.api)} · ${r.appels} appels · ${duree(r.duree_s)}`).join("\n")}`),
    section(`*Temps et qualité*\n${duree(c.calcul_s)} de calcul · ${fusionnees}/${total} tâches fusionnées · ${c.refus} refus corrigés · ${c.corrections} lot(s) de corrections · ${c.escalades} escalade(s) · ${c.decisions} décision(s) humaine(s)`),
    ...(c.api_inconnu ? [contexte("* une partie des jetons n'a pas de prix connu (Codex).")] : []),
  ]
}

// Le résumé du coût d'un projet, en une ligne (rapport final).
export function ligneCoutProjet(ctx, projetId) {
  const config = reglagesCouts(ctx.db, ctx.config)
  const c = bilanProjet(ctx.db, config, projetId)
  if (!c.mesure) return null
  const modeles = c.parModele.slice(0, 3).map((m) => m.modele).join(", ")
  return `Coût : ${montant(config, c.api)} en équivalent API · ${montant(config, c.reel)} en coût réel · ${duree(c.calcul_s)} de calcul · ${modeles}`
}

// La fenêtre « Réglages des coûts » (montants dans la devise d'affichage).
export function vueReglagesCouts(ctx) {
  const config = reglagesCouts(ctx.db, ctx.config)
  const abo = (moteur) => (config.couts?.abonnements ?? []).find((a) => (a.moteurs ?? []).includes(moteur))?.mensuel ?? 0
  const nombre = (bloc, label, valeur, aide) => ({
    type: "input", block_id: bloc, optional: true, label: { type: "plain_text", text: label }, ...(aide ? { hint: { type: "plain_text", text: aide } } : {}),
    element: { type: "number_input", action_id: "v", is_decimal_allowed: true, min_value: "0", ...(valeur !== undefined && valeur !== null ? { initial_value: String(valeur) } : {}) },
  })
  const d = config.couts?.devise ?? "EUR"
  return {
    type: "modal", callback_id: "modal_couts",
    title: { type: "plain_text", text: "Réglages des coûts" }, submit: { type: "plain_text", text: "Enregistrer" }, close: { type: "plain_text", text: "Annuler" },
    blocks: [
      { type: "input", block_id: "devise", label: { type: "plain_text", text: "Devise d'affichage" }, element: { type: "static_select", action_id: "v", initial_option: { value: d, text: { type: "plain_text", text: d } }, options: ["EUR", "USD"].map((x) => ({ value: x, text: { type: "plain_text", text: x } })) } },
      nombre("taux", "Taux : 1 $ en euros", config.couts?.taux_usd ?? 0.86, "Pour convertir les équivalents API, donnés en dollars."),
      { type: "header", text: { type: "plain_text", text: "Frais fixes mensuels" } },
      nombre("abo_claude", "Abonnement Claude (analyste, agents)", abo("claude-code")),
      nombre("abo_codex", "Abonnement ChatGPT (vérificateur Codex)", abo("codex")),
      nombre("serveur", "Serveur (VPS)", config.couts?.serveur_mensuel ?? 0),
      { type: "header", text: { type: "plain_text", text: "Budgets (équivalent API)" } },
      nombre("budget_mensuel", "Budget mensuel de l'usine", config.budget?.mensuel ?? 0, "0 = pas de budget. À 100 %, plus aucune tâche ne démarre sans ton accord."),
      nombre("budget_projet", "Budget par projet", config.budget?.par_projet ?? 0, "0 = pas de budget. À 100 %, escalade : Continuer (+50 %) ou Arrêter."),
      nombre("prix_codex", "Prix de Codex en $ / million de jetons (sortie)", config.couts?.prix_api?.codex_sortie ?? null, "Facultatif : pour inclure le vérificateur dans l'équivalent API."),
    ],
  }
}

// Lit la fenêtre et renvoie les réglages à enregistrer (clé « couts »).
export function lireReglagesCouts(ctx, view) {
  const v = view.state.values
  const n = (bloc) => {
    const x = v[bloc]?.v?.value
    return x === null || x === undefined || x === "" ? null : Number(x)
  }
  let anciens = {}
  try {
    anciens = JSON.parse(lireReglage(ctx.db, "couts", "{}"))
  } catch {}
  const prixApi = { ...(ctx.config.couts?.prix_api ?? {}), ...(anciens.couts?.prix_api ?? {}) }
  const pc = n("prix_codex")
  if (pc !== null) {
    // Un seul prix saisi (la sortie) ; l'entrée est estimée au quart, comme chez la plupart des fournisseurs.
    prixApi.codex_sortie = pc
    prixApi[lireReglage(ctx.db, "modele_codex", "codex")] = { entree: pc / 4, sortie: pc }
  }
  return {
    couts: {
      devise: v.devise.v.selected_option.value,
      taux_usd: n("taux") ?? 0.86,
      abonnements: [
        { nom: "Claude", mensuel: n("abo_claude") ?? 0, moteurs: ["claude-code"] },
        { nom: "ChatGPT (Codex)", mensuel: n("abo_codex") ?? 0, moteurs: ["codex"] },
      ],
      serveur_mensuel: n("serveur") ?? 0,
      prix_api: prixApi,
    },
    budget: { mensuel: n("budget_mensuel") ?? 0, par_projet: n("budget_projet") ?? 0 },
  }
}
