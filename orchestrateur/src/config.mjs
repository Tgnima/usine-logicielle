// Le contrat (usine.config.yml) et les secrets (variables d'environnement).
import { readFileSync } from "node:fs"
import YAML from "yaml"

export function chargerConfig() {
  const fichier = process.env.USINE_CONFIG ?? "/app/usine.config.yml"
  const c = YAML.parse(readFileSync(fichier, "utf8"))
  const env = process.env
  for (const nom of ["GITHUB_TOKEN", "WORKER_TOKEN"]) if (!env[nom]) throw new Error(`Variable ${nom} manquante (voir .env.example).`)
  if (!c.github?.proprietaire) throw new Error("github.proprietaire manquant dans usine.config.yml.")
  return {
    ...c,
    secrets: { github: env.GITHUB_TOKEN, worker: env.WORKER_TOKEN, slackBot: env.SLACK_BOT_TOKEN ?? "", slackApp: env.SLACK_APP_TOKEN ?? "" },
    slack: { canal: env.SLACK_CANAL ?? c.slack?.canal ?? "", admins: (env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean) },
    dataDir: env.DATA_DIR ?? "/app/data",
    etatDir: env.ETAT_DIR ?? "/app/etat",
    atelier: { id: "atelier-1", url: env.ATELIER_URL ?? "http://atelier-1:8080" },
    verificateur: { url: env.VERIFICATEUR_URL ?? "http://verificateur:8080" },
  }
}

// Les adresses publiques d'un produit.
export const adresses = (config, slug) => {
  const proto = config.domaine.https ? "https" : "http"
  return {
    apercu: `${proto}://${slug}.apercu.${config.domaine.base}`,
    production: `${proto}://${slug}.${config.domaine.base}`,
    mails: `${proto}://mails.apercu.${config.domaine.base}`,
  }
}
