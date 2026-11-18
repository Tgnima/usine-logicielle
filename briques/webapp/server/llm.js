// Appeler un modèle de langage depuis le produit. Deux chemins, dans l'ordre :
//   1. le serveur de modèles de l'usine (LLM_URL, API compatible OpenAI, par exemple llama-server
//      sur un GPU), avec un délai court : il n'a pas de garantie de disponibilité. Après un échec,
//      on ne le réessaie pas pendant quelques minutes : les pages ne restent pas suspendues à lui ;
//   2. la passerelle Vercel AI Gateway (AI_GATEWAY_API_KEY), si elle est branchée.
// Si aucun ne répond (ou sans l'un ni l'autre, dans les tests, hors ligne), on renvoie le texte de
// secours : le produit ne tombe jamais en panne à cause de l'IA, et les tests ne touchent jamais le
// réseau. L'usine pose ces variables ; le produit n'en écrit aucune.
//
// `modele` choisit le modèle de la passerelle. Le serveur de modèles passe avant ; pour une demande
// qui exige la passerelle (un gros modèle, un long contexte), passer `serveurLocal: false`.
const PASSERELLE = "https://ai-gateway.vercel.sh/v1/chat/completions"
const DELAI_SERVEUR_MS = 30_000
const DELAI_PASSERELLE_MS = 60_000
const PAUSE_APRES_PANNE_MS = 5 * 60_000

let serveurEnPanneJusqua = 0
// Pour les tests : oublier une panne du serveur de modèles.
export const oublierPanne = () => { serveurEnPanneJusqua = 0 }

// Certains modèles (Qwen3…) écrivent leur raisonnement entre <think> et </think> : seule la
// réponse sert. Une réponse coupée en plein raisonnement (sans balise fermante) ne montre rien.
export const sansRaisonnement = (t) => String(t ?? "")
  .replace(/<think>[\s\S]*?<\/think>/g, "")
  .replace(/^[\s\S]*<\/think>/, "")
  .replace(/<think>[\s\S]*$/, "")
  .trim()

async function appeler(envoyer, url, cle, modele, messages, delaiMs) {
  const res = await envoyer(url, {
    method: "POST",
    headers: { ...(cle ? { authorization: `Bearer ${cle}` } : {}), "content-type": "application/json" },
    body: JSON.stringify({ ...(modele ? { model: modele } : {}), messages }),
    signal: AbortSignal.timeout(delaiMs),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: res.status })
  return sansRaisonnement(json.choices?.[0]?.message?.content)
}

// Ce qui part au journal : jamais l'adresse ni le texte d'erreur du serveur, seulement ce qui s'est passé.
const cause = (e) => (e?.name === "TimeoutError" ? "délai dépassé" : e?.code ? `HTTP ${e.code}` : "injoignable")

// env, envoyer et maintenant : pour les tests seulement. Avec le vrai fetch, un test ne sort jamais.
export async function generer({ systeme, demande, modele, secours = "", serveurLocal = true, env = process.env, envoyer = fetch, maintenant = Date.now }) {
  if ((process.env.NODE_TEST_CONTEXT || env.NODE_TEST_CONTEXT) && envoyer === fetch) return { texte: secours, modele: "secours" }
  const messages = [...(systeme ? [{ role: "system", content: systeme }] : []), { role: "user", content: demande }]
  const cle = env.AI_GATEWAY_API_KEY
  if (serveurLocal && env.LLM_URL && maintenant() >= serveurEnPanneJusqua) {
    const nom = env.LLM_LOCAL_MODELE || ""
    try {
      const texte = await appeler(envoyer, `${env.LLM_URL.replace(/\/+$/, "")}/chat/completions`, env.LLM_CLE, nom, messages, DELAI_SERVEUR_MS)
      if (texte) return { texte, modele: nom || "serveur de modèles" }
      console.warn(`Serveur de modèles : réponse vide, ${cle ? "la passerelle prend le relais" : "texte de secours"}.`)
    } catch (e) {
      serveurEnPanneJusqua = maintenant() + PAUSE_APRES_PANNE_MS
      console.warn(`Serveur de modèles indisponible (${cause(e)}) : ${cle ? "la passerelle prend le relais" : "texte de secours"}, nouvel essai dans 5 minutes.`)
    }
  }
  if (!cle) return { texte: secours, modele: "secours" }
  const choisi = modele || env.LLM_MODELE || "anthropic/claude-haiku-4.5"
  try {
    return { texte: await appeler(envoyer, PASSERELLE, cle, choisi, messages, DELAI_PASSERELLE_MS), modele: choisi }
  } catch (e) {
    // Plafond de dépense atteint, quota, panne : le produit garde son texte de secours.
    console.warn(`Passerelle IA indisponible (${cause(e)}) : texte de secours.`)
    return { texte: secours, modele: "secours" }
  }
}
