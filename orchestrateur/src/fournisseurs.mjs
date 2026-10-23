// Les fournisseurs d'IA, réglés depuis la console (plus besoin du serveur ni du fichier .env) :
//   - les identifiants (jeton d'abonnement Claude, clés API Anthropic et OpenAI, clé de la
//     passerelle), chiffrés dans la base de l'usine ;
//   - pour chaque moteur, les façons de s'en servir (abonnement, clé API, passerelle) et leur ordre ;
//   - le modèle de chaque rôle (analyste, agents, renfort…).
//
// Sécurité : une valeur saisie n'est jamais renvoyée (seulement « renseignée », ses 4 derniers
// caractères, la date et l'auteur). Le chiffrement (AES-256-GCM) utilise une clé dérivée du
// secret worker_token, qui ne quitte pas le serveur : la base seule ne suffit pas à lire les clés.
// Changer worker_token efface donc le coffre (les clés sont à ressaisir).
// Une valeur de la console passe avant celle du serveur (secrets.sh), qui reste le secours.
// Les identifiants vont aux ateliers et au vérificateur avec chaque travail, jamais ailleurs.
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto"
import { ecrireReglage, lireReglage } from "./couts.mjs"
import { noter } from "./db.mjs"
import { MODES, PASSERELLE } from "./moteurs.mjs"
import { etatTravail, executer, lancerTravail } from "./travaux.mjs"

// Les identifiants que la console sait poser : nom de la variable dans les travaux, et le reste.
export const IDENTIFIANTS = {
  CLAUDE_CODE_OAUTH_TOKEN: { libelle: "Jeton d'abonnement Claude (Pro/Max)", moteur: "claude-code", mode: "abonnement", prefixe: "sk-ant-oat" },
  ANTHROPIC_API_KEY: { libelle: "Clé API Anthropic", moteur: "claude-code", mode: "cle", prefixe: "sk-ant-api" },
  OPENAI_API_KEY: { libelle: "Clé API OpenAI", moteur: "codex", mode: "cle", prefixe: "sk-" },
  AI_GATEWAY_API_KEY: { libelle: "Clé Vercel AI Gateway", moteur: "tous", mode: "passerelle", prefixe: "" },
}
export const MOTEURS = { "claude-code": "Claude (analyste, agents, relecteurs)", codex: "Codex · OpenAI (vérificateur, relecteur design)" }
// Les rôles dont le modèle se choisit dans la console (le vérificateur suit son moteur).
export const ROLES_MODELES = ["analyste", "atelier", "renfort", "relecteur", "petites_taches"]

const erreur = (code, message) => Object.assign(new Error(message), { code })
const cleCoffre = (nom) => `coffre_${nom}`

const cles = new Map()
function cleDeChiffrement(ctx) {
  const jeton = ctx.config.secrets.worker
  if (!jeton) throw new Error("worker_token manquant : le coffre est indisponible.")
  if (!cles.has(jeton)) cles.set(jeton, Buffer.from(hkdfSync("sha256", jeton, "usine-logicielle", "coffre des fournisseurs", 32)))
  return cles.get(jeton)
}

export function chiffrer(ctx, texte) {
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", cleDeChiffrement(ctx), iv)
  const donnees = Buffer.concat([c.update(texte, "utf8"), c.final()])
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), donnees: donnees.toString("base64") }
}

export function dechiffrer(ctx, e) {
  const d = createDecipheriv("aes-256-gcm", cleDeChiffrement(ctx), Buffer.from(e.iv, "base64"))
  d.setAuthTag(Buffer.from(e.tag, "base64"))
  return Buffer.concat([d.update(Buffer.from(e.donnees, "base64")), d.final()]).toString("utf8")
}

function entree(ctx, nom) {
  try {
    return JSON.parse(lireReglage(ctx.db, cleCoffre(nom), "null"))
  } catch {
    return null
  }
}

// Les valeurs à passer aux travaux : seulement celles posées dans la console (les autres
// restent celles du serveur, déjà dans l'environnement des ateliers).
// moteur : celui du serveur qui reçoit le travail (l'atelier n'a pas besoin de la clé OpenAI).
export function envFournisseurs(ctx, moteur = null) {
  const env = {}
  for (const [nom, def] of Object.entries(IDENTIFIANTS)) {
    if (moteur && def.moteur !== "tous" && def.moteur !== moteur) continue
    const e = entree(ctx, nom)
    if (!e) continue
    try {
      env[nom] = dechiffrer(ctx, e)
    } catch {
      console.error(`Coffre : ${nom} illisible (worker_token changé ?) ; la valeur du serveur sert.`)
    }
  }
  return env
}

