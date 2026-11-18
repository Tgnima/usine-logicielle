// Appeler un modèle de langage depuis le produit. Deux chemins, dans l'ordre :
//   1. le serveur de modèles de l'usine (LLM_URL, API compatible OpenAI, par exemple llama-server
//      sur un GPU), avec un délai court : il n'a pas de garantie de disponibilité ;
//   2. la passerelle Vercel AI Gateway (AI_GATEWAY_API_KEY), si elle est branchée.
// Sans l'un ni l'autre (tests, hors ligne), ou si le serveur de modèles ne répond pas et qu'il n'y
// a pas de passerelle, on renvoie le texte de secours : le produit reste utilisable, et les tests
// ne touchent jamais le réseau. L'usine pose ces variables ; le produit n'en écrit aucune.
const PASSERELLE = "https://ai-gateway.vercel.sh/v1/chat/completions"
const DELAI_SERVEUR_MS = 30_000
const DELAI_PASSERELLE_MS = 60_000

// Certains modèles (Qwen3…) écrivent leur raisonnement entre <think> et </think> : seule la
// réponse sert.
export const sansRaisonnement = (t) => String(t ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*<\/think>/, "").trim()

async function appeler(envoyer, url, cle, modele, messages, delaiMs) {
  const res = await envoyer(url, {
    method: "POST",
    headers: { ...(cle ? { authorization: `Bearer ${cle}` } : {}), "content-type": "application/json" },
    body: JSON.stringify({ ...(modele ? { model: modele } : {}), messages }),
    signal: AbortSignal.timeout(delaiMs),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(`Modèle indisponible (${res.status}) : ${json.error?.message ?? ""}`), { status: 502 })
  return sansRaisonnement(json.choices?.[0]?.message?.content)
}

// env et envoyer : pour les tests seulement. Avec le vrai fetch, un test ne sort jamais.
export async function generer({ systeme, demande, modele, secours = "", env = process.env, envoyer = fetch }) {
  if (env.NODE_TEST_CONTEXT && envoyer === fetch) return { texte: secours, modele: "secours" }
  const messages = [...(systeme ? [{ role: "system", content: systeme }] : []), { role: "user", content: demande }]
  const cle = env.AI_GATEWAY_API_KEY
  if (env.LLM_URL) {
    const nom = env.LLM_LOCAL_MODELE || ""
    try {
      const texte = await appeler(envoyer, `${env.LLM_URL.replace(/\/+$/, "")}/chat/completions`, env.LLM_CLE, nom, messages, DELAI_SERVEUR_MS)
      if (texte) return { texte, modele: nom || "serveur de modèles" }
      throw new Error("réponse vide")
    } catch (e) {
      // Jamais l'adresse du serveur dans le journal : seulement ce qui s'est passé.
      console.warn(`Serveur de modèles indisponible (${e.name === "TimeoutError" ? "délai dépassé" : e.message}) : ${cle ? "la passerelle prend le relais" : "texte de secours"}.`)
      if (!cle) return { texte: secours, modele: "secours" }
    }
  }
  if (!cle) return { texte: secours, modele: "secours" }
  const choisi = modele || env.LLM_MODELE || "anthropic/claude-haiku-4.5"
  return { texte: await appeler(envoyer, PASSERELLE, cle, choisi, messages, DELAI_PASSERELLE_MS), modele: choisi }
}
