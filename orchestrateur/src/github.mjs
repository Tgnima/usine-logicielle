// GitHub : dépôts des produits, issues, pull requests, et le dépôt d'état que
// le déployeur tire. Toutes les écritures passent par ici, avec le jeton de
// l'orchestrateur ; les agents ne voient jamais ce jeton.
const API = "https://api.github.com"
export const MARQUE = "<!-- usine-logicielle -->" // signe les commentaires de l'usine

// Les coupures réseau brèves (DNS, 5xx) sont réessayées : elles ne doivent pas
// faire escalader une tâche.
async function gh(config, chemin, { method = "GET", corps, accepter = [] } = {}) {
  let res
  for (let essai = 1; ; essai++) {
    try {
      res = await fetch(`${API}${chemin}`, {
        method,
        headers: { authorization: `Bearer ${config.secrets.github}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
        body: corps ? JSON.stringify(corps) : undefined,
        signal: AbortSignal.timeout(30_000),
      })
      if (res.status < 500 || essai >= 5) break
    } catch (error) {
      if (essai >= 5) throw new Error(`GitHub injoignable (${method} ${chemin}) : ${error.cause?.code ?? error.message}`)
    }
    await new Promise((r) => setTimeout(r, 5_000 * essai))
  }
  const json = res.status === 204 ? {} : await res.json().catch(() => ({}))
  if (!res.ok && !accepter.includes(res.status)) throw Object.assign(new Error(`GitHub ${res.status} ${method} ${chemin} : ${json.message ?? ""}`), { statut: res.status })
  return { statut: res.status, json }
}

const depot = (config, nom) => `/repos/${config.github.proprietaire}/${nom}`

export async function creerDepot(config, nom, description) {
  const existe = await gh(config, depot(config, nom), { accepter: [404] })
  if (existe.statut === 200) return existe.json
  const moi = (await gh(config, "/user")).json.login
  const chemin = moi === config.github.proprietaire ? "/user/repos" : `/orgs/${config.github.proprietaire}/repos`
  return (await gh(config, chemin, { method: "POST", corps: { name: nom, description, private: config.github.visibilite !== "public", auto_init: false, has_wiki: false } })).json
}

export async function creerEtiquettes(config, nom, etiquettes) {
  for (const [name, color, description] of etiquettes) {
    await gh(config, `${depot(config, nom)}/labels`, { method: "POST", corps: { name, color, description }, accepter: [422] })
  }
}

export const creerIssue = async (config, nom, { titre, corps, etiquettes = [], assigne = true }) =>
  (await gh(config, `${depot(config, nom)}/issues`, { method: "POST", corps: { title: titre, body: corps, labels: etiquettes, assignees: assigne ? [config.github.proprietaire] : [] } })).json

export const commenter = (config, nom, numero, texte) => gh(config, `${depot(config, nom)}/issues/${numero}/comments`, { method: "POST", corps: { body: `${texte}\n\n${MARQUE}` } })
export const lireIssue = async (config, nom, numero) => (await gh(config, `${depot(config, nom)}/issues/${numero}`)).json
export const commentaires = async (config, nom, numero) => (await gh(config, `${depot(config, nom)}/issues/${numero}/comments?per_page=100`)).json
export const ajouterEtiquettes = (config, nom, numero, etiquettes) => gh(config, `${depot(config, nom)}/issues/${numero}/labels`, { method: "POST", corps: { labels: etiquettes } })
export const retirerEtiquette = (config, nom, numero, etiquette) => gh(config, `${depot(config, nom)}/issues/${numero}/labels/${encodeURIComponent(etiquette)}`, { method: "DELETE", accepter: [404] })
export const fermerIssue = (config, nom, numero) => gh(config, `${depot(config, nom)}/issues/${numero}`, { method: "PATCH", corps: { state: "closed" } })

export async function ouvrirPR(config, nom, { titre, corps, branche }) {
  const ouvertes = (await gh(config, `${depot(config, nom)}/pulls?head=${config.github.proprietaire}:${branche}&state=open`)).json
  if (ouvertes.length) {
    await gh(config, `${depot(config, nom)}/pulls/${ouvertes[0].number}`, { method: "PATCH", corps: { title: titre, body: corps } })
    return ouvertes[0]
  }
  return (await gh(config, `${depot(config, nom)}/pulls`, { method: "POST", corps: { title: titre, body: corps, head: branche, base: "main" } })).json
}

export const lirePR = async (config, nom, numero) => (await gh(config, `${depot(config, nom)}/pulls/${numero}`)).json

// La fusion est une décision du CODE de l'orchestrateur, jamais d'un modèle.
// sha : la fusion échoue si la branche a bougé depuis la vérification.
export const fusionnerPR = async (config, nom, numero, { titre, sha }) =>
  (await gh(config, `${depot(config, nom)}/pulls/${numero}/merge`, { method: "PUT", corps: { merge_method: "squash", commit_title: titre, sha } })).json

export const commentairePR = (config, nom, numero, texte) => commenter(config, nom, numero, texte)

// Écrit un fichier sur main d'un dépôt de produit (le plan, quand un lot s'ajoute).
export async function ecrireFichierDepot(config, nom, chemin, contenu, message) {
  const actuel = await gh(config, `${depot(config, nom)}/contents/${chemin}?ref=main`, { accepter: [404] })
  await gh(config, `${depot(config, nom)}/contents/${chemin}`, { method: "PUT", corps: { message, content: Buffer.from(contenu).toString("base64"), ...(actuel.statut === 200 ? { sha: actuel.json.sha } : {}) } })
}
export const shaPrincipal = async (config, nom) => (await gh(config, `${depot(config, nom)}/git/ref/heads/main`)).json.object.sha

// --- Le dépôt d'état (lu par le déployeur) ------------------------------------

export async function preparerDepotEtat(config) {
  const nom = config.github.depot_etat
  const existe = await gh(config, depot(config, nom), { accepter: [404] })
  if (existe.statut === 200) return
  const moi = (await gh(config, "/user")).json.login
  const chemin = moi === config.github.proprietaire ? "/user/repos" : `/orgs/${config.github.proprietaire}/repos`
  await gh(config, chemin, { method: "POST", corps: { name: nom, description: "État souhaité des produits de l'usine logicielle (lu par le déployeur)", private: true, auto_init: true } })
}

async function lireEtat(config, chemin, branche = "main") {
  const r = await gh(config, `${depot(config, config.github.depot_etat)}/contents/${chemin}?ref=${branche}`, { accepter: [404] })
  return r.statut === 200 ? r.json : null
}

// Retire un état souhaité : le déployeur, au tour suivant, retire ce qui y correspondait.
export async function supprimerEtat(config, chemin, message) {
  const actuel = await lireEtat(config, chemin)
  if (!actuel) return false
  await gh(config, `${depot(config, config.github.depot_etat)}/contents/${chemin}`, { method: "DELETE", corps: { message, sha: actuel.sha } })
  return true
}

// Écrit un état souhaité. Direct sur main pour un aperçu ; par pull request
// (aussitôt fusionnée, puisqu'un humain vient de valider) pour la production :
// chaque mise en production laisse ainsi une trace relisible.
export async function ecrireEtat(config, chemin, objet, { message, viaPR = false } = {}) {
  const nom = config.github.depot_etat
  const contenu = Buffer.from(`${JSON.stringify(objet, null, 2)}\n`).toString("base64")
  if (!viaPR) {
    const actuel = await lireEtat(config, chemin)
    await gh(config, `${depot(config, nom)}/contents/${chemin}`, { method: "PUT", corps: { message, content: contenu, ...(actuel ? { sha: actuel.sha } : {}) } })
    return null
  }
  const base = (await gh(config, `${depot(config, nom)}/git/ref/heads/main`)).json.object.sha
  const branche = `mise-en-production/${chemin.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`
  await gh(config, `${depot(config, nom)}/git/refs`, { method: "POST", corps: { ref: `refs/heads/${branche}`, sha: base } })
  const actuel = await lireEtat(config, chemin, branche)
  await gh(config, `${depot(config, nom)}/contents/${chemin}`, { method: "PUT", corps: { message, content: contenu, branch: branche, ...(actuel ? { sha: actuel.sha } : {}) } })
  const pr = (await gh(config, `${depot(config, nom)}/pulls`, { method: "POST", corps: { title: message, head: branche, base: "main", body: `${objet.valide_par ? `Validé par ${objet.valide_par}.` : ""}\n\n${MARQUE}` } })).json
  await gh(config, `${depot(config, nom)}/pulls/${pr.number}/merge`, { method: "PUT", corps: { merge_method: "squash" } })
  await gh(config, `${depot(config, nom)}/git/refs/heads/${branche}`, { method: "DELETE", accepter: [422] })
  return pr.number
}
