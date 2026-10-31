// GitHub : dépôts des produits, issues, pull requests, et le dépôt d'état que
// le déployeur tire. Toutes les écritures passent par ici, avec le jeton de
// l'orchestrateur ; les agents ne voient jamais ce jeton.
const API = "https://api.github.com"
export const MARQUE = "<!-- usine-logicielle -->" // signe les commentaires de l'usine

// Les coupures réseau brèves (DNS, 5xx) sont réessayées : elles ne doivent pas
// faire escalader une tâche.
async function gh(config, chemin, { method = "GET", corps, accepter = [], jeton = null } = {}) {
  let res
  for (let essai = 1; ; essai++) {
    try {
      res = await fetch(`${API}${chemin}`, {
        method,
        headers: { authorization: `Bearer ${jeton ?? config.secrets.github}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json" },
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
  if (!res.ok && !accepter.includes(res.status)) {
    // Le détail de GitHub (« description cannot be more than 350 characters »…) : sans lui,
    // un 422 ne dit que « Repository creation failed ».
    const details = (json.errors ?? []).map((e) => (typeof e === "string" ? e : e.message ?? [e.field, e.code].filter(Boolean).join(" "))).filter(Boolean)
    throw Object.assign(new Error(`GitHub ${res.status} ${method} ${chemin} : ${json.message ?? ""}${details.length ? ` (${details.join(" ; ")})` : ""}`), { statut: res.status })
  }
  return { statut: res.status, json }
}

// Un dépôt : son nom seul (un dépôt de l'usine, chez github.proprietaire) ou « propriétaire/nom »
// (un dépôt repris, qui peut appartenir à quelqu'un d'autre).
const complet = (config, nom) => (String(nom).includes("/") ? String(nom) : `${config.github.proprietaire}/${nom}`)
const depot = (config, nom) => `/repos/${complet(config, nom)}`

// Où créer un dépôt, et avec quel jeton. Avec l'application GitHub de l'usine (forge-github.mjs),
// le type du compte est connu ; sur un compte personnel, GitHub exige le jeton de l'utilisateur.
async function cibleCreation(config) {
  const type = config.github.type_proprietaire
  if (type === "Organization") return { chemin: `/orgs/${config.github.proprietaire}/repos`, jeton: null }
  if (type === "User") {
    const jeton = (await config.jetonCreation?.()) ?? null
    if (!jeton) throw new Error("GitHub : l'autorisation de créer des dépôts a expiré. Dans la console, Réglages, reconnecte GitHub.")
    return { chemin: "/user/repos", jeton }
  }
  const moi = (await gh(config, "/user")).json.login
  return { chemin: moi === config.github.proprietaire ? "/user/repos" : `/orgs/${config.github.proprietaire}/repos`, jeton: null }
}

export async function creerDepot(config, nom, description) {
  const existe = await gh(config, depot(config, nom), { accepter: [404] })
  if (existe.statut === 200) return existe.json
  const { chemin, jeton } = await cibleCreation(config)
  return (await gh(config, chemin, { method: "POST", jeton, corps: { name: nom, description: descriptionDepot(description), private: config.github.visibilite !== "public", auto_init: false, has_wiki: false } })).json
}

// GitHub refuse une description de plus de 350 caractères (le résumé d'un plan peut dépasser) :
// coupée au dernier mot entier, sur une ligne.
export function descriptionDepot(texte, max = 350) {
  const t = String(texte ?? "").replace(/\s+/g, " ").trim()
  if (t.length <= max) return t
  const coupe = t.slice(0, max - 1)
  return `${coupe.slice(0, coupe.lastIndexOf(" ") > max / 2 ? coupe.lastIndexOf(" ") : coupe.length).replace(/[\s,;:.]+$/, "")}…`
}

export async function creerEtiquettes(config, nom, etiquettes) {
  for (const [name, color, description] of etiquettes) {
    await gh(config, `${depot(config, nom)}/labels`, { method: "POST", corps: { name, color, description }, accepter: [422] })
  }
}

export const creerIssue = async (config, nom, { titre, corps, etiquettes = [], assigne = true }) =>
  (await gh(config, `${depot(config, nom)}/issues`, { method: "POST", corps: { title: titre, body: corps, labels: etiquettes, assignees: assigne && complet(config, nom).split("/")[0] === config.github.proprietaire ? [config.github.proprietaire] : [] } })).json

export const commenter = (config, nom, numero, texte) => gh(config, `${depot(config, nom)}/issues/${numero}/comments`, { method: "POST", corps: { body: `${texte}\n\n${MARQUE}` } })
export const lireIssue = async (config, nom, numero) => (await gh(config, `${depot(config, nom)}/issues/${numero}`)).json
export const commentaires = async (config, nom, numero) => (await gh(config, `${depot(config, nom)}/issues/${numero}/comments?per_page=100`)).json
export const ajouterEtiquettes = (config, nom, numero, etiquettes) => gh(config, `${depot(config, nom)}/issues/${numero}/labels`, { method: "POST", corps: { labels: etiquettes } })
export const retirerEtiquette = (config, nom, numero, etiquette) => gh(config, `${depot(config, nom)}/issues/${numero}/labels/${encodeURIComponent(etiquette)}`, { method: "DELETE", accepter: [404] })
export const fermerIssue = (config, nom, numero) => gh(config, `${depot(config, nom)}/issues/${numero}`, { method: "PATCH", corps: { state: "closed" } })

export async function ouvrirPR(config, nom, { titre, corps, branche, base = "main" }) {
  const proprietaire = complet(config, nom).split("/")[0]
  const ouvertes = (await gh(config, `${depot(config, nom)}/pulls?head=${proprietaire}:${encodeURIComponent(branche)}&base=${encodeURIComponent(base)}&state=open`)).json
  if (ouvertes.length) {
    await gh(config, `${depot(config, nom)}/pulls/${ouvertes[0].number}`, { method: "PATCH", corps: { title: titre, body: corps } })
    return ouvertes[0]
  }
  return (await gh(config, `${depot(config, nom)}/pulls`, { method: "POST", corps: { title: titre, body: corps, head: branche, base } })).json
}

export const lirePR = async (config, nom, numero) => (await gh(config, `${depot(config, nom)}/pulls/${numero}`)).json

// La fusion est une décision du CODE de l'orchestrateur, jamais d'un modèle.
// sha : la fusion échoue si la branche a bougé depuis la vérification.
export const fusionnerPR = async (config, nom, numero, { titre, sha }) =>
  (await gh(config, `${depot(config, nom)}/pulls/${numero}/merge`, { method: "PUT", corps: { merge_method: "squash", commit_title: titre, sha } })).json

export const commentairePR = (config, nom, numero, texte) => commenter(config, nom, numero, texte)

// Écrit un fichier sur la branche de base d'un dépôt de produit (le plan, quand un lot s'ajoute).
export async function ecrireFichierDepot(config, nom, chemin, contenu, message, branche = "main") {
  const actuel = await gh(config, `${depot(config, nom)}/contents/${chemin}?ref=${encodeURIComponent(branche)}`, { accepter: [404] })
  await gh(config, `${depot(config, nom)}/contents/${chemin}`, { method: "PUT", corps: { message, branch: branche, content: Buffer.from(contenu).toString("base64"), ...(actuel.statut === 200 ? { sha: actuel.json.sha } : {}) } })
}
export const shaPrincipal = async (config, nom, branche = "main") => (await gh(config, `${depot(config, nom)}/git/ref/heads/${branche}`)).json.object.sha

// Ce que l'usine peut faire sur un dépôt, avant de le reprendre : null s'il est introuvable
// ou invisible pour son jeton. pousser : le compte de l'usine y écrit (collaborateur invité).
export async function infosDepot(config, nom) {
  const r = await gh(config, depot(config, nom), { accepter: [401, 403, 404] })
  if (r.statut !== 200) return null
  const j = r.json
  return { nom: j.full_name, prive: Boolean(j.private), branche_defaut: j.default_branch, pousser: Boolean(j.permissions?.push), archive: Boolean(j.archived), taille_ko: Number(j.size ?? 0), description: j.description ?? "" }
}

// Les documents d'un dépôt (description, README, docs/*.md), lus avec le jeton de l'usine pour
// nourrir la recherche d'un persona : l'agent reçoit le texte, jamais le jeton. null : invisible.
export async function documentsDepot(config, nom, { fichiersMax = 6, tailleMax = 40_000 } = {}) {
  const infos = await infosDepot(config, nom)
  if (!infos) return null
  const contenu = async (chemin) => {
    const r = await gh(config, `${depot(config, nom)}/${chemin}`, { accepter: [404] })
    return r.statut === 200 && r.json.content ? Buffer.from(r.json.content, "base64").toString("utf8").slice(0, tailleMax) : null
  }
  const parties = [`# Dépôt ${infos.nom}`, infos.description ? `Description : ${infos.description}` : ""]
  const readme = await contenu("readme")
  if (readme) parties.push("## README", readme)
  const docs = await gh(config, `${depot(config, nom)}/contents/docs`, { accepter: [404] })
  const fichiers = Array.isArray(docs.json) ? docs.json.filter((f) => f.type === "file" && /\.(md|markdown|txt)$/i.test(f.name)).slice(0, fichiersMax) : []
  for (const f of fichiers) {
    const t = await contenu(`contents/${f.path.split("/").map(encodeURIComponent).join("/")}`)
    if (t) parties.push(`## ${f.path}`, t)
  }
  return { nom: infos.nom, texte: parties.filter(Boolean).join("\n\n"), fichiers: 1 + fichiers.length }
}

// Une branche créée à partir d'une autre (la branche d'intégration d'un dépôt repris).
export async function creerBranche(config, nom, branche, depuis) {
  const existe = await gh(config, `${depot(config, nom)}/git/ref/heads/${branche}`, { accepter: [404] })
  if (existe.statut === 200) return existe.json.object.sha
  const sha = await shaPrincipal(config, nom, depuis)
  await gh(config, `${depot(config, nom)}/git/refs`, { method: "POST", corps: { ref: `refs/heads/${branche}`, sha } })
  return sha
}

// --- Le dépôt d'état (lu par le déployeur) ------------------------------------

export async function preparerDepotEtat(config) {
  const nom = config.github.depot_etat
  const existe = await gh(config, depot(config, nom), { accepter: [404] })
  if (existe.statut === 200) return
  const { chemin, jeton } = await cibleCreation(config)
  await gh(config, chemin, { method: "POST", jeton, corps: { name: nom, description: "État souhaité des produits de l'usine logicielle (lu par le déployeur)", private: true, auto_init: true } })
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
