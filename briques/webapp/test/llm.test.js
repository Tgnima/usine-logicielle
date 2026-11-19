// L'IA du produit (server/llm.js) : le serveur de modèles de l'usine d'abord, puis la passerelle,
// puis le texte de secours, sans jamais faire tomber le produit. Aucun appel réseau : un faux
// « fetch » répond.
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { generer, oublierPanne, sansRaisonnement } from "../server/llm.js"

beforeEach(() => oublierPanne())
const reponse = (contenu, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content: contenu } }], error: { message: "détail interne du serveur" } }), { status })
// Un faux fetch qui note chaque appel et répond selon l'adresse.
function faux(regles) {
  const appels = []
  const envoyer = async (url, o) => {
    appels.push({ url, auth: o.headers.authorization ?? null, corps: JSON.parse(o.body) })
    for (const [motif, r] of regles) if (url.includes(motif)) return typeof r === "function" ? r() : r
    throw new Error("adresse inattendue")
  }
  return { envoyer, appels }
}
const SERVEUR = "https://modeles.exemple.test/v1/"
const lent = () => { throw Object.assign(new Error("délai"), { name: "TimeoutError" }) }
// Les avertissements du produit, le temps d'un appel.
async function avertissements(f) {
  const vus = []
  const avant = console.warn
  console.warn = (m) => vus.push(String(m))
  try {
    return { r: await f(), vus }
  } finally {
    console.warn = avant
  }
}

test("le serveur de modèles répond : il sert, avec sa clé et son modèle", async () => {
  const { envoyer, appels } = faux([["modeles.exemple.test", reponse("Résumé du serveur")]])
  const r = await generer({ systeme: "Sois bref", demande: "Résume", secours: "secours", env: { LLM_URL: SERVEUR, LLM_CLE: "cle-serveur", LLM_LOCAL_MODELE: "qwen", AI_GATEWAY_API_KEY: "cle-passerelle" }, envoyer })
  assert.deepEqual(r, { texte: "Résumé du serveur", modele: "qwen" })
  assert.equal(appels.length, 1)
  assert.equal(appels[0].url, "https://modeles.exemple.test/v1/chat/completions")
  assert.equal(appels[0].auth, "Bearer cle-serveur")
  assert.equal(appels[0].corps.model, "qwen")
  assert.deepEqual(appels[0].corps.messages.map((m) => m.role), ["system", "user"])
})

test("le serveur de modèles tombe : la passerelle prend le relais, avec son propre modèle", async () => {
  const { envoyer, appels } = faux([["modeles.exemple.test", reponse("", 503)], ["ai-gateway.vercel.sh", reponse("Résumé de la passerelle")]])
  const r = await generer({ demande: "Résume", env: { LLM_URL: SERVEUR, AI_GATEWAY_API_KEY: "cle-passerelle", LLM_MODELE: "anthropic/claude-haiku-4.5" }, envoyer })
  assert.deepEqual(r, { texte: "Résumé de la passerelle", modele: "anthropic/claude-haiku-4.5" })
  assert.equal(appels.length, 2)
  assert.equal(appels[1].auth, "Bearer cle-passerelle")
})

test("le serveur de modèles tombe et pas de passerelle : le texte de secours, sans erreur ni détail au journal", async () => {
  const { envoyer } = faux([["modeles.exemple.test", reponse("", 500)]])
  const { r, vus } = await avertissements(() => generer({ demande: "Résume", secours: "Texte prévu", env: { LLM_URL: SERVEUR }, envoyer }))
  assert.deepEqual(r, { texte: "Texte prévu", modele: "secours" })
  assert.match(vus.join(), /indisponible \(HTTP 500\)/)
  assert.ok(!vus.join().includes("modeles.exemple.test") && !vus.join().includes("détail interne"), "ni l'adresse ni le texte du serveur")
})

test("après une panne, le serveur de modèles n'est pas réessayé pendant 5 minutes", async () => {
  let t = 1_000_000
  const maintenant = () => t
  const { envoyer, appels } = faux([["modeles.exemple.test", lent], ["ai-gateway.vercel.sh", reponse("Passerelle")]])
  const env = { LLM_URL: SERVEUR, AI_GATEWAY_API_KEY: "cle-passerelle" }
  await avertissements(() => generer({ demande: "1", env, envoyer, maintenant }))
  t += 60_000
  await avertissements(() => generer({ demande: "2", env, envoyer, maintenant }))
  assert.deepEqual(appels.map((a) => new URL(a.url).hostname), ["modeles.exemple.test", "ai-gateway.vercel.sh", "ai-gateway.vercel.sh"], "le second appel va droit à la passerelle")
  t += 5 * 60_000
  await avertissements(() => generer({ demande: "3", env, envoyer, maintenant }))
  assert.equal(new URL(appels.at(-2).url).hostname, "modeles.exemple.test", "5 minutes plus tard, on réessaie")
})

