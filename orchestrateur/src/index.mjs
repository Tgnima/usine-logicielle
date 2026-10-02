// L'orchestrateur : il tient l'état, applique le contrat, parle à GitHub et à
// Slack. Il ne touche jamais Docker (c'est le déployeur) et ne code jamais
// (ce sont les agents de l'atelier).
import { createServer } from "node:http"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { chargerConfig } from "./config.mjs"
import { ouvrirDb, plan as lirePlan, obtenir } from "./db.mjs"
import { sante } from "./travaux.mjs"
import { preparerDepotEtat } from "./github.mjs"
import { demarrerFabrique } from "./fabrique.mjs"
import { resoudre, surveillerEscalades } from "./escalade.mjs"
import * as livraison from "./livraison.mjs"
import * as actions from "./pipeline.mjs"
import { demarrerSlack, notificateurConsole } from "./slack.mjs"
import { planEnMarkdown } from "./analyste.mjs"

const config = chargerConfig()
mkdirSync(config.dataDir, { recursive: true })
const db = ouvrirDb(join(config.dataDir, "usine.db"))
const ctx = { config, db, notifier: notificateurConsole(), livraison }

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
  "POST /production": (c, id) => livraison.mettreEnProduction(ctx, id, c.par ?? "cli"),
  "POST /relancer": (_c, id) => (actions.lancerAnalyse(ctx, id), { ok: true }),
  "POST /stop": (c) => actions.arreter(ctx, c.par ?? "cli"),
  "POST /reprendre": () => actions.reprendre(ctx),
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
