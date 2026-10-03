// Le contrat (usine.config.yml) et les secrets.
// Les secrets arrivent en fichiers (/run/secrets/<nom>, déchiffrés par secrets.sh) ;
// à défaut (tests, développement), par variables d'environnement.
import { readFileSync } from "node:fs"
import YAML from "yaml"

export function secret(nom) {
  try {
    return readFileSync(`/run/secrets/${nom}`, "utf8").trim()
  } catch {
    return process.env[nom.toUpperCase()] ?? ""
  }
}

export function chargerConfig() {
  const fichier = process.env.USINE_CONFIG ?? "/app/usine.config.yml"
  const c = YAML.parse(readFileSync(fichier, "utf8"))
  const env = process.env
  for (const nom of ["github_token", "worker_token"]) if (!secret(nom)) throw new Error(`Secret ${nom} manquant (bash secrets.sh verifier).`)
  if (!c.github?.proprietaire) throw new Error("github.proprietaire manquant dans usine.config.yml.")
  return {
    ...c,
    secrets: { github: secret("github_token"), worker: secret("worker_token"), slackBot: secret("slack_bot_token"), slackApp: secret("slack_app_token") },
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

export const adressePortail = (config) => `${config.domaine.https ? "https" : "http"}://connexion.${config.domaine.base}`
