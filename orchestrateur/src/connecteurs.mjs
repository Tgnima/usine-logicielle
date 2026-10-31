// Les connecteurs : des serveurs MCP que les IA de l'usine utilisent pendant leur travail
// (documentation à jour, navigateur, recherche web, maquettes…), réglés dans la console.
//
// Chaque connecteur actif est donné aux rôles choisis : plan (l'analyste, la recherche des
// publics), construction (les agents de l'atelier, l'inventaire d'une reprise), vérification
// (le vérificateur et la recette). Sa clé est chiffrée comme les identifiants des fournisseurs
// (chiffrer, fournisseurs.mjs) et n'est jamais renvoyée à la console : seulement ses 4 derniers
// caractères. Elle arrive aux travaux par une variable CONNECTEUR_<ID>, jamais dans le texte
// d'un script, et les fichiers de configuration MCP n'en contiennent que la référence.
import { chiffrer, dechiffrer } from "./fournisseurs.mjs"
import { ecrireReglage, lireReglage } from "./couts.mjs"
import { noter } from "./db.mjs"
import { ecrireFichier, executer, q } from "./travaux.mjs"

export const ROLES = ["plan", "construction", "verification"]
const NOMS_ROLES = { plan: "plan", construction: "construction", verification: "vérification" }
const PERSO_MAX = 20
const erreur = (code, message) => Object.assign(new Error(message), { code })

