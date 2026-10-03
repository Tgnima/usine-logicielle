// La surveillance des budgets (équivalent API). Appelée par la fabrique avant
// chaque tâche : alertes Slack aux seuils, puis à 100 % une décision humaine.
//   - budget d'un projet : escalade « cout » (Continuer +50 % / Arrêter), le projet attend ;
//   - budget mensuel de l'usine : plus aucune tâche ne démarre ce mois-ci tant
//     qu'un administrateur n'a pas relevé le budget (boutons dans Slack).
import { noter } from "./db.mjs"
import { escalader } from "./escalade.mjs"
import { bilanMois, bilanProjet, budgetMensuel, budgetProjet, ecrireReglage, lireReglage, mois, montant, reglagesCouts, seuilAtteint } from "./couts.mjs"

// Une alerte n'est envoyée qu'une fois par clé (seuil, mois ou projet, montant du budget).
function premiereFois(db, cle) {
  return db.prepare("INSERT OR IGNORE INTO alertes_budget (cle) VALUES (?)").run(cle).changes === 1
}

// Renvoie true si le budget mensuel est épuisé : la fabrique ne démarre plus rien.
export async function verifierBudgets(ctx) {
  const { db } = ctx
  const config = reglagesCouts(db, ctx.config)
  const m = mois()

  // 1. Le budget mensuel de l'usine.
  const budget = budgetMensuel(db, config, m)
  const depense = budget > 0 ? bilanMois(db, config, m).api : 0
  const seuil = seuilAtteint(config, depense, budget)
  if (seuil && premiereFois(db, `mois:${m}:${budget}:${seuil}`)) {
    const texte = `${seuil >= 100 ? ":rotating_light:" : ":warning:"} *Budget mensuel de l'usine : ${seuil} % atteint* (${montant(config, depense)} sur ${montant(config, budget)} en équivalent API).`
    if (seuil >= 100) {
      await ctx.notifier.alerte(`${texte}\nPlus aucune tâche ne démarre ce mois-ci tant que le budget n'est pas relevé. La tâche en cours se termine.`, [
        { texte: "Relever de 50 %", action: "budget_mensuel_relever", valeur: m, style: "primary" },
        { texte: "Garder l'arrêt", action: "budget_mensuel_garder", valeur: m },
      ])
    } else {
      await ctx.notifier.alerte(texte)
    }
  }
  const bloque = budget > 0 && depense >= budget

  // 2. Le budget de chaque projet en fabrication.
  for (const projet of db.prepare("SELECT * FROM projets WHERE statut = 'fabrication'").all()) {
    const b = budgetProjet(db, config, projet)
    if (!(b > 0)) continue
    const d = bilanProjet(db, config, projet.id).api
    const s = seuilAtteint(config, d, b)
    if (!s || !premiereFois(db, `projet:${projet.id}:${b}:${s}`)) continue
    if (s >= 100) {
      noter(db, { projet: projet.id, type: "budget", message: `Budget du projet atteint : ${montant(config, d)} sur ${montant(config, b)}` })
      await escalader(ctx, { projetId: projet.id, raison: "cout", details: `Équivalent API dépensé : ${montant(config, d)}, budget du projet : ${montant(config, b)}.` })
    } else {
      await ctx.notifier.etape(projet, `:warning: Budget du projet : *${s} %* atteint (${montant(config, d)} sur ${montant(config, b)} en équivalent API).`)
    }
  }
  return bloque
}

// Relever le budget mensuel de 50 % (bouton Slack ou CLI).
export function releverBudgetMensuel(ctx, m = mois(), par = "?") {
  const config = reglagesCouts(ctx.db, ctx.config)
  const base = Number(config.budget?.mensuel ?? 0)
  const actuel = Number(lireReglage(ctx.db, `supplement_mensuel_${m}`, 0))
  ecrireReglage(ctx.db, `supplement_mensuel_${m}`, actuel + base * 0.5)
  return { ok: true, message: `Budget de ${m} relevé à ${montant(config, budgetMensuel(ctx.db, config, m))} par ${par}.` }
}
