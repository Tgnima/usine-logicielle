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

// Les entrées de statut.json après un déploiement. boite : la version des clés de la console que
// le conteneur a reçue dans son fichier d'environnement, lue au début de son démarrage (jamais
// celle du moment où l'on écrit : la console a pu changer pendant l'attente de sa santé).
export const statutEnLigne = (s, r, le) => ({ etat: "ok", sha: s.sha, demande_le: s.demande_le, hote: s.hote, hote_mails: s.hote_mails ?? null, acces: s.acces ?? "protege", chemins_publics: r.publics ?? [], conteneur: r.conteneur, couleur: r.couleur ?? null, boite: r.boite ?? null, le })
// L'ancienne version d'un produit, gardée dans le statut quand la nouvelle échoue : elle reste
// servie, avec les clés qu'elle avait reçues (boite), pour que la console la compte en retard.
export const versionServie = (actuel) => (actuel?.conteneur ? { hote: actuel.hote, hote_mails: actuel.hote_mails, conteneur: actuel.conteneur, couleur: actuel.couleur, boite: actuel.boite ?? null } : {})

// La mise à jour de l'usine, avant de toucher au dépôt : chaque secret que la version CIBLE de
// docker-compose.yml attend doit exister sur le serveur (/run/usine-secrets, écrit par
// « bash secrets.sh dechiffrer »). Sinon la mise à jour s'arrête (code 3), avec la commande à
// lancer, et rien ne change : « docker compose up » ne trouve jamais un secret absent. Le
// conteneur d'aide ne voit pas ce dossier : un conteneur de l'image du déployeur le regarde, sans
// réseau, en lecture seule, et ne lit que l'existence des fichiers. Si cette vérification ne peut
// pas se faire (Docker indisponible), elle ne bloque pas.
export function scriptVerifierSecrets(usineDir, image) {
  return [
    `attendus=$( (git -c safe.directory=${usineDir} show refs/remotes/github/cible:docker-compose.yml || true) | grep -oE '/run/usine-secrets/[a-z0-9_]+' | sed 's#.*/##' | sort -u | tr '\\n' ' ' || true)`,
    `if [ -n "$attendus" ] && manquants=$(docker run --rm --network none -v /run/usine-secrets:/s:ro --entrypoint sh ${image} -c 'for f; do [ -e "/s/$f" ] || printf "%s " "$f"; done' _ $attendus) && [ -n "$manquants" ]; then`,
    `  echo "Secrets absents du serveur : $manquants. Lancer « bash secrets.sh dechiffrer » dans ${usineDir}, puis relancer la mise à jour. Rien n'a changé."`,
    "  exit 3",
    "fi",
  ]
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
