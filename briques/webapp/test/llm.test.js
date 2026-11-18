// L'IA du produit (server/llm.js) : le serveur de modèles de l'usine d'abord, puis la passerelle,
// puis le texte de secours. Aucun appel réseau : un faux « fetch » répond.
import { test } from "node:test"
import assert from "node:assert/strict"
import { generer, sansRaisonnement } from "../server/llm.js"

const reponse = (contenu, status = 200) => new Response(JSON.stringify({ choices: [{ message: { content: contenu } }] }), { status })
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

test("le serveur de modèles tombe et pas de passerelle : le texte de secours, sans erreur", async () => {
  const { envoyer } = faux([["modeles.exemple.test", () => { throw Object.assign(new Error("délai"), { name: "TimeoutError" }) }]])
  assert.deepEqual(await generer({ demande: "Résume", secours: "Texte prévu", env: { LLM_URL: SERVEUR }, envoyer }), { texte: "Texte prévu", modele: "secours" })
})

test("une réponse vide du serveur de modèles ne compte pas", async () => {
  const { envoyer } = faux([["modeles.exemple.test", reponse("  ")]])
  assert.deepEqual(await generer({ demande: "Résume", secours: "Texte prévu", env: { LLM_URL: SERVEUR }, envoyer }), { texte: "Texte prévu", modele: "secours" })
})

test("sans serveur de modèles, la passerelle comme avant ; un LLM_MODELE vide garde le modèle par défaut", async () => {
  const { envoyer, appels } = faux([["ai-gateway.vercel.sh", reponse("ok")]])
  const r = await generer({ demande: "Résume", env: { AI_GATEWAY_API_KEY: "cle-passerelle", LLM_MODELE: "" }, envoyer })
  assert.equal(r.modele, "anthropic/claude-haiku-4.5")
  assert.equal(appels[0].corps.model, "anthropic/claude-haiku-4.5")
  const erreur = faux([["ai-gateway.vercel.sh", reponse("", 500)]])
  await assert.rejects(generer({ demande: "Résume", env: { AI_GATEWAY_API_KEY: "cle-passerelle" }, envoyer: erreur.envoyer }), /Modèle indisponible \(500\)/)
})

test("ni serveur ni passerelle, ou dans les tests avec le vrai fetch : le texte de secours, sans réseau", async () => {
  assert.deepEqual(await generer({ demande: "Résume", secours: "S", env: {} }), { texte: "S", modele: "secours" })
  assert.deepEqual(await generer({ demande: "Résume", secours: "S", env: { NODE_TEST_CONTEXT: "child", LLM_URL: SERVEUR, AI_GATEWAY_API_KEY: "x" } }), { texte: "S", modele: "secours" })
})

test("le raisonnement d'un modèle (<think>) est retiré de la réponse", () => {
  assert.equal(sansRaisonnement("<think>je réfléchis</think>\n\nLa réponse."), "La réponse.")
  assert.equal(sansRaisonnement("raisonnement sans balise ouvrante</think>La réponse."), "La réponse.")
  assert.equal(sansRaisonnement("Rien à retirer."), "Rien à retirer.")
})