export function poserIdentifiant(ctx, nom, valeur, par) {
  const def = IDENTIFIANTS[nom]
  if (!def) throw erreur(400, "Identifiant inconnu.")
  const v = String(valeur ?? "").trim()
  if (v.length < 12 || v.length > 4000 || /\s/.test(v)) throw erreur(400, `${def.libelle} : la valeur semble incomplète (pas d'espace, au moins 12 caractères).`)
  ecrireReglage(ctx.db, cleCoffre(nom), JSON.stringify({ ...chiffrer(ctx, v), fin: v.slice(-4), le: new Date().toISOString(), par }))
  noter(ctx.db, { projet: null, type: "reglage", message: `${def.libelle} posée dans la console par ${par}` })
  const avertissement = def.prefixe && !v.startsWith(def.prefixe) ? ` Attention : une telle valeur commence d'habitude par « ${def.prefixe} ».` : ""
  return { ok: true, message: `${def.libelle} enregistrée.${avertissement} Elle sert dès le prochain travail.` }
}

export function effacerIdentifiant(ctx, nom, par) {
  const def = IDENTIFIANTS[nom]
  if (!def) throw erreur(400, "Identifiant inconnu.")
  ctx.db.prepare("DELETE FROM reglages WHERE cle = ?").run(cleCoffre(nom))
  noter(ctx.db, { projet: null, type: "reglage", message: `${def.libelle} retirée de la console par ${par}` })
  return { ok: true, message: `${def.libelle} retirée : la valeur du serveur, s'il y en a une, reprend.` }
}

// Les façons de se servir d'un moteur, dans l'ordre : celles de la console, sinon le contrat.
export function ordreModes(ctx, moteur) {
  try {
    const o = JSON.parse(lireReglage(ctx.db, `modes_${moteur}`, "null"))
    if (Array.isArray(o)) return o.filter((m) => MODES.includes(m))
  } catch {}
  return (ctx.config.secours?.ordre ?? MODES).filter((m) => MODES.includes(m))
}

export function reglerModes(ctx, moteur, modes, par) {
  if (!MOTEURS[moteur]) throw erreur(400, "Moteur inconnu.")
  const liste = [...new Set((Array.isArray(modes) ? modes : []).map(String))].filter((m) => MODES.includes(m))
  if (!liste.length) throw erreur(400, "Garde au moins une façon de te servir de ce moteur.")
  ecrireReglage(ctx.db, `modes_${moteur}`, JSON.stringify(liste))
  noter(ctx.db, { projet: null, type: "reglage", message: `${MOTEURS[moteur]} : ${liste.join(" puis ")} (par ${par})` })
  return { ok: true, message: "Ordre enregistré." }
}

// Les modèles choisis dans la console remplacent ceux du contrat (en mémoire, pour tout le code).
const NOM_MODELE = /^[a-z0-9][a-z0-9./:_-]{2,80}$/i
export function appliquerModeles(ctx) {
  let m = {}
  try {
    m = JSON.parse(lireReglage(ctx.db, "modeles", "{}")) ?? {}
  } catch {}
  ctx.config.modelesContrat ??= structuredClone(ctx.config.modeles ?? {})
  const modeles = structuredClone(ctx.config.modelesContrat)
  for (const [role, modele] of Object.entries(m)) if (ROLES_MODELES.includes(role) && NOM_MODELE.test(modele)) modeles[role] = { ...(modeles[role] ?? { moteur: "claude-code" }), modele }
  ctx.config.modeles = modeles
}

export function reglerModeles(ctx, choix, par) {
  const m = {}
  for (const role of ROLES_MODELES) {
    const v = String(choix?.[role] ?? "").trim()
    if (!v) continue
    if (!NOM_MODELE.test(v)) throw erreur(400, `${role} : nom de modèle invalide.`)
    if (v !== ctx.config.modelesContrat?.[role]?.modele) m[role] = v
  }
  ecrireReglage(ctx.db, "modeles", JSON.stringify(m))
  appliquerModeles(ctx)
  noter(ctx.db, { projet: null, type: "reglage", message: `Modèles modifiés dans la console par ${par}` })
  return { ok: true, message: "Modèles enregistrés : ils servent dès le prochain travail." }
}

