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
  // GitHub peut se connecter plus tard, depuis la console (application GitHub de l'usine).
  if (!secret("worker_token")) throw new Error("Secret worker_token manquant (bash secrets.sh verifier).")
  // Le compte GitHub des produits : celui de l'application connectée dans la console, sinon le contrat.
  c.github = { depot_etat: "usine-etat", ...(c.github ?? {}) }
  if (!c.github.proprietaire) console.log("GitHub pas encore connecté : à faire dans la console (Premiers pas).")
  return {
    ...c,
    secrets: { github: secret("github_token"), worker: secret("worker_token"), coffreMaitre: secret("coffre_maitre"), slackBot: secret("slack_bot_token"), slackApp: secret("slack_app_token") },
    slack: { canal: env.SLACK_CANAL ?? c.slack?.canal ?? "", admins: (env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean) },
    dataDir: env.DATA_DIR ?? "/app/data",
    etatDir: env.ETAT_DIR ?? "/app/etat",
    // Chaque serveur de travaux a son propre jeton : un agent de l'atelier (qui peut lire le sien)
    // ne peut pas commander le vérificateur, qui le juge. worker_token reste dans l'orchestrateur.
    atelier: { id: "atelier-1", url: env.ATELIER_URL ?? "http://atelier-1:8080", jeton: secret("atelier_token") || secret("worker_token") },
    verificateur: { url: env.VERIFICATEUR_URL ?? "http://verificateur:8080", jeton: secret("verificateur_token") || secret("worker_token") },
  }
}

// Qui administre l'usine depuis Slack. Une liste vide ne donne les droits à personne (et non
// à tout l'espace de travail) ; « * » les donne à tous, seulement si on l'écrit exprès.
export const estAdminSlack = (admins, user) => admins.includes("*") || (Boolean(user) && admins.includes(user))

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