// Le catalogue. serveur : une commande (lancée par npx dans le conteneur, en dernière version)
// ou une adresse (MCP en HTTP). cle.variable : le nom attendu par le serveur MCP.
const npx = (paquet, ...args) => ({ commande: "npx", args: ["-y", `${paquet}@latest`, ...args] })
export const CATALOGUE = [
  {
    id: "documentation", nom: "Documentation à jour", famille: "construire", logo: "D", couleur: "#0f766e", conseille: true, roles_conseilles: ["plan", "construction"],
    apport: "Les IA lisent la documentation actuelle des bibliothèques au lieu de se fier à leur mémoire.",
    texte: "Quand une IA utilise une bibliothèque, elle lit sa documentation dans la dernière version (Context7). Moins d'erreurs dues à une version périmée.",
    peut: ["Chercher la documentation d'une bibliothèque", "Lire des exemples de code officiels"], limites: ["Ne lit rien de tes projets", "N'envoie aucune donnée de l'usine"],
    serveur: { url: "https://mcp.context7.com/mcp" }, cle: null,
  },
  {
    id: "navigateur", nom: "Navigateur", famille: "verifier", logo: "▷", couleur: "#2563eb", conseille: true, roles_conseilles: ["construction", "verification"],
    apport: "Les IA ouvrent l'application dans un vrai navigateur, cliquent et regardent l'écran.",
    texte: "Les IA vérifient leur travail comme un visiteur : elles ouvrent l'application, cliquent, remplissent les formulaires et prennent des captures (Playwright).",
    peut: ["Ouvrir l'application en cours de construction", "Cliquer, remplir des formulaires, faire des captures"], limites: ["Navigateur sans compte : n'utilise aucune de tes sessions"],
    serveur: npx("@playwright/mcp", "--headless", "--isolated"), cle: null,
  },
  {
    id: "recherche", nom: "Recherche web", famille: "comprendre", logo: "W", couleur: "#7c3aed", conseille: true, roles_conseilles: ["plan"],
    apport: "Le plan et la fiche des publics s'appuient sur des sources récentes.",
    texte: "L'IA du plan cherche sur le web : concurrents, usages, chiffres (Tavily). Chaque fait cité garde sa source.",
    peut: ["Chercher sur le web et lire des pages publiques"], limites: ["Ne se connecte à aucun site", "Ne remplit aucun formulaire"],
    serveur: npx("tavily-mcp"), cle: { libelle: "Clé Tavily", aide: "Sur tavily.com, rubrique API Keys. L'offre gratuite suffit pour commencer.", variable: "TAVILY_API_KEY", prefixe: "tvly-" },
  },
  {
    id: "figma", nom: "Figma", famille: "comprendre", logo: "F", couleur: "#a259ff", roles_conseilles: ["plan", "construction"],
    apport: "Les IA lisent tes maquettes pour reproduire écrans, couleurs et espacements.",
    texte: "Donne le lien d'une maquette Figma dans ta demande : les IA construisent les écrans à partir d'elle.",
    peut: ["Lire les écrans d'un fichier dont tu donnes le lien"], limites: ["Ne modifie jamais tes fichiers (un jeton en lecture seule suffit)"],
    serveur: npx("figma-developer-mcp", "--stdio"), cle: { libelle: "Jeton d'accès Figma", aide: "Dans Figma : Settings, Security, Personal access tokens. La lecture seule suffit.", variable: "FIGMA_API_KEY", prefixe: "figd_" },
  },
  {
    id: "notion", nom: "Notion", famille: "comprendre", logo: "N", couleur: "#191919", roles_conseilles: ["plan"],
    apport: "Les IA lisent tes cahiers des charges et la documentation de l'entreprise.",
    texte: "L'IA du plan lit les pages Notion partagées avec l'intégration : cahier des charges, règles métier, documentation.",
    peut: ["Lire les pages partagées avec l'intégration"], limites: ["Ne voit que les pages partagées avec l'intégration", "Donne-lui des droits de lecture seule"],
    serveur: npx("@notionhq/notion-mcp-server"), cle: { libelle: "Clé d'intégration Notion", aide: "Sur notion.so/profile/integrations, crée une intégration en lecture seule, puis partage avec elle les pages utiles.", variable: "NOTION_TOKEN", prefixe: "ntn_" },
  },
  {
    id: "stripe", nom: "Stripe", famille: "construire", logo: "S", couleur: "#635bff", roles_conseilles: ["construction", "verification"],
    apport: "Les IA branchent les paiements en mode test, avec de faux numéros de carte.",
    texte: "Les IA créent les produits et les paiements de test dont l'application a besoin, puis vérifient le parcours d'achat.",
    peut: ["Créer des produits, des prix et des paiements de test"], limites: ["Mode test uniquement : une clé de production est refusée"],
    serveur: npx("@stripe/mcp", "--tools=all"), cle: { libelle: "Clé de test Stripe", aide: "Sur dashboard.stripe.com : Développeurs, Clés API, en mode test (sk_test_… ou rk_test_…).", variable: "STRIPE_SECRET_KEY", test: /^(sk|rk)_test_/ },
  },
  {
    id: "sentry", nom: "Sentry", famille: "verifier", logo: "Se", couleur: "#362d59", roles_conseilles: ["construction"],
    apport: "Quand une application en ligne plante, les IA lisent l'erreur pour la corriger.",
    texte: "Lors d'une demande de corrections, les IA lisent les erreurs relevées par Sentry dans l'application en ligne.",
    peut: ["Lire les erreurs et leur contexte"], limites: ["Donne au jeton des droits de lecture seulement"],
    serveur: npx("@sentry/mcp-server"), cle: { libelle: "Jeton Sentry", aide: "Sur sentry.io : Settings, Auth Tokens, avec les droits de lecture.", variable: "SENTRY_ACCESS_TOKEN" },
  },
]

const cleEtat = (id) => `connecteur_${id}`
const cleCle = (id) => `connecteur_cle_${id}`
const variable = (id) => `CONNECTEUR_${id.toUpperCase().replace(/-/g, "_")}`
const lireJson = (db, cle, defaut) => {
  try {
    return JSON.parse(lireReglage(db, cle, "")) ?? defaut
  } catch {
    return defaut
  }
}

function perso(db) {
  return lireJson(db, "connecteurs_perso", []).map((p) => ({
    id: p.id, nom: p.nom, famille: "construire", logo: p.nom.slice(0, 2), couleur: "#5b6b7a", perso: true, adresse: p.adresse, par: p.par, roles_conseilles: ["construction"],
    apport: "Un outil ajouté par ton équipe.", texte: "Un serveur MCP ajouté par ton équipe : les IA voient les outils qu'il propose.",
    serveur: { url: p.adresse }, cle: p.avec_cle ? { libelle: "Clé d'accès", aide: "Envoyée à l'adresse ci-dessus comme jeton (Authorization: Bearer)." } : null,
  }))
}