// Ce que la console affiche (jamais une valeur).
export function etatFournisseurs(ctx) {
  const tests = lireTests(ctx)
  const serveur = tests.serveur ?? {}
  const identifiants = Object.entries(IDENTIFIANTS).map(([nom, def]) => {
    const e = entree(ctx, nom)
    return { nom, libelle: def.libelle, moteur: def.moteur, mode: def.mode, console: e ? { fin: e.fin, le: e.le, par: e.par } : null, serveur: serveur[nom] ?? null }
  })
  return {
    identifiants,
    moteurs: Object.entries(MOTEURS).map(([id, libelle]) => ({ id, libelle, modes: ordreModes(ctx, id) })),
    tests: { le: tests.le ?? null, resultats: tests.resultats ?? {} },
    chatgpt: connexionChatGPT ? { en_cours: true } : null,
    modeles: ROLES_MODELES.map((role) => ({ role, modele: ctx.config.modeles?.[role]?.modele ?? ctx.config.modeles?.atelier?.modele ?? "", contrat: ctx.config.modelesContrat?.[role]?.modele ?? null })),
  }
}

// --- Tester les connexions -------------------------------------------------------------------
// Chaque façon est essayée séparément, avec la valeur réellement utilisée (console, sinon serveur).
// Les clés API sont vérifiées sans dépense (liste des modèles) ; l'abonnement Claude par un appel
// minuscule (Haiku, un tour) ; l'abonnement ChatGPT par « codex login status ».
// Chaque ligne : « @@ T_<MOTEUR>_<MODE> ok|absent|<erreur> » ; « @@ S_<NOM> 1 » si le serveur a la valeur.
const curlModeles = (url, entete) => `C=$(curl -s -o /tmp/sorties/test.out -w '%{http_code}' -m 20 -H ${entete} ${url}); if [ "$C" = 200 ]; then echo ok; else echo "réponse $C $(head -c 120 /tmp/sorties/test.out | tr -d '\\n')"; fi`
const presence = (noms) => noms.map((n) => `[ -s /run/secrets/${n.toLowerCase()} ] && echo "@@ S_${n} 1"`).join("\n")

// Des fonctions (pas des constantes) : moteurs.mjs et ce module s'importent l'un l'autre.
const scriptAtelier = () => [
  presence(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "AI_GATEWAY_API_KEY"]),
  `if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then cd /tmp && env -u ANTHROPIC_API_KEY -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN claude -p 'Réponds seulement : OK' --model claude-haiku-4-5 --max-turns 1 --output-format json < /dev/null > /tmp/sorties/test-claude.json 2>&1; if grep -q '"is_error":false' /tmp/sorties/test-claude.json; then echo "@@ T_CLAUDE_ABONNEMENT ok"; else D=$(grep -oE '"result":"[^"]{0,140}' /tmp/sorties/test-claude.json | cut -c11- | head -1); echo "@@ T_CLAUDE_ABONNEMENT \${D:-refusé (jeton expiré ou invalide ?)}"; fi; else echo "@@ T_CLAUDE_ABONNEMENT absent"; fi`,
  `if [ -n "$ANTHROPIC_API_KEY" ]; then echo "@@ T_CLAUDE_CLE $(${curlModeles("https://api.anthropic.com/v1/models", `"x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"`)})"; else echo "@@ T_CLAUDE_CLE absent"; fi`,
  `if [ -n "$AI_GATEWAY_API_KEY" ]; then echo "@@ T_CLAUDE_PASSERELLE $(${curlModeles(`${PASSERELLE}/v1/models`, `"Authorization: Bearer $AI_GATEWAY_API_KEY"`)})"; else echo "@@ T_CLAUDE_PASSERELLE absent"; fi`,
].join("\n")

const scriptVerificateur = () => [
  presence(["OPENAI_API_KEY", "AI_GATEWAY_API_KEY"]),
  `S=$(env -u OPENAI_API_KEY codex login status 2>&1 | tail -1); if echo "$S" | grep -qi 'logged in' && ! echo "$S" | grep -qi 'not logged'; then echo "@@ T_CODEX_ABONNEMENT ok"; else echo "@@ T_CODEX_ABONNEMENT absent"; fi`,
  `if [ -n "$OPENAI_API_KEY" ]; then echo "@@ T_CODEX_CLE $(${curlModeles("https://api.openai.com/v1/models", `"Authorization: Bearer $OPENAI_API_KEY"`)})"; else echo "@@ T_CODEX_CLE absent"; fi`,
  `if [ -n "$AI_GATEWAY_API_KEY" ]; then echo "@@ T_CODEX_PASSERELLE $(${curlModeles(`${PASSERELLE}/v1/models`, `"Authorization: Bearer $AI_GATEWAY_API_KEY"`)})"; else echo "@@ T_CODEX_PASSERELLE absent"; fi`,
].join("\n")