test("une demande refusée pour elle-même (trop longue) ne met pas le serveur en pause ; une réponse vide, si", async () => {
  let t = 1_000_000
  const maintenant = () => t
  const env = { LLM_URL: SERVEUR }
  const trop = faux([["modeles.exemple.test", reponse("", 400)]])
  await avertissements(() => generer({ demande: "très long", secours: "S", env, envoyer: trop.envoyer, maintenant }))
  await avertissements(() => generer({ demande: "court", secours: "S", env, envoyer: trop.envoyer, maintenant }))
  assert.equal(trop.appels.length, 2, "après un 400, le serveur est réessayé tout de suite")
  const vide = faux([["modeles.exemple.test", reponse("")]])
  await avertissements(() => generer({ demande: "1", secours: "S", env, envoyer: vide.envoyer, maintenant }))
  t += 60_000
  await avertissements(() => generer({ demande: "2", secours: "S", env, envoyer: vide.envoyer, maintenant }))
  assert.equal(vide.appels.length, 1, "après une réponse vide, pause de 5 minutes")
})

test("la passerelle répond vide : le texte de secours", async () => {
  const { envoyer } = faux([["ai-gateway.vercel.sh", reponse("<think>coupé")]])
  const { r } = await avertissements(() => generer({ demande: "Résume", secours: "S", env: { AI_GATEWAY_API_KEY: "cle-passerelle" }, envoyer }))
  assert.deepEqual(r, { texte: "S", modele: "secours" })
})

test("la passerelle échoue (plafond atteint, quota, panne) : le texte de secours, jamais une erreur", async () => {
  for (const r of [reponse("", 402), reponse("", 429), lent]) {
    const { envoyer } = faux([["ai-gateway.vercel.sh", r]])
    const { r: res, vus } = await avertissements(() => generer({ demande: "Résume", secours: "S", env: { AI_GATEWAY_API_KEY: "cle-passerelle" }, envoyer }))
    assert.deepEqual(res, { texte: "S", modele: "secours" })
    assert.match(vus.join(), /Passerelle IA indisponible/)
  }
})

test("une réponse vide du serveur de modèles ne compte pas", async () => {
  const { envoyer } = faux([["modeles.exemple.test", reponse("  ")]])
  const { r } = await avertissements(() => generer({ demande: "Résume", secours: "Texte prévu", env: { LLM_URL: SERVEUR }, envoyer }))
  assert.deepEqual(r, { texte: "Texte prévu", modele: "secours" })
})

test("sans serveur de modèles, la passerelle comme avant ; un LLM_MODELE vide garde le modèle par défaut", async () => {
  const { envoyer, appels } = faux([["ai-gateway.vercel.sh", reponse("ok")]])
  const r = await generer({ demande: "Résume", env: { AI_GATEWAY_API_KEY: "cle-passerelle", LLM_MODELE: "" }, envoyer })
  assert.equal(r.modele, "anthropic/claude-haiku-4.5")
  assert.equal(appels[0].corps.model, "anthropic/claude-haiku-4.5")
})

test("serveurLocal: false exige la passerelle, avec le modèle demandé", async () => {
  const { envoyer, appels } = faux([["modeles.exemple.test", reponse("local")], ["ai-gateway.vercel.sh", reponse("gros modèle")]])
  const r = await generer({ demande: "Analyse", modele: "anthropic/claude-sonnet-4.5", serveurLocal: false, env: { LLM_URL: SERVEUR, AI_GATEWAY_API_KEY: "cle-passerelle" }, envoyer })
  assert.deepEqual(r, { texte: "gros modèle", modele: "anthropic/claude-sonnet-4.5" })
  assert.equal(appels.length, 1)
})

test("ni serveur ni passerelle, ou dans les tests avec le vrai fetch : le texte de secours, sans réseau", async () => {
  assert.deepEqual(await generer({ demande: "Résume", secours: "S", env: {} }), { texte: "S", modele: "secours" })
  // Sous node --test, même un env injecté sans NODE_TEST_CONTEXT ne sort pas avec le fetch global :
  // un espion à sa place prouve qu'il n'est jamais appelé.
  assert.ok(process.env.NODE_TEST_CONTEXT, "ce test suppose node --test")
  const vrai = globalThis.fetch
  let sorties = 0
  globalThis.fetch = async () => { sorties++; throw new Error("réseau interdit dans les tests") }
  try {
    assert.deepEqual(await generer({ demande: "Résume", secours: "S", env: { LLM_URL: SERVEUR, AI_GATEWAY_API_KEY: "x" } }), { texte: "S", modele: "secours" })
  } finally {
    globalThis.fetch = vrai
  }
  assert.equal(sorties, 0)
})

test("le raisonnement d'un modèle (<think>) n'est jamais montré", () => {
  assert.equal(sansRaisonnement("<think>je réfléchis</think>\n\nLa réponse."), "La réponse.")
  assert.equal(sansRaisonnement("raisonnement sans balise ouvrante</think>La réponse."), "La réponse.")
  assert.equal(sansRaisonnement("<think>réponse coupée en plein raisonnement"), "")
  assert.equal(sansRaisonnement("Rien à retirer."), "Rien à retirer.")
})
