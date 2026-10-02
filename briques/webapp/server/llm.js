// Appeler un modèle de langage depuis le produit, via Vercel AI Gateway (API
// compatible OpenAI). Sans clé (tests, hors ligne), on renvoie le texte de
// secours : le produit reste utilisable et les tests ne touchent jamais le réseau.
const PASSERELLE = "https://ai-gateway.vercel.sh/v1/chat/completions"

export async function generer({ systeme, demande, modele = process.env.LLM_MODELE ?? "anthropic/claude-haiku-4.5", secours = "" }) {
  const cle = process.env.AI_GATEWAY_API_KEY
  if (!cle || process.env.NODE_TEST_CONTEXT) return { texte: secours, modele: "secours" }
  const res = await fetch(PASSERELLE, {
    method: "POST",
    headers: { authorization: `Bearer ${cle}`, "content-type": "application/json" },
    body: JSON.stringify({ model: modele, messages: [...(systeme ? [{ role: "system", content: systeme }] : []), { role: "user", content: demande }] }),
    signal: AbortSignal.timeout(60_000),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw Object.assign(new Error(`Modèle indisponible (${res.status}) : ${json.error?.message ?? ""}`), { status: 502 })
  return { texte: String(json.choices?.[0]?.message?.content ?? "").trim(), modele }
}