export function lireTests(ctx) {
  try {
    return JSON.parse(lireReglage(ctx.db, "tests_fournisseurs", "null")) ?? { resultats: {}, serveur: {} }
  } catch {
    return { resultats: {}, serveur: {} }
  }
}

// Les marqueurs d'un test en résultats : { "claude-code": { abonnement: { etat, detail } … } }.
export function lireMarqueursTest(marqueurs, moteur) {
  const prefixe = moteur === "codex" ? "T_CODEX_" : "T_CLAUDE_"
  const r = {}
  for (const mode of MODES) {
    const v = marqueurs[`${prefixe}${mode.toUpperCase()}`]
    if (v === undefined) continue
    r[mode] = v === "ok" ? { etat: "ok" } : v === "absent" ? { etat: "absent" } : { etat: "erreur", detail: v.slice(0, 200) }
  }
  const serveur = Object.fromEntries(Object.keys(marqueurs).filter((k) => k.startsWith("S_")).map((k) => [k.slice(2), true]))
  return { resultats: r, serveur }
}

let testEnCours = false
export async function testerFournisseurs(ctx) {
  if (testEnCours) return { ok: false, message: "Un test est déjà en cours." }
  testEnCours = true
  try {
    const { config } = ctx
    const precedent = lireTests(ctx)
    const [a, v] = await Promise.all([
      executer(config.atelier.url, config.secrets.worker, scriptAtelier(), { minutes: 3 }).catch((e) => ({ marqueurs: {}, erreur: e.message })),
      executer(config.verificateur.url, config.secrets.worker, scriptVerificateur(), { minutes: 3 }).catch((e) => ({ marqueurs: {}, erreur: e.message })),
    ])
    const ta = lireMarqueursTest(a.marqueurs ?? {}, "claude-code")
    const tv = lireMarqueursTest(v.marqueurs ?? {}, "codex")
    const t = {
      le: new Date().toISOString(),
      resultats: { "claude-code": ta.resultats, codex: tv.resultats },
      serveur: { ...precedent.serveur, ...ta.serveur, ...tv.serveur },
    }
    ecrireReglage(ctx.db, "tests_fournisseurs", JSON.stringify(t))
    return { ok: true, message: "Connexions testées.", tests: t }
  } finally {
    testEnCours = false
  }
}

// --- Connecter l'abonnement ChatGPT du vérificateur (code à saisir sur le site d'OpenAI) ----------
let connexionChatGPT = null // { id, depuis }
const sansCouleurs = (t) => String(t ?? "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")

export async function connecterChatGPT(ctx, par) {
  const { config } = ctx
  try {
    const { id } = await lancerTravail(config.verificateur.url, config.secrets.worker, "env -u OPENAI_API_KEY codex login --device-auth 2>&1", { minutes: 16 })
    connexionChatGPT = { id, depuis: Date.now() }
  } catch (e) {
    if (e.occupe) return { ok: false, message: "Le vérificateur juge une tâche en ce moment : réessaie dans quelques minutes." }
    throw e
  }
  noter(ctx.db, { projet: null, type: "reglage", message: `Connexion ChatGPT du vérificateur demandée par ${par}` })
  return { ok: true, message: "Connexion lancée : le lien et le code arrivent." }
}

// Où en est la connexion : { etat: aucune|attente|code|connecte|echec, url, code }.
export async function etatChatGPT(ctx) {
  if (!connexionChatGPT) return { etat: "aucune" }
  const t = await etatTravail(ctx.config.verificateur.url, ctx.config.secrets.worker, connexionChatGPT.id).catch(() => null)
  if (!t) return { etat: "echec", message: "Le vérificateur a perdu la connexion (redémarré ?). Relance-la." }
  const texte = sansCouleurs(t.journal)
  const url = /(https:\/\/[^\s]+)/.exec(texte)?.[1] ?? null
  const code = /(?:^|\s)([A-Z0-9]{4,5}-[A-Z0-9]{4,5})(?:\s|$)/m.exec(texte)?.[1] ?? null
  if (t.etat !== "fini") return url && code ? { etat: "code", url, code } : { etat: "attente" }
  connexionChatGPT = null
  const r = await testerFournisseurs(ctx).catch(() => null)
  const ok = r?.tests?.resultats?.codex?.abonnement?.etat === "ok"
  return ok ? { etat: "connecte", message: "Le vérificateur est connecté à ChatGPT." } : { etat: "echec", message: "La connexion n'a pas abouti (code expiré ou refusé). Relance-la." }
}