const tous = (db) => [...CATALOGUE, ...perso(db)]
function trouver(db, id) {
  const c = tous(db).find((x) => x.id === id)
  if (!c) throw erreur(404, "Connecteur introuvable.")
  return c
}
const etatDe = (db, id) => lireJson(db, cleEtat(id), { actif: false, roles: [] })
const entreeCle = (db, id) => lireJson(db, cleCle(id), null)

// Ce que voit la console : jamais la clé, ni la configuration technique.
export function listerConnecteurs(ctx) {
  return {
    connecteurs: tous(ctx.db).map(({ serveur, cle, ...c }) => {
      const e = etatDe(ctx.db, c.id)
      const k = cle ? entreeCle(ctx.db, c.id) : null
      return {
        ...c, actif: Boolean(e.actif), roles: e.actif ? e.roles : [], le: e.le ?? null, par_qui: e.par ?? null,
        cle: cle ? { libelle: cle.libelle, aide: cle.aide } : null, cle_remplie: Boolean(k), cle_fin: k?.fin ?? null,
        test: e.test ?? null, etat: e.test && !e.test.ok ? "erreur" : null,
      }
    }),
  }
}

export function reglerConnecteur(ctx, id, { actif, roles }, par) {
  const c = trouver(ctx.db, id)
  const e = etatDe(ctx.db, id)
  if (actif !== true) {
    ecrireReglage(ctx.db, cleEtat(id), JSON.stringify({ ...e, actif: false, le: new Date().toISOString(), par }))
    noter(ctx.db, { projet: null, type: "reglage", message: `Connecteur ${c.nom} désactivé par ${par}` })
    return { ok: true, message: `${c.nom} est désactivé.` }
  }
  const choisis = Array.isArray(roles) ? [...new Set(roles.map(String))].filter((r) => ROLES.includes(r)) : []
  if (!choisis.length) throw erreur(400, "Coche au moins une IA qui peut s'en servir.")
  if (c.cle && !entreeCle(ctx.db, id)) throw erreur(409, "Colle d'abord la clé de ce connecteur.")
  ecrireReglage(ctx.db, cleEtat(id), JSON.stringify({ ...e, actif: true, roles: choisis, le: new Date().toISOString(), par }))
  noter(ctx.db, { projet: null, type: "reglage", message: `Connecteur ${c.nom} actif pour : ${choisis.map((r) => NOMS_ROLES[r]).join(", ")} (par ${par})` })
  return { ok: true, message: `C'est enregistré : les IA s'en servent dès leur prochaine tâche.` }
}

// Une clé : un seul mot, sans guillemet ni caractère que le shell interpréterait.
const CLE_VALIDE = /^[A-Za-z0-9_\-.:/+=@~]{8,4000}$/
function verifierCle(c, valeur) {
  const v = String(valeur ?? "").trim()
  if (!CLE_VALIDE.test(v)) throw erreur(400, `${c.cle.libelle} : la valeur semble incomplète (un seul mot, au moins 8 caractères).`)
  if (c.cle.test && !c.cle.test.test(v)) throw erreur(400, `${c.cle.libelle} : seule une clé de test est acceptée.`)
  return v
}

export function poserCleConnecteur(ctx, id, valeur, par) {
  const c = trouver(ctx.db, id)
  if (!c.cle) throw erreur(400, `${c.nom} n'a pas besoin de clé.`)
  const v = verifierCle(c, valeur)
  ecrireReglage(ctx.db, cleCle(id), JSON.stringify({ ...chiffrer(ctx, v), fin: v.slice(-4), le: new Date().toISOString(), par }))
  noter(ctx.db, { projet: null, type: "reglage", message: `${c.cle.libelle} (${c.nom}) posée dans la console par ${par}` })
  const avertissement = c.cle.prefixe && !v.startsWith(c.cle.prefixe) ? ` Attention : une telle clé commence d'habitude par « ${c.cle.prefixe} ».` : ""
  return { ok: true, message: `Clé enregistrée. Tu peux maintenant activer le connecteur.${avertissement}` }
}

export function effacerCleConnecteur(ctx, id, par) {
  const c = trouver(ctx.db, id)
  ctx.db.prepare("DELETE FROM reglages WHERE cle = ?").run(cleCle(id))
  const e = etatDe(ctx.db, id)
  if (e.actif) ecrireReglage(ctx.db, cleEtat(id), JSON.stringify({ ...e, actif: false, le: new Date().toISOString(), par }))
  noter(ctx.db, { projet: null, type: "reglage", message: `Clé du connecteur ${c.nom} retirée par ${par}${e.actif ? " (connecteur désactivé)" : ""}` })
  return { ok: true, message: e.actif ? "Clé retirée : le connecteur est désactivé." : "Clé retirée." }
}

