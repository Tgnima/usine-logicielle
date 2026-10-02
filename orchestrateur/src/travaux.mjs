// Parler au serveur de travaux d'un atelier ou du vérificateur.
const pause = (ms) => new Promise((r) => setTimeout(r, ms))

async function appel(serveur, jeton, chemin, init = {}) {
  const res = await fetch(`${serveur}${chemin}`, {
    ...init,
    headers: { authorization: `Bearer ${jeton}`, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(20_000),
  })
  return { statut: res.status, corps: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text() }
}

// Lance un script et attend sa fin. Renvoie { code, journal, marqueurs, duree_s }.
// env : variables passées au seul script (un jeton GitHub, par exemple).
export async function executer(serveur, jeton, script, { env = {}, minutes = 30, surAvancement } = {}) {
  let lance
  for (let essai = 0; ; essai++) {
    lance = await appel(serveur, jeton, "/travaux", { method: "POST", body: JSON.stringify({ script, env, minutes }) })
    if (lance.statut !== 409) break
    if (essai > 400) throw new Error(`${serveur} reste occupé.`)
    await pause(10_000)
  }
  if (lance.statut !== 202) throw new Error(`${serveur} a refusé le travail (${lance.statut} ${JSON.stringify(lance.corps)}).`)
  const id = lance.corps.id
  const limite = Date.now() + (minutes + 3) * 60_000
  while (Date.now() < limite) {
    await pause(5_000)
    const { statut, corps } = await appel(serveur, jeton, `/travaux/${id}?lignes=120`).catch(() => ({ statut: 0 }))
    if (statut === 0) continue // coupure passagère
    if (statut !== 200) throw new Error(`${serveur} a perdu le travail (${statut}).`)
    if (corps.etat === "fini") return corps
    surAvancement?.(corps)
  }
  throw new Error(`${serveur} : le travail n'a pas fini à temps.`)
}

export async function lireFichier(serveur, jeton, chemin) {
  const { statut, corps } = await appel(serveur, jeton, `/fichier?chemin=${encodeURIComponent(chemin)}`)
  return statut === 200 ? corps : null
}

export async function sante(serveur) {
  try {
    const res = await fetch(`${serveur}/sante`, { signal: AbortSignal.timeout(5_000) })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

// Une valeur glissée dans un script bash, entre apostrophes.
export const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`

// Un texte écrit dans un fichier par un script, sans risque d'interprétation.
export const ecrireFichier = (chemin, contenu) => `printf '%s' ${q(Buffer.from(contenu).toString("base64"))} | base64 -d > ${q(chemin)}`
