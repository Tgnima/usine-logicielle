// Appeler un modèle de langage depuis le produit, via Vercel AI Gateway (API
// compatible OpenAI). Sans clé (tests, hors ligne), on renvoie le texte de
// secours : le produit reste utilisable et les tests ne touchent jamais le réseau.
import { randomUUID } from "node:crypto"
import { posthog } from "./posthog.js"

const PASSERELLE = "https://ai-gateway.vercel.sh/v1/chat/completions"
const sessionAi = `process-${randomUUID()}`
const distinctIdAi = `anonymous-ai-${sessionAi}`

function fournisseur(modele) {
  return modele.split("/", 1)[0] || "vercel-ai-gateway"
}

function enregistrerGeneration({ traceId, messages, modele, res, json, debut, erreur }) {
  const contenu = posthog?.privacyMode
    ? {}
    : {
        $ai_input: messages,
        $ai_output_choices: json.choices?.map(({ message }) => message).filter(Boolean),
      }
  const erreurAi = erreur instanceof Error ? (posthog?.privacyMode ? erreur.name : erreur.message) : undefined

  try {
    posthog?.capture({
      distinctId: distinctIdAi,
      event: "$ai_generation",
      properties: {
        $ai_trace_id: traceId,
        $ai_session_id: sessionAi,
        $ai_span_name: "chat_completion",
        $ai_model: modele,
        $ai_provider: fournisseur(modele),
        ...contenu,
        $ai_input_tokens: json.usage?.prompt_tokens ?? json.usage?.input_tokens,
        $ai_output_tokens: json.usage?.completion_tokens ?? json.usage?.output_tokens,
        $ai_latency: (Date.now() - debut) / 1000,
        $ai_http_status: res?.status,
        $ai_request_url: PASSERELLE,
        $ai_is_error: Boolean(erreur),
        $ai_error: erreurAi,
        $ai_stop_reason: json.choices?.[0]?.finish_reason,
      },
    })
  } catch {
    // L'observabilité ne doit jamais modifier le résultat du modèle.
  }
}

export async function generer({ systeme, demande, modele = process.env.LLM_MODELE ?? "anthropic/claude-haiku-4.5", secours = "" }) {
  const cle = process.env.AI_GATEWAY_API_KEY
  if (!cle || process.env.NODE_TEST_CONTEXT) return { texte: secours, modele: "secours" }

  const messages = [...(systeme ? [{ role: "system", content: systeme }] : []), { role: "user", content: demande }]
  const traceId = randomUUID()
  const debut = Date.now()
  let res
  let json = {}

  try {
    res = await fetch(PASSERELLE, {
      method: "POST",
      headers: { authorization: `Bearer ${cle}`, "content-type": "application/json" },
      body: JSON.stringify({ model: modele, messages }),
      signal: AbortSignal.timeout(60_000),
    })
    json = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(`Modèle indisponible (${res.status}) : ${json.error?.message ?? ""}`), { status: 502 })
  } catch (erreur) {
    enregistrerGeneration({ traceId, messages, modele, res, json, debut, erreur })
    throw erreur
  }

  enregistrerGeneration({ traceId, messages, modele, res, json, debut })
  return { texte: String(json.choices?.[0]?.message?.content ?? "").trim(), modele }
}
