// L'orchestrateur : il tient l'état, applique le contrat, parle à GitHub et à
// Slack. Il ne touche jamais Docker (c'est le déployeur) et ne code jamais
// (ce sont les agents de l'atelier).
import { createServer } from "node:http"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { chargerConfig } from "./config.mjs"
import { ouvrirDb, plan as lirePlan, obtenir } from "./db.mjs"
import { brancherEnvCommun, sante } from "./travaux.mjs"
import { appliquerModeles, envFournisseurs, migrerCoffre, protegeParAxmaril } from "./fournisseurs.mjs"
import { brancherForge } from "./forge-github.mjs"
import { preparerDepotEtat } from "./github.mjs"
import { demarrerFabrique } from "./fabrique.mjs"
import { resoudre, surveillerEscalades } from "./escalade.mjs"
import * as livraison from "./livraison.mjs"
import * as actions from "./pipeline.mjs"
import { demarrerSlack, notificateurConsole } from "./slack.mjs"
import { planEnMarkdown } from "./analyste.mjs"
import { ouvrirCouts } from "./couts.mjs"
import { demarrerConsole } from "./console.mjs"
import { demarrerSynchronisationPortier, portier } from "./portier.mjs"
import { demarrerCycle, mettreAJourUsine, ouvrirCycle } from "./cycle.mjs"
import { surveillerSante } from "./sante.mjs"
import { demarrerDomaines, ouvrirDomaines } from "./domaines.mjs"

const config = chargerConfig()
mkdirSync(config.dataDir, { recursive: true })
const db = ouvrirDb(join(config.dataDir, "usine.db"))
ouvrirCouts(db)
ouvrirCycle(db)
ouvrirDomaines(db)
const ctx = { config, db, notifier: notificateurConsole(), livraison }
// Les fournisseurs d'IA réglés dans la console : modèles, et identifiants passés aux travaux.
appliquerModeles(ctx)
console.log(protegeParAxmaril(ctx) ? "Coffre : protégé par la clé maîtresse d'AXMARIL." : "Coffre : clé du serveur (AXMARIL non branché).")
migrerCoffre(ctx)
// GitHub : l'application de l'usine, si elle est connectée (sinon le jeton du serveur).
await brancherForge(ctx).catch((e) => console.error("GitHub (application) :", e.message))
brancherEnvCommun((serveur) => envFournisseurs(ctx, serveur === config.verificateur.url ? "codex" : "claude-code"))

await preparerDepotEtat(config).catch((e) => console.error("Dépôt d'état :", e.message))
if (config.secrets.slackBot && config.secrets.slackApp) {
  await demarrerSlack(ctx).catch((e) => console.error("Slack indisponible, mode console :", e.message))
} else {
  console.log("Pas de jetons Slack : mode console (node src/cli.mjs).")
}

for (const [nom, url] of [["atelier", config.atelier.url], ["vérificateur", config.verificateur.url]]) {
  const s = await sante(url)
  console.log(`${nom} : ${s ? `prêt (${JSON.stringify(s)})` : "injoignable pour l'instant"}`)
}

actions.reprise(ctx)
demarrerFabrique(ctx)
surveillerEscalades(ctx)
demarrerConsole(ctx)
demarrerSynchronisationPortier(ctx)
demarrerCycle(ctx)
demarrerDomaines(ctx)
surveillerSante(ctx)

// L'API locale, pour la CLI (docker compose exec orchestrateur node src/cli.mjs …).
// Elle n'écoute que dans le conteneur.
const routes = {
  "POST /projets": (c) => actions.nouveauProjet(ctx, { prompt: c.prompt, demandeur: c.par ?? "cli" }).then((id) => ({ ok: true, id })),
  "GET /statut": () => actions.statut(ctx),
  "GET /plan": (_c, id) => {
    const p = obtenir(db, "projets", id)
    const plan = p && lirePlan(p)
    return plan?.lots?.length ? { texte: planEnMarkdown(plan) } : { texte: JSON.stringify(plan, null, 2) }
  },
  "POST /repondre": (c, id) => actions.repondreQuestions(ctx, id, c.texte, c.par ?? "cli"),
  "POST /valider": (c, id) => actions.validerPlan(ctx, id, c.par ?? "cli"),
  "POST /corriger": (c, id) => {
    const p = obtenir(db, "projets", id)
    return ["livre", "en_production"].includes(p?.statut) ? livraison.demanderCorrections(ctx, id, c.texte, c.par ?? "cli") : actions.corrigerPlan(ctx, id, c.texte, c.par ?? "cli")
  },
  "POST /decider": (c, id) => resoudre(ctx, id, { choix: c.choix, texte: c.texte ?? "", par: c.par ?? "cli" }),
  "POST /production": (c, id) => livraison.mettreEnProduction(ctx, id, c.par ?? "cli", c.choix ?? null),
  "POST /relancer": (c, id) => actions.relancerProjet(ctx, id, c.par ?? "cli"),
  "POST /abandonner": (c, id) => actions.abandonnerPlan(ctx, id, c.par ?? "cli"),
  "POST /mettre-a-jour": (c) => mettreAJourUsine(ctx, c.par ?? "cli"),
  "POST /stop": (c) => actions.arreter(ctx, c.par ?? "cli"),
  "POST /reprendre": () => actions.reprendre(ctx),
  // Le premier administrateur, sans Slack (install.sh) : le lien d'invitation, ou un nouveau lien s'il existe déjà.
  "POST /admin": async (c) => {
    const { adresseTableau } = await import("./slack-couts.mjs")
    const email = String(c.email ?? "").trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("adresse email invalide")
    const existant = (await portier("utilisateurs")).find((u) => u.email === email)
    const { lien } = existant
      ? await portier(`utilisateurs/${existant.id}/invitation`, { methode: "POST" })
      : await portier("utilisateurs", { methode: "POST", corps: { email, nom: null, role: "admin", applis: [], par: "installation" } })
    return { ok: true, console: adresseTableau(config), lien, existant: !!existant }
  },
  "GET /journal": (_c, id) => db.prepare("SELECT le, type, message FROM journal WHERE projet_id = ? ORDER BY id DESC LIMIT 60").all(id).reverse(),
}

createServer(async (req, res) => {
  const [chemin, id] = req.url.split("?")[0].split("/").filter(Boolean)
  const route = routes[`${req.method} /${chemin}`]
  const envoyer = (code, corps) => {
    res.writeHead(code, { "content-type": "application/json" })
    res.end(JSON.stringify(corps))
  }
  if (!route) return envoyer(404, { erreur: "route inconnue" })
  let corps = ""
  for await (const morceau of req) corps += morceau
  try {
    envoyer(200, (await route(corps ? JSON.parse(corps) : {}, Number(id))) ?? { ok: true })
  } catch (error) {
    envoyer(500, { erreur: error.message })
  }
}).listen(8090, "127.0.0.1", () => console.log("Orchestrateur prêt. API locale sur 127.0.0.1:8090."))

process.on("unhandledRejection", (e) => console.error("Erreur non gérée :", e))
