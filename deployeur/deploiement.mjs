// Les décisions du tour de déploiement, et l'attente de la santé d'un conteneur qui démarre.
// Sans Docker : testées par test/deploiement.test.mjs ; le déployeur (server.mjs) les appelle.

// Un déploiement interrompu (le déployeur a redémarré pendant qu'il le faisait : mise à jour de
// l'usine, plantage) est repris au plus deux fois. À la troisième interruption, il est noté en
// échec : un déploiement qui fait tomber le déployeur ne le relance pas sans fin.
export const REPRISES_MAX = 2

// Ce que le tour fait d'un souhait du dépôt d'état, vu son entrée dans statut.json :
//   "deployer"   une demande nouvelle (autre version, ou même version demandée de nouveau) ;
//   "reprendre"  la même demande, restée « en cours » : le déployeur a été interrompu ;
//   "abandonner" la même demande, interrompue plus de REPRISES_MAX fois ;
//   null         la demande est déjà appliquée (réussie ou en échec).
// Dans un même processus, un tour attend chaque déploiement : une entrée « en cours » lue au
// début d'un tour vient donc toujours d'un déployeur interrompu.
export function decisionDeploiement(actuel, souhait) {
  if (!actuel || actuel.demande_le !== souhait.demande_le) return "deployer"
  if (actuel.etat !== "en_cours") return actuel.sha === souhait.sha ? null : "deployer"
  if (actuel.sha_demande !== souhait.sha) return "deployer"
  return (actuel.reprises ?? 0) >= REPRISES_MAX ? "abandonner" : "reprendre"
}

// Attend qu'un conteneur qui démarre réponde à /api/health par un 2xx. Sans suivre de
// redirection, comme la sonde (sonderSante) : une réponse 3xx d'un produit ne doit pas faire
// appeler par le déployeur une autre adresse de ses réseaux. Une redirection n'est pas saine.
export async function attendreSante(url, { secondes = 90, intervalleMs = 3_000, delaiMs = 5_000 } = {}) {
  const limite = Date.now() + secondes * 1000
  while (Date.now() < limite) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(delaiMs), redirect: "manual" })
      await res.body?.cancel().catch(() => {})
      if (res.ok) return true
    } catch {}
    await new Promise((r) => setTimeout(r, intervalleMs))
  }
  return false
}
