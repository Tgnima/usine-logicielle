# Usine logicielle

Du prompt au produit en ligne, piloté depuis Slack. Voir `README.md`.

## Où sont les choses

| Fichier | Rôle |
|---|---|
| `orchestrateur/src/analyste.mjs` | Étage 1 : prompt → plan JSON, vérifié par `verifierPlan()` |
| `orchestrateur/src/creation.mjs` | Dépôt du produit depuis la brique, issues, lots ajoutés |
| `orchestrateur/src/fabrique.mjs` | Étage 2 : la boucle issue → agent → contrôle → PR → vérification → fusion |
| `orchestrateur/src/verification.mjs` | Le vérificateur indépendant et `porte()`, la décision de fusion |
| `orchestrateur/src/escalade.mjs` | Issues bloquantes, options A/B/C, surveillance des réponses |
| `orchestrateur/src/livraison.mjs` | Étage 3 : aperçus, rapport final, production, corrections |
| `orchestrateur/src/pipeline.mjs` | Les actions (Slack, CLI) |
| `orchestrateur/src/slack.mjs` | Slack, et le notificateur console sans Slack |
| `deployeur/server.mjs` | Tire le dépôt d'état, construit, déploie (blue/green), Caddy (portier devant chaque site) |
| `portier/server.mjs` | La page de connexion (forward_auth), sessions, invitations, comptes |
| `secrets.sh` | Les secrets chiffrés (SOPS + age), déchiffrés en mémoire au démarrage |
| `orchestrateur/src/relectures.mjs` | Les relectures entre agents (sécurité) avant le vérificateur |
| `commun/serveur-travaux.mjs` | Le serveur de travaux de l'atelier et du vérificateur |
| `briques/webapp/` | Le point de départ de chaque produit, et ses conventions (`AGENTS.md`) |
| `usine.config.yml` | Le contrat (non suivi par Git, créé depuis l'exemple) |

## Règles pour modifier le code

- **Toujours protéger les applications.** Toute nouvelle adresse publiée passe par le portier
  (`blocSite()` dans le déployeur) ; tout nouveau secret va dans `SECRETS` (`secrets.sh`) et
  dans `docker-compose.yml` (section `secrets:`), jamais dans `.env` ni dans l'environnement.

- Node ES modules, sans framework. Dépendances : `@slack/bolt`, `yaml` et `nodemailer` (orchestrateur, pour les invitations) ; aucune ailleurs.
- **Une décision de fusion ou de mise en production est prise par du code**, jamais par un modèle.
  Toute nouvelle règle de refus va dans `porte()`, avec son test dans `orchestrateur/test/`.
- Les agents ne reçoivent jamais le jeton GitHub, ni Slack. Le jeton ne passe que par la variable
  `JETON` des étapes de clone et de push, et il est masqué dans les journaux.
- Seul le déployeur accède à Docker. N'ajoute jamais le socket Docker à un autre conteneur.
- Ce qui arrive du dépôt d'état est validé (`valide()`) avant d'atteindre Docker ; les commandes
  sont lancées sans shell.
- Les outils s'installent en dernière version (`@latest`) : après une reconstruction, on teste un projet.
- Les scripts envoyés aux serveurs de travaux s'écrivent avec `q()` et `ecrireFichier()` (travaux.mjs).
- Commentaires et messages en français.
- Tests : `cd orchestrateur && npm test`.