// Un connecteur de l'équipe : un serveur MCP en HTTPS, avec une clé facultative.
export function ajouterConnecteur(ctx, { nom, adresse, cle }, par) {
  const n = String(nom ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 60)
  if (n.length < 2) throw erreur(400, "Donne un nom au connecteur.")
  let url
  try {
    url = new URL(String(adresse ?? "").trim())
  } catch {
    throw erreur(400, "L'adresse n'est pas une adresse web complète (https://…).")
  }
  if (url.protocol !== "https:" || url.username || url.password) throw erreur(400, "L'adresse doit commencer par https:// et ne contenir aucun identifiant.")
  const liste = lireJson(ctx.db, "connecteurs_perso", [])
  if (liste.length >= PERSO_MAX) throw erreur(409, `Au plus ${PERSO_MAX} connecteurs ajoutés : retires-en un d'abord.`)
  const suivant = Math.max(0, ...liste.map((p) => Number(p.id.split("-")[1]))) + 1
  const id = `perso-${suivant}`
  const avecCle = Boolean(String(cle ?? "").trim())
  const fiche = { id, nom: n, adresse: url.href, par, le: new Date().toISOString(), avec_cle: avecCle }
  // La clé est vérifiée avant que le connecteur soit gardé.
  const v = avecCle ? verifierCle({ cle: { libelle: "Clé d'accès" } }, cle) : null
  ecrireReglage(ctx.db, "connecteurs_perso", JSON.stringify([...liste, fiche]))
  if (v) ecrireReglage(ctx.db, cleCle(id), JSON.stringify({ ...chiffrer(ctx, v), fin: v.slice(-4), le: fiche.le, par }))
  noter(ctx.db, { projet: null, type: "reglage", message: `Connecteur ${n} (${url.host}) ajouté par ${par}` })
  return { ok: true, id, message: `${n} est ajouté : choisis quelles IA peuvent s'en servir.` }
}

export function retirerConnecteur(ctx, id, par) {
  const c = trouver(ctx.db, id)
  if (!c.perso) throw erreur(409, "Un connecteur du catalogue se désactive, il ne se retire pas.")
  ecrireReglage(ctx.db, "connecteurs_perso", JSON.stringify(lireJson(ctx.db, "connecteurs_perso", []).filter((p) => p.id !== id)))
  ctx.db.prepare("DELETE FROM reglages WHERE cle IN (?, ?)").run(cleEtat(id), cleCle(id))
  noter(ctx.db, { projet: null, type: "reglage", message: `Connecteur ${c.nom} retiré par ${par}` })
  return { ok: true, message: "Connecteur retiré." }
}

// Les connecteurs actifs d'un rôle, avec leur définition complète (usage interne).
function actifs(ctx, role) {
  return tous(ctx.db).filter((c) => {
    const e = etatDe(ctx.db, c.id)
    return e.actif && e.roles.includes(role) && (!c.cle || entreeCle(ctx.db, c.id))
  })
}

// Les clés des connecteurs actifs, pour l'environnement des travaux (CONNECTEUR_<ID>).
export function envConnecteurs(ctx) {
  const env = {}
  for (const c of tous(ctx.db)) {
    if (!c.cle || !etatDe(ctx.db, c.id).actif) continue
    const k = entreeCle(ctx.db, c.id)
    if (!k) continue
    try {
      env[variable(c.id)] = dechiffrer(ctx, k)
    } catch {
      console.error(`Connecteurs : la clé de ${c.nom} est illisible (clé maîtresse changée ?) ; le connecteur est ignoré.`)
    }
  }
  return env
}

