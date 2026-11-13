# Journal des versions

Chaque version publiée est une étiquette `vX.Y.Z` sur GitHub. Pour mettre une usine à jour :
le bouton « Mettre à jour l'usine » (console ou Slack), ou `bash update.sh` sur le serveur.
Le bloc **À faire** de chaque version liste les gestes à faire à la main ; s'il est vide, il
n'y a rien à faire.

Numérotation : `X` change quand une mise à jour demande un geste à la main ou casse une habitude,
`Y` pour une nouveauté, `Z` pour une correction.

## Non publié

Ce qui est sur `main` sans être encore dans une version.

- **Déconnexion** : un bouton « Se déconnecter » dans la console. `/_portier/deconnexion`, sur
  chaque adresse protégée, ferme aussi la session côté serveur : le même cookie, rejoué ensuite,
  est refusé. Un lien venu d'un autre site demande confirmation. Les sessions ouvertes avant cette
  version restent valables jusqu'à leur expiration (personne n'est déconnecté par la mise à jour).
- **Correction** : le chemin de retour de la page de connexion ne peut plus mener vers un autre site
  (une tabulation, retirée par le navigateur, le permettait).

- **Emails de l'usine toujours chiffrés** : hors TLS direct (port 465), STARTTLS est désormais
  exigé. Un serveur d'envoi qui ne le propose pas est refusé avant l'envoi du mot de passe.

**À faire** : rien. La table du portier se crée toute seule au démarrage. Si les invitations
partaient par un serveur d'envoi sans chiffrement, choisis TLS direct (port 465) ou un autre
serveur, puis lance « Tester » (Réglages, Intégrations, Envoi d'emails).

## v1.0.0

La première version publiée. Elle rassemble tout ce qui a été fusionné jusqu'au 13 novembre 2026.

- **Versions et mises à jour** : le canal `CANAL_USINE` (`stable` par défaut : seulement les
  versions publiées ; `main` : chaque fusion), `update.sh` (attend la fin de la tâche en cours,
  crée les secrets manquants, reconstruit, reprend), et des tests lancés sur chaque PR (GitHub Actions).
- **Installation** : GitHub se branche depuis la console ; `install.sh` ne l'exige plus.
- **Sécurité** (`docs/SECURITE.md`) : un réseau Docker par produit, un jeton propre à l'atelier et
  au vérificateur, et Slack fermé tant que `ADMIN_USER_IDS` est vide. Les marqueurs de la porte de
  fusion ne peuvent plus être imités, et le portier est durci.
- **Observabilité** : Sentry et PostHog pour l'usine et ses produits, une sonde de l'état réel de
  chaque application, et la page Visibilité de la console.
- **Fabrication** : un kit shadcn/ui dans les briques avec une page `/kit`, la cohérence entre
  écrans, des relectures design avec leurs motifs, et un navigateur en français pour les captures.

**À faire** sur une usine installée avant cette version :

- `bash secrets.sh migrer` (sans `sudo`), pour créer `atelier_token` et `verificateur_token`.
- Vérifier que `ADMIN_USER_IDS` contient les identifiants Slack des administrateurs.
- Sur le serveur qui suit chaque fusion : `CANAL_USINE=main` dans `.env`, puis
  `docker compose up -d deployeur`.
- Facultatif : `SENTRY_DSN` et `POSTHOG_TOKEN` dans `.env`, puis `bash secrets.sh migrer`.
