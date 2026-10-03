// L'aiguillage d'une demande `/usine …` : un nouveau produit, ou une correction
// d'un produit déjà livré ? Un petit modèle (via Vercel AI Gateway) tranche ;
// sans clé ou en cas de doute, on demande à la personne. Jamais de décision
// coûteuse (un nouveau projet) sur une supposition.
const PASSERELLE = "https://ai-gateway.vercel.sh/v1/chat/completions"
const MODELE = "anthropic/claude-haiku-4.5"

// Les produits auxquels une correction peut s'appliquer.
export const produitsCorrigeables = (db) => db.prepare("SELECT id, nom, slug, prompt, statut FROM projets WHERE statut IN ('livre', 'en_production') ORDER BY id DESC").all()

// Renvoie { type: "nouveau" } | { type: "correction", projetId } | { type: "incertain", candidats }.
export async function aiguiller(db, texte) {
  const produits = produitsCorrigeables(db)
  if (produits.length === 0) return { type: "nouveau" }
  // Le nom ou l'adresse d'un produit cité tel quel : c'est une correction.
  const t = texte.toLowerCase()
  const cite = produits.filter((p) => (p.nom && t.includes(p.nom.toLowerCase())) || (p.slug && t.includes(p.slug)))
  if (cite.length === 1) return { type: "correction", projetId: cite[0].id }
  const cle = process.env.AI_GATEWAY_API_KEY
  if (!cle) return { type: "incertain", candidats: produits }
  try {
    const liste = produits.map((p) => `${p.id}. ${p.nom} (${p.statut}) : ${p.prompt.slice(0, 200)}`).join("\n")
    const res = await fetch(PASSERELLE, {
      method: "POST",
      headers: { authorization: `Bearer ${cle}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: MODELE,
        messages: [
          { role: "system", content: "Tu aiguilles les demandes d'une usine logicielle. Réponds uniquement par un objet JSON." },
          { role: "user", content: `Produits déjà livrés :\n${liste}\n\nDemande reçue :\n<demande>\n${texte}\n</demande>\n\nCette demande décrit-elle un NOUVEAU produit à construire, ou signale-t-elle un problème / demande-t-elle une évolution d'un produit existant (même sans le nommer : « l'ancienne production », « l'app », « les mails ne partent pas »…) ?\nRéponds : {"type": "nouveau"} ou {"type": "correction", "projet": <numéro>} ou {"type": "incertain"}` },
        ],
      }),
      signal: AbortSignal.timeout(20_000),
    })
    const json = await res.json()
    const contenu = String(json.choices?.[0]?.message?.content ?? "")
    const r = JSON.parse(contenu.slice(contenu.indexOf("{"), contenu.lastIndexOf("}") + 1))
    if (r.type === "nouveau") return { type: "nouveau" }
    if (r.type === "correction" && produits.some((p) => p.id === Number(r.projet))) return { type: "correction", projetId: Number(r.projet) }
  } catch (error) {
    console.error("Aiguillage :", error.message)
  }
  return { type: "incertain", candidats: produits }
}