// Claude Code : un fichier --mcp-config. Les clés y sont des références ${CONNECTEUR_…},
// que Claude Code remplace par la variable d'environnement du travail.
export function configClaude(ctx, role) {
  const serveurs = {}
  for (const c of actifs(ctx, role)) {
    const ref = c.cle ? `\${${variable(c.id)}}` : null
    serveurs[c.id] = c.serveur.url
      ? { type: "http", url: c.serveur.url, ...(ref ? { headers: { Authorization: `Bearer ${ref}` } } : {}) }
      : { command: c.serveur.commande, args: c.serveur.args, ...(ref ? { env: { [c.cle.variable]: ref } } : {}) }
  }
  return Object.keys(serveurs).length ? { mcpServers: serveurs } : null
}

// Les outils MCP à autoriser pour Claude en mode -p (« mcp__<serveur> » : tous ses outils).
export const outilsClaude = (ctx, role) => actifs(ctx, role).map((c) => `mcp__${c.id}`)

// Le morceau de script qui écrit la configuration, et les options à ajouter à claude.
export function optionsClaude(ctx, role, dossier = "/tmp/sorties") {
  const config = role ? configClaude(ctx, role) : null
  if (!config) return { script: "", args: "" }
  const fichier = `${dossier}/mcp-${role}.json`
  return { script: `mkdir -p ${q(dossier)} && ${ecrireFichier(fichier, JSON.stringify(config))}`, args: `--mcp-config ${q(fichier)} --strict-mcp-config` }
}

// Codex : des options -c. Une clé passe par la variable du travail ("$CONNECTEUR_…" est
// développé par bash au lancement : la valeur n'est jamais écrite dans le script).
export function optionsCodex(ctx, role) {
  if (!role) return ""
  const toml = (v) => JSON.stringify(v)
  return actifs(ctx, role).flatMap((c) => {
    const base = `mcp_servers.${c.id}`
    if (c.serveur.url) return [`-c ${q(`${base}.url=${toml(c.serveur.url)}`)}`, ...(c.cle ? [`-c ${q(`${base}.bearer_token_env_var=${toml(variable(c.id))}`)}`] : [])]
    return [
      `-c ${q(`${base}.command=${toml(c.serveur.commande)}`)}`,
      `-c ${q(`${base}.args=[${c.serveur.args.map(toml).join(",")}]`)}`,
      ...(c.cle ? [`-c "${base}.env={${c.cle.variable}=\\"$${variable(c.id)}\\"}"`] : []),
    ]
  }).join(" ")
}

// Le test : l'atelier ouvre une session MCP (initialize) avec le connecteur, comme le ferait une IA.
const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "usine", version: "1.0" } } })
export function scriptTest(c) {
  const v = variable(c.id)
  const appel = c.serveur.url
    ? `curl -s -m 30 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' ${c.cle ? `-H "authorization: Bearer $${v}"` : ""} --data ${q(INIT)} ${q(c.serveur.url)}`
    : `(printf '%s\\n' ${q(INIT)}; sleep 25) | ${c.cle ? `${c.cle.variable}="$${v}" ` : ""}timeout 150 ${[c.serveur.commande, ...c.serveur.args].map(q).join(" ")} 2>/dev/null`
  return [
    "cd /tmp",
    `R=$(${appel} | head -c 4000)`,
    `if echo "$R" | grep -q '"protocolVersion"'; then echo "@@ MCP ok"; else echo "@@ MCP $(echo "$R" | tr -d '\\n' | head -c 160)"; fi`,
  ].join("\n")
}

export async function testerConnecteur(ctx, id, par) {
  const c = trouver(ctx.db, id)
  const env = {}
  if (c.cle) {
    const k = entreeCle(ctx.db, id)
    if (!k) throw erreur(409, "Colle d'abord la clé de ce connecteur.")
    env[variable(id)] = dechiffrer(ctx, k)
  }
  const r = await executer(ctx.config.atelier.url, ctx.config.secrets.worker, scriptTest(c), { env, minutes: 5 })
  const ok = r.marqueurs?.MCP === "ok"
  const detail = ok ? "" : String(r.marqueurs?.MCP ?? "").trim()
  const e = etatDe(ctx.db, id)
  ecrireReglage(ctx.db, cleEtat(id), JSON.stringify({ ...e, test: { le: new Date().toISOString(), ok, par } }))
  if (!ok) throw erreur(502, `${c.nom} ne répond pas comme prévu${detail ? ` : ${detail}` : " (aucune réponse)"}. Vérifie la clé, puis réessaie.`)
  return { ok: true, message: `${c.nom} répond : les IA peuvent s'en servir.` }
}
