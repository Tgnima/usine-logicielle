# Industrialiser l'usine : l'offre pour un hébergeur

Ce document s'adresse à un fournisseur d'infrastructure (hébergeur, cloud régional,
intégrateur) qui voudrait proposer l'usine à ses clients : une équipe décrit un
logiciel dans Slack et le reçoit en ligne, testé, sécurisé et hébergé chez lui.

## L'offre en une phrase

« Décrivez votre outil métier dans Slack : vous validez le plan, l'usine le fabrique,
le teste et le met en ligne chez nous ; vous validez le résultat avant la production. »

Ce que l'hébergeur vend : des serveurs (l'usine et les produits tournent chez lui), un
service géré (installation, mises à jour, supervision) et, en option, de
l'accompagnement (cadrage des demandes, reprise du code par une équipe).

## Pour qui

| Client | Ce qu'il fait faire | Brique |
|---|---|---|
| PME sans équipe technique | outil métier, back-office, tableau de bord | `webapp` |
| Agence, indépendant | site vitrine avec formulaire, référencé | `site` |
| Éditeur, DSI | connecteur, API d'intégration entre deux logiciels | `api` |
| Équipe terrain | application mobile de saisie ou de suivi, installable | `pwa` |
| Équipe de développement | prototypes et outils internes, sans détourner l'équipe | toutes |

## Ce que le client reçoit

- **Un produit en ligne**, avec un aperçu à chaque étape, puis une production
  (bascule sans coupure, sauvegarde des données avant chaque mise en production).
- **Le code**, dans un dépôt GitHub qui lui appartient, avec le plan (`docs/PLAN.md`),
  le brief de design (`docs/DESIGN.md`) et une pull request par tâche, relue et testée.
- **Une page de connexion** devant chaque application (comptes par invitation, gérés
  depuis Slack) et des **clés d'API** pour les programmes. Aucune application n'est
  publique sans un choix explicite.
- **Son propre domaine** (`/usine domaine <n°> app.client.fr`) : l'usine donne
  l'enregistrement DNS, vérifie la propagation et pose le certificat HTTPS.
- **La maîtrise des coûts** : budgets par projet et par mois, alertes à 50, 80 et 100 %,
  tableau de bord.

## Les garanties (ce qui est décidé par du code, pas par un modèle)

- Aucune fusion sans : construction, tests (dont le nombre ne peut pas baisser), santé
  de l'application, critères observés par un vérificateur indépendant (autre famille de
  modèles), revue de sécurité, absence de secret dans le code, pas de nouvelle faille
  dans les dépendances, pas de régression sur ce qui marchait.
- Les fichiers qui jugent (tests de santé, sécurité de base, Dockerfile, plan) sont
  protégés : une tâche ne peut pas les affaiblir.
- Deux portes humaines : le plan, puis la production. La production n'est jamais
  déclenchée par un modèle.
- Aucune donnée de production n'est supprimée par l'usine.

## Architecture à déployer

```
            Slack (client)                         GitHub (client)
                 │                                       ▲
   ┌─────────────┼──────────── serveur usine ────────────┼──────────────┐
   │  orchestrateur ── atelier(s) (Claude Code) ── vérificateur (Codex)  │
   │        │                                                            │
   │  dépôt d'état ◄── déployeur (seul à piloter Docker) ──► produits    │
   │                        │                                            │
   │              Caddy (HTTPS) ── portier (connexion, clés d'API)       │
   └─────────────────────────────────────────────────────────────────────┘
```

- **Une usine par client** (recommandé) : un serveur dédié, des secrets distincts, un
  Slack, un compte GitHub. L'isolement est total et la facturation simple.
- **Réseaux séparés** : les produits sont sur un réseau à part et ne joignent pas les
  rouages de l'usine ; seul le déployeur a accès à Docker, sans port ouvert.
- **Secrets chiffrés** (SOPS + age) : déchiffrés en mémoire au démarrage, chaque
  conteneur ne reçoit que les siens. La clé de déchiffrement se garde hors du serveur
  (coffre de l'hébergeur).

## Dimensionnement

| Profil | Serveur | Produits en ligne | Fabrication |
|---|---|---|---|
| Démo, essai | 2 vCPU, 4 Go + swap, 60 Go | 5 à 10 petits | une tâche à la fois |
| Équipe | 4 vCPU, 8 Go, 120 Go | 20 à 30 | une tâche à la fois, plus rapide |
| Intensif | 8 vCPU, 16 Go + atelier(s) séparés | 50+ | plusieurs ateliers en parallèle |

Les pics de mémoire viennent de la construction des images et de Chromium (vérification
sur captures). Un produit consomme environ 100 à 200 Mo en marche (384 Mo au plus par défaut).

## Les coûts pour le client

- **Modèles** : abonnements Claude (agents) et ChatGPT (vérificateur), ou clés d'API
  plafonnées. Ordre de grandeur pour un produit de 4 lots : quelques dizaines d'euros en
  équivalent API ; le tableau de bord donne le coût réel et le coût équivalent API.
- **Hébergement** : le serveur de l'usine, et les produits qui tournent dessus.
- **Service** : installation, supervision, mises à jour, assistance.

## Installer chez un client

1. Créer le serveur (Ubuntu, Docker), ouvrir seulement 22, 80 et 443 ; fail2ban.
2. Le client crée son application Slack depuis `slack-manifest.yml` et un jeton GitHub
   fine-grained (voir `README.md`). Il colle lui-même ses jetons dans `.env` : personne
   ne les lui demande.
3. `bash install.sh` : chiffre les secrets, construit, démarre ; puis la connexion Codex.
4. Dans Slack, `/usine acces` : le compte administrateur du client.
5. Premier projet de démonstration avec le client (30 à 60 minutes jusqu'au premier aperçu).

Domaine : par défaut un DNS joker (sslip.io), sans rien configurer. Avec le domaine de
l'hébergeur (`*.usine.hebergeur.fr`) ou du client, renseigner `DOMAINE_BASE` et un
enregistrement joker vers le serveur.

## Exploiter

- **Supervision** : la santé de l'usine est calculée chaque minute (conteneurs,
  connexions aux modèles, GitHub, disque, mémoire, applications) ; alerte Slack à chaque
  changement confirmé. L'hébergeur peut lire `/etat/sante.json` pour sa propre supervision.
- **Mises à jour** : un bouton dans Slack ; l'usine finit sa tâche en cours, se reconstruit
  et reprend seule (`cli.mjs mettre-a-jour` en ligne de commande).
- **Sauvegardes** : base de l'usine chaque jour (14 gardées), données d'un produit avant
  chaque mise en production. À compléter par la sauvegarde des volumes côté hébergeur.
- **Cycle de vie** : aperçus retirés après 7 jours sans activité (rappel 24 h avant) ;
  entretien toutes les 6 heures (images, cache, vieilles sauvegardes).

## Sécurité et conformité

- Hébergement des produits et des données chez l'hébergeur (souveraineté possible si le
  serveur est en France ou en Europe). Les modèles de langage, eux, sont appelés chez
  Anthropic et OpenAI : à mentionner dans le registre des traitements du client.
- En démo, aucune donnée réelle : données fictives, emails capturés.
- En production : emails réels seulement vers une liste de destinataires autorisés tant que
  le client ne l'élargit pas ; journal des connexions dans le portier.
- Revue de sécurité par un agent à chaque tâche, en plus du vérificateur ; en-têtes de
  sécurité, limitation des requêtes et erreurs sans détail technique dans chaque produit.

## Ce qui reste à faire pour une offre à grande échelle

| Sujet | Aujourd'hui | Cible |
|---|---|---|
| Multi-client | une usine par serveur | console de l'hébergeur qui crée et supervise les usines |
| DNS | joker sslip.io ou à la main | API DNS de l'hébergeur : domaines créés automatiquement |
| Facturation | coûts suivis dans l'usine | export mensuel vers la facturation de l'hébergeur |
| Ateliers | un atelier, une tâche à la fois | plusieurs ateliers, sur des serveurs de calcul à la demande |
| Sauvegardes | locales | copie chiffrée vers le stockage objet de l'hébergeur |
| Annuaire | comptes par invitation | connexion d'entreprise (SSO, OpenID Connect) au portier |
| Briques | webapp, site, API, PWA | briques maison de l'hébergeur (WordPress géré, e-commerce…) |
