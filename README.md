# Usine logicielle

Du prompt au produit en ligne. On écrit dans Slack ce qu'on veut construire ;
l'usine planifie, code, teste, déploie un aperçu à chaque étape, et revient
vers l'humain deux fois seulement : pour valider le plan, puis pour valider le
produit fini. Entre les deux, elle travaille seule, dans les limites d'un
contrat écrit (`usine.config.yml`), et n'appelle l'humain que si ce contrat
est épuisé.

```
/usine Une app de prospection : segmentation, ciblage, nurturing, campagnes email
   │
   ▼  ÉTAGE 1 · COMPRENDRE
   l'analyste (Claude Opus) ──► questions ? ──► plan : lots, tâches, critères testables
   │                                            vérifié par le code
   ▼  validation humaine n°1 (bouton Slack)
   ▼  ÉTAGE 2 · FABRIQUER, en boucle, une tâche à la fois
   issue ──► l'agent code (Claude Sonnet, atelier) ──► contrôle local ──► pull request
         ──► vérificateur indépendant (Codex : reconstruit, démarre, teste comme un visiteur)
         ──► porte codée ──► fusion │ correction │ autre approche │ escalade (issue + Slack)
   ▼  ÉTAGE 3 · LIVRER, on tire, on ne pousse pas
   lot fini ──► état souhaité dans le dépôt d'état ──► le déployeur tire ──► aperçu HTTPS
   ▼  validation humaine n°2 : Valider (production blue/green) │ Corriger (un lot de plus)
```

## Ce qui est décidé par du code, pas par un modèle

- **La fusion.** `porte()` (`orchestrateur/src/verification.mjs`) refuse si l'installation,
  le build ou un test échoue, si aucun test ne passe, si le nombre de tests baisse
  (cliquet), si l'application ne démarre pas, ou si un seul critère n'a pas été observé
  par le vérificateur. La fusion se fait sur le sha vérifié, pas sur « la branche ».
- **Les règles qui jugent ne se modifient pas.** Les fichiers du `perimetre_protege`
  (Dockerfile, test de santé, plan…) sont restaurés depuis `main` avant le contrôle et
  avant la vérification : une tâche ne peut pas affaiblir ce qui la juge.
- **Le vérificateur ne voit rien de l'agent** : ni ses notes, ni son raisonnement. Il part
  d'un clone neuf, et c'est une autre famille de modèles (Codex) que celle qui a codé.
- **Le contrat** : tentatives par tâche, changements d'approche, durée par agent et par
  projet, lignes par PR, arrêt des seules tâches dépendantes ou du projet entier.
- **La sécurité avant la fusion** : un secret écrit dans le code, ou une faille grave
  ajoutée dans les dépendances (`npm audit`, comparé à `main`), refuse la tâche ; un agent
  relecteur sécurité lit chaque changement avant le vérificateur, avec une grille
  (injections, XSS, redirections, données personnelles…).
- **Des critères qui peuvent échouer.** L'analyste écrit chaque critère comme ce que
  l'utilisateur fait, puis le résultat attendu : un texte affiché, une valeur, un code HTTP.
  Un critère flou (« fonctionne correctement », « est intuitif ») lui est renvoyé une fois.
  Chaque critère validé doit avoir son test dans le cliquet (`T3-2.cjs` pour le deuxième
  critère de T3). Sinon il est **non prouvé**, et la PR comme le journal le disent, avec la
  raison donnée par le vérificateur.
- **Les budgets de l'interface** (`orchestrateur/src/mesures.mjs`), mesurés par l'usine
  sur chaque page de la tâche :
  - erreurs de la console du navigateur (celles de l'application, pas d'un autre site) ;
  - défauts d'accessibilité graves (axe-core) ;
  - temps de chargement, 5 s au plus (`autonomie.chargement_max_ms`) ;
  - erreurs sur téléphone dans WebKit, le moteur de Safari.

  C'est un cliquet par problème : une page ne peut pas avoir de problème qu'elle n'avait pas à
  la dernière fusion. Ses problèmes déjà connus ne refusent rien (une erreur est reconnue à ses
  chiffres et identifiants près). Une page mesurée pour la première fois, ou ce qui n'a pas pu
  être mesuré (WebKit en panne, axe-core absent), est appris à la fusion suivante.
- **Une refonte est comparée à l'ancienne version.** L'analyste marque `"nature": "refonte"`
  une tâche qui ne doit rien changer à l'écran ni à l'API. L'usine démarre alors l'ancienne
  version à côté (port 4101) et compare chaque page (au pixel) et chaque route GET de
  `docs/API.md`. Le vérificateur reçoit les différences :
  - une différence fautive, il la signale, et la tâche est refusée ;
  - une différence attendue (une heure, une donnée de démo tirée au sort), il l'explique ;
  - une différence ni expliquée ni signalée part à une personne, qui tranche.
- **Un incident corrigé est prouvé par un test.** La première tâche d'une correction demandée
  par la boucle d'amélioration ou par le pilote porte la nature « incident ». Le vérificateur
  écrit un test qui reproduit l'incident. L'usine le relance sur l'ancienne version, où il doit
  échouer. S'il n'y échoue pas (l'incident ne se produit pas en démonstration), une personne
  tranche.
- **Sans l'ancienne version, la vérification ne conclut pas.** Si elle ne se construit pas, ne
  démarre pas, ou si sa comparaison n'a eu lieu qu'en partie, une personne tranche. Un vrai
  refus (tests, critères, budgets) passe toujours avant : l'agent recommence.
- **Un incident en production ne met jamais rien en ligne.** En mode « proposer », le pilote et
  la lecture de Sentry ne font que proposer une correction, et seule une personne la lance. En
  mode « corriger », le pilote corrige seul une panne du code, jusqu'à l'aperçu. Voir **La
  boucle d'amélioration**.

## Auditer le vérificateur

Un contrôle n'est sûr que s'il a déjà attrapé un vrai bug. L'audit le vérifie sur un produit livré
ou en production : `node src/cli.mjs audit <n°> [bugs] [tâche]` (`orchestrateur/src/audit.mjs`).

- Pour chaque bug (4 par défaut, 8 au plus), un agent « planteur » plante un seul bug réaliste
  dans une copie du produit. Les sortes de bugs viennent à tour de rôle : un compteur décalé d'un,
  une sauvegarde qui ne se fait pas, un email noté « envoyé » mais jamais parti, une erreur avalée.
  Le bug casse un comportement couvert par les critères d'une tâche fusionnée : la dernière, ou
  celle qu'on nomme.
- Le code écarte un bug qui touche aux tests, à `.usine/` ou aux fichiers protégés : il est
  compté « non planté ».
- Puis la vraie vérification tourne, avec les critères de cette tâche, sans savoir ce qui est
  cassé. Un refus compte comme attrapé, une validation comme raté. Si le vérificateur est en panne
  ou à sa limite, le bug n'est pas jugé.
- Il n'y a ni pull request ni fusion. La branche `usine/audit/…` est supprimée après chaque bug,
  même après une erreur. Si GitHub refuse deux fois, l'audit suivant la supprime en premier.
- L'atelier est réservé pendant l'audit : la fabrication attend, une dizaine de minutes par bug.
  L'audit ne démarre pas pendant une tâche, ni quand l'usine est arrêtée.
- Le score arrive dans Slack (« 3 bugs attrapés sur 4 », avec les ratés) et au journal du projet.
  Le détail est gardé dans le réglage `audit_<n°>`.

## La sécurité

Règle de l'usine : **toujours protéger les applications.**

- **Les secrets sont chiffrés** (SOPS + age, `secrets.sh`) : jamais en clair sur le disque,
  déchiffrés en mémoire au démarrage du serveur, et chaque conteneur ne reçoit que les siens,
  en fichiers (ils n'apparaissent pas dans `docker inspect`). `.env` ne contient que des
  réglages. La clé de déchiffrement (`/etc/usine/age.key`) se sauvegarde hors du serveur.
- **Chaque application est derrière une page de connexion** (le portier) : aperçus, production,
  emails capturés, tableau de bord. Les comptes se donnent depuis Slack (`/usine acces`) par
  un lien d'invitation ; personne ne transmet de mot de passe. Une production n'est publique
  que sur choix explicite. Les liens des emails (suivi, désinscription) restent publics.
- **Les programmes entrent avec une clé d'API** (`/usine acces`, « Créer une clé d'API ») :
  `Authorization: Bearer usk_…`, valable pour les applications choisies, révocable ; seule
  son empreinte est gardée.
- **Les produits sont isolés** sur leur propre réseau : une application ne peut pas joindre
  les rouages de l'usine.
- **Chaque produit embarque une sécurité de base** (fichier protégé `server/securite.js`) :
  en-têtes (CSP…), limitation des requêtes, erreurs sans détail technique.
- **Les agents ne voient jamais le jeton GitHub** (il ne sert qu'aux étapes de clone et de
  push, hors de l'agent), ni Slack. Seul le déployeur a accès à Docker, sans port ouvert.

## L'escalade

Quand le contrat est épuisé, l'usine ouvre une issue `usine:bloquant` **assignée à
l'humain**, et poste les mêmes options en boutons dans Slack :

- **A · Réessayer** (avec une consigne libre, transmise à l'agent en priorité) ;
- **B · Accepter en l'état** (fusionner la dernière PR malgré le refus) ;
- **C · Abandonner** la tâche (celles qui en dépendent continuent sans elle).

Un clic dans Slack, ou un commentaire « A », « B », « C » (ou une consigne en texte libre)
sur l'issue, débloque. Fermer l'issue vaut « réessayer ». Rappel après 24 h.

## Les composants

| Conteneur | Rôle | Accès |
|---|---|---|
| `orchestrateur` | État (SQLite), contrat, GitHub, Slack, API locale de la CLI | jeton GitHub, Slack ; **pas** Docker |
| `atelier-1` | Les agents codent (Claude Code, dernière version) | abonnement Claude ; **pas** le jeton GitHub pendant l'agent |
| `verificateur` | Reconstruit, démarre, teste (Codex, curl, Playwright + Chromium) | compte ChatGPT |
| `deployeur` | Tire le dépôt d'état, construit, déploie, régénère Caddy | Docker, lecture GitHub ; aucun port |
| `portier` | La page de connexion devant chaque application, les comptes | aucun port publié |
| `caddy` | HTTPS automatique, le portier devant chaque site | ports 80, 443 |
| `mailpit` | Capture les emails des produits (démo) | — |

Les produits partent d'une **brique**, choisie par l'analyste dans le plan, avec ses
conventions (`AGENTS.md`) :

| Brique | Pour | Contenu |
|---|---|---|
| `webapp` | outil métier, tableau de bord, SaaS | Node 24, Express 5, SQLite, React 19, Vite, Tailwind 4, kit de composants |
| `site` | site vitrine | pages référencées (titre, description, plan du site), formulaire de contact |
| `api` | intégration, connecteur | API JSON documentée (`docs/API.md`, `/api/docs`), sans écrans, appelée avec une clé d'API |
| `pwa` | application mobile | installable (manifeste, service worker), pensée pour le téléphone, hors ligne prudent |

`site`, `api` et `pwa` sont des surcouches de `webapp` (`brique.json`), assemblées par
`briques/assembler.mjs`. En démo, les produits se remplissent de données fictives, leur
horloge est accélérée (un jour = une minute), et leurs emails sont capturés par Mailpit.

Adresses (DNS joker via sslip.io, rien à configurer) :
aperçu `https://<produit>.apercu.<base>`, production `https://<produit>.<base>`,
emails capturés `https://mails.apercu.<base>`, console `https://console.<base>`,
portail « Mes applications » `https://connexion.<base>`.

## Nouveau sur le projet ?

Par où commencer, selon ce que tu viens faire :

| Tu veux… | Lis |
|---|---|
| comprendre ce que fait l'usine, sans technique | `docs/guide-utilisateur.md` |
| l'installer sur un serveur | **Installer**, ci-dessous, puis `docs/kb/` pas à pas (VPS, jeton GitHub, secrets, ports) |
| la mettre à jour | **Mettre à jour** |
| modifier son code | `CLAUDE.md` (où sont les choses, règles), puis **Contribuer et publier une version** |
| la sécurité, ce qui reste à décider | `docs/SECURITE.md` |
| brancher Sentry et PostHog, lire ce qui remonte | `docs/OBSERVABILITE.md` |
| la proposer à des clients | `docs/INDUSTRIALISATION.md` |

## Installer

Prérequis : un serveur Linux avec Docker et le plugin Compose (1 CPU / 4 Go suffisent pour la
démo, avec du swap), les ports 80 et 443 ouverts, et `sudo` (pour la clé de chiffrement des secrets).

1. **Sur le serveur, la dernière version publiée** (pas `main`, qui bouge tous les jours) :

   ```bash
   git clone https://github.com/Tgnima/usine-logicielle.git && cd usine-logicielle
   git checkout "$(git tag -l 'v*' --sort=-v:refname | head -1)"
   bash install.sh --admin prenom@exemple.fr
   ```

   `install.sh` crée `.env` et `usine.config.yml`, déduit l'adresse du serveur
   (`<ip>.sslip.io`), génère et chiffre les jetons internes, construit et démarre l'usine.
   Il affiche à la fin le lien d'invitation du premier administrateur (valable 72 h). Les
   valeurs d'exemple (compte GitHub, domaine) ne désignent jamais l'usine de quelqu'un d'autre.
2. **Ouvre le lien**, choisis ton mot de passe : la console s'ouvre sur **Premiers pas**, qui
   guide le reste sans retourner sur le serveur :
   - le fournisseur d'IA (abonnement Claude, clés API, connexion ChatGPT du vérificateur) ;
   - GitHub (« Se connecter avec GitHub ») ;
   - les invitations ;
   - le premier projet.
3. **Sauvegarde la clé de déchiffrement** hors du serveur (gestionnaire de mots de passe) :
   `sudo cat /etc/usine/age.key`. Sans elle, les secrets chiffrés sont perdus.
4. **Slack** (facultatif) : crée l'application depuis `slack-manifest.yml`, colle ses deux
   jetons et tes identifiants Slack (`ADMIN_USER_IDS`, des U…) dans `.env`, puis
   `bash install.sh`. Tant que `ADMIN_USER_IDS` est vide, personne ne décide depuis Slack.

Les secrets se collent dans `.env`, jamais dans une conversation. `install.sh` (ou
`bash secrets.sh migrer`, **sans sudo**) les chiffre puis les retire de `.env`. Pour en changer
un : le recoller dans `.env` et relancer `bash secrets.sh migrer`, ou `bash secrets.sh editer`.
Sur un serveur où l'usine à contenu tourne déjà, `bash install.sh --reprendre-de ../usine-contenu`
réutilise sa connexion Claude, sa clé Vercel AI Gateway et son volume Codex.

## Mettre à jour

L'usine a des **versions publiées** : des étiquettes `vX.Y.Z` sur GitHub, décrites dans
`CHANGELOG.md` avec les gestes éventuels à faire. Une usine installée suit l'un de deux canaux
(`CANAL_USINE` dans `.env`) :

| Canal | Ce que propose « Mettre à jour l'usine » | Pour qui |
|---|---|---|
| `stable` (défaut) | la dernière version publiée | toute usine en service |
| `main` | chaque fusion, dès qu'elle arrive | le serveur de test de l'équipe qui développe l'usine |

Deux façons de mettre à jour, qui font la même chose : l'usine finit sa tâche en cours et
s'arrête, passe à la nouvelle version, crée les secrets que celle-ci attend, se reconstruit,
redémarre et reprend. Les données et les réglages ne bougent pas.

- **Depuis la console ou Slack** : le bouton « Mettre à jour l'usine » apparaît quand une
  version plus récente existe sur le canal.
- **Sur le serveur** :

  ```bash
  bash update.sh              # la cible du canal
  bash update.sh --liste      # les versions publiées
  bash update.sh v1.2.0       # une version précise, y compris pour revenir en arrière
  ```

Avant de mettre à jour, lis le bloc **À faire** de la version dans `CHANGELOG.md`.
`update.sh` signale aussi les nouveaux réglages de `.env.example`. Relancer
`install.sh` sur une usine qui tourne redémarre tout aussitôt : préfère `update.sh`.

## Contribuer et publier une version

1. **Une branche, une pull request.** Chaque PR lance les tests (GitHub Actions,
   `.github/workflows/tests.yml`) :
   - orchestrateur, portier, déployeur et brique webapp ;
   - les scripts shell ;
   - `docker-compose.yml`, et la concordance de ses secrets avec `secrets.sh`.

   Une PR rouge ne se fusionne pas. En local : `cd orchestrateur && npm ci && npm test`, de même
   dans `portier`, et `node --test test/*.test.mjs` dans `deployeur`.
2. **Le dépôt est public** : rien de réel dans une PR (adresse du serveur, emails, secrets).
3. **Fusionner sur `main`** n'atteint que les serveurs sur le canal `main`. Note le
   changement dans la section **Non publié** de `CHANGELOG.md`, avec tout geste à faire
   (un nouveau secret, un réglage).
4. **Publier**, une fois la version éprouvée sur le serveur de test :
   - renomme **Non publié** en `vX.Y.Z` dans `CHANGELOG.md` et fusionne ;
   - pose l'étiquette :

   ```bash
   git tag -a v1.1.0 -m "v1.1.0" && git push origin v1.1.0
   ```

   En une dizaine de minutes, chaque usine sur le canal `stable` voit la mise à jour.
   Numérotation :
   - `X` quand il faut un geste à la main ;
   - `Y` pour une nouveauté ;
   - `Z` pour une correction.

## Premiers pas et GitHub

À la première connexion, la console s'ouvre sur **Premiers pas** : fournisseur d'IA, GitHub,
invitations, personas, premier projet. L'avancement est calculé sur l'état réel ; l'assistant
se rouvre depuis les Réglages. Le premier administrateur se crée sans Slack :
`bash install.sh --admin prenom@exemple.fr` affiche son lien d'invitation.

**Se connecter avec GitHub** (Réglages) : la console fait créer à GitHub une application propre
à cette usine (un clic), que la personne installe sur son compte ou son organisation, sur « tous
les dépôts ». L'usine n'utilise ensuite que des jetons qui expirent : le jeton d'installation
(1 h, renouvelé, aussi déposé pour le déployeur) et, sur un compte personnel, le jeton de
l'utilisateur pour créer un dépôt. La clé privée de l'application est chiffrée dans le coffre.
Sans application, le jeton du serveur (`github_token`) sert comme avant ; il n'est plus exigé
à l'installation. La mise à jour de l'usine elle-même lit son dépôt avec la connexion de la console d'abord,
puis le jeton du serveur (`deploy_token`, facultatif), puis sans jeton si le dépôt est public :
un jeton du serveur expiré ne la bloque plus.

## Fournisseurs d'IA

Console, **Réglages → Fournisseurs d'IA** (administrateurs) :

- **Claude** (analyste, agents, relecteurs) : le jeton d'abonnement Pro/Max (obtenu sur ton
  ordinateur par `claude setup-token`), une clé API Anthropic, la passerelle Vercel AI Gateway.
- **Codex · OpenAI** (vérificateur) : le bouton *Connecter un compte ChatGPT* (un lien et un code
  à saisir sur le site d'OpenAI), une clé API OpenAI, la passerelle.
- Pour chaque moteur, les façons actives et leur **ordre de secours** : à la limite d'usage ou à
  court de crédit, l'usine passe à la suivante pour le même travail.
- Le **modèle de chaque rôle**, et un bouton *Tester les connexions* (sans dépense pour les clés).

Une valeur saisie est chiffrée (AES-256-GCM, clé dérivée de `worker_token`), jamais réaffichée
(seulement ses 4 derniers caractères, la date et l'auteur), et passe avant celle du serveur.
Les secrets du serveur (`secrets.sh`) restent le secours. Changer `worker_token` efface ces valeurs.

## Piloter

Dans Slack : `/usine <ce que tu veux construire>`, puis les boutons du fil.
Répondre dans le fil d'un projet vaut réponse à l'usine (correction, décision, remarque).
`/usine acces` (comptes), `/usine couts [n°]`, `/usine tableau`, `/usine corriger <n°> …`,
`/usine statut`, `/usine stop` (après la tâche en cours), `/usine reprendre` (sans argument :
l'usine repart après un arrêt).

**Un projet en échec** se relance avec `/usine relancer <n°>` ou le bouton *Relancer* de la
console, là où il a échoué : une création échouée (GitHub indisponible, par exemple) est refaite
avec le plan déjà validé, sans repasser par l'analyste ; une analyse échouée repart de la demande.
Un projet en fabrication ne se relance pas : ses tâches bloquées se débloquent par leur décision.

**Changer de direction** (en fabrication, bloqué, livré ou en ligne) : `/usine reorienter <n°> [persona <nom>]
[depot <adresse GitHub>] : <la nouvelle direction>`, ou *Changer de direction* dans la page du projet de la console. L'usine
termine la tâche en cours puis s'arrête sur ce projet ; l'analyste garde les lots qui ont du code
fusionné et refait la suite (les demandes laissées dans le fil partent avec). Le nouveau plan se
valide comme le premier : les tâches pas encore faites sont abandonnées (issues fermées), les
nouvelles ouvertes, MISSION.md, ICP.md (persona changé) et docs/PLAN.md réécrits, et la
fabrication reprend. *Garder l'ancien plan* remet tout comme avant. Un message laissé dans le fil
pendant la fabrication, lui, attend la livraison de tous les lots.

Un **produit livré ou en ligne** se réoriente aussi : rien n'est en cours, tous ses lots sont gardés, et
le produit reste tel quel (en ligne s'il l'est) pendant que l'analyste prépare la suite. À la
validation, les nouveaux lots se fabriquent et se livrent comme d'habitude ; la production ne
change qu'à la prochaine mise en ligne validée. *Garder le produit tel qu'il est* annule tout. Pour
une simple évolution sans changer de cap, `/usine corriger` reste plus léger (un lot de plus).

Un **dépôt GitHub de référence** peut accompagner la nouvelle direction (un concept, une maquette, un
prototype codé à part) : l'analyste lit sa description, son README et ses `docs/` avec le compte
GitHub de l'usine, sans voir le jeton, et s'en inspire pour écrire les nouveaux lots. Il ne copie
pas son code : la suite se fabrique dans la pile et le code du produit. Un dépôt invisible pour
l'usine arrête la préparation avec un message clair. Pour repartir du code d'un dépôt, c'est
`/usine reprendre` (un nouveau projet).

**Reprendre un dépôt existant, pour un persona.** Le cas d'usage : un reverse engineering (REA)
a reproduit une partie d'une application ; l'usine la reprend, la spécialise pour une cible et la
termine. Dans la console : *Nouveau projet → Partir d'un dépôt existant*. Dans Slack :
`/usine reprendre https://github.com/o/depot persona Commerçant [mode copie|direct] : ce que tu veux en faire`.

1. **Le persona** se crée dans la console (onglet *Publics*, « Nouveau public »), à partir de ce
   qu'on a déjà : deux phrases, des **documents** (PDF, Markdown, texte, CSV, images : 5 au plus,
   exports Drive compris), un **dépôt GitHub** (description, README et `docs/`, lus avec le jeton
   de l'usine, que l'agent ne voit jamais), un **dossier Google Drive** (les 5 documents les plus
   récents : Docs en texte, Sheets en CSV, Slides, PDF, lus par le compte de service de l'usine,
   avec qui on partage le dossier en lecteur ; Réglages, Intégrations, Google Drive), ou une
   **fiche déjà prête** (JSON, au format du modèle
   téléchargeable). Sauf pour une fiche prête, un agent l'approfondit (les documents d'abord, le web
   ensuite) et rend une fiche (problèmes avec preuves, besoins, outils actuels, objections),
   **ce qui est hors périmètre**, et **3 à 5 scénarios cachés**. Une source est une page web ou un
   document. On relit, on corrige, on valide. Seul un persona validé sert à un projet.

   **Depuis sa machine** (un script, ou son assistant qui lit ses documents) : dans *Publics*,
   « Depuis ma machine », on crée un jeton `usp_…`, montré une seule fois. Il ne sert qu'à envoyer
   des fiches : `curl -X POST https://console.<domaine>/api/import/personas -H "Authorization:
   Bearer usp_…" -H "Content-Type: application/json" --data @persona.json`. La fiche arrive
   « à valider », sans recherche ni jeton consommé. Le portier ne laisse passer que cette adresse
   avec ce jeton, et la console le vérifie (`jetons-personas.mjs`).
2. **Le mode** : *direct* si le compte GitHub de l'usine est invité en écriture sur le dépôt
   (branche `usine/<slug>/integration`, une PR par tâche dessus, et à la fin **une PR de
   livraison** vers la branche d'origine, que la personne fusionne elle-même : l'usine ne
   pousse jamais sur sa branche principale) ; *copie* sinon (un dépôt de l'usine, l'original
   n'est jamais touché).
3. **L'inventaire**, avant tout plan : un agent lit le dépôt, trouve sa pile (Node ou Python) et
   ses commandes, le met au contrat d'hébergement (Dockerfile, `$PORT`, `GET /api/health`,
   `$DATA_DIR`, et l'observabilité, voir plus bas) sans ajouter de fonctionnalité, et dit ce qui
   marche, ce qui est cassé, ce qui manque. Le **code** éprouve ensuite chaque commande
   (installation, build, tests, démarrage, santé, et un vrai pouls) : un dépôt qui ne démarre pas
   s'arrête là, expliqué. Les commandes deviennent le profil du projet (`.usine/profil.json`,
   protégé), utilisé par l'atelier et le vérificateur.

   **L'observabilité d'un dépôt repris**, dans sa propre pile. L'agent copie tel quel le module de
   l'usine dans `usine/` (le fichier est protégé ensuite), l'appelle au démarrage et ajoute la route
   `GET /_usine/observabilite` :
   - en Node, `usine/observabilite.mjs`, le module des briques (`demarrerObservabilite()`,
     `etatObservabilite()`), sans dépendance ;
   - en Python, `usine/observabilite.py` (`briques/reprise/`, `demarrer_observabilite()`,
     `etat_observabilite()`). Les erreurs partent par `sentry-sdk`, ajouté aux dépendances, avec
     `SENTRY_DSN`, `USINE_ENVIRONNEMENT` et `USINE_VERSION`. Ni variables locales, ni code, ni
     corps de requête ne partent, et le masquage est celui de l'usine
     (`briques/reprise/cas-masquage.json`, vérifié des deux côtés). Le pouls part vers PostHog : des
     compteurs, avec `$process_person_profile: false` et `$geoip_disable: true`, comme la brique.

   L'épreuve démarre l'application devant un faux Sentry et un faux PostHog locaux. Elle exige que
   le module soit intact, qu'un pouls de compteurs arrive dans les secondes qui suivent, et que la
   route dise l'état des envois. Sinon, l'agent a un second essai, puis la reprise s'arrête,
   expliquée.
4. **Le plan** part de l'inventaire et du persona ; on le valide comme d'habitude.
5. Dans le dépôt : `MISSION.md` (le cap et le hors périmètre) et `ICP.md` (la fiche), tous deux
   protégés, et `docs/INVENTAIRE.md`. **Les scénarios cachés n'y sont jamais** : l'agent qui code
   ne peut pas coder « pour le test ».
6. **La recette**, avant le rapport final : le vérificateur (Codex) joue les scénarios cachés dans
   la peau du persona, sur ce qui va être livré. Le résultat est dans le rapport et la console ;
   *Corriger les écarts* en fait un lot de corrections.

**La pyramide de l'expérience** (Stephen P. Anderson) est la grille de qualité de l'usine :
Fonctionnel, Fiable, Utilisable, puis, au-dessus du « gouffre » où s'arrêtent la plupart des
produits, Pratique, Agréable et Qui a du sens (`orchestrateur/src/pyramide.mjs`).
- L'analyste en tient compte dans chaque plan : chaque lot après le premier a au moins un
  critère Pratique ou Agréable, et le dernier un critère « Qui a du sens ».
- Les agents la lisent dans leur consigne.
- La recette note chaque étage de 0 à 10 sur le produit fini, avec ou sans persona (sans
  persona, elle découvre le produit comme un nouvel utilisateur). Un étage est tenu à partir
  de 7, et l'étage atteint est le plus haut tenu sans trou en dessous.
- Le rapport (Slack, console, pull request de livraison) montre la pyramide.
- *Corriger et monter d'un étage* envoie à l'analyste les écarts et les étages à faire monter.
- Toute demande de correction ajoute un critère de l'étage suivant sur les écrans qu'elle touche.

**Le sens** : avant de planifier, l'analyste se demande, à partir du persona, ce qui donnerait du
sens à l'application. Ce n'est pas sa fonction, mais ce qui compte vraiment pour cette personne :
appartenance, fierté, sérénité, progrès, transmission… Strava enregistre des courses, mais son
sens est la passion partagée.
- Le plan doit le dire : motivation, promesse, moment où on le ressent, preuve à l'écran. Ces
  éléments sont écrits en tête de `docs/PLAN.md`.
- Le dernier lot rend la preuve tangible, et les agents ont la promesse dans leur consigne.
- La recette juge l'étage du sommet sur cette promesse.
- Un produit livré avant cette règle reçoit son sens à sa prochaine demande de correction.

**Un domaine à soi** : `/usine domaine <n°> app.mon-entreprise.fr` sur un produit en
production. L'usine donne l'enregistrement DNS à créer (A vers le serveur), vérifie toutes
les 2 minutes, ajoute l'adresse à Caddy (certificat HTTPS) dès que le DNS est bon, et
prévient dans le fil. Toujours derrière la page de connexion. `/usine domaine <n°>` les
liste, `/usine domaine <n°> retirer <adresse>` en retire un.

Sans Slack, la CLI fait la même chose :

```bash
docker compose exec orchestrateur node src/cli.mjs nouveau "Une app de prospection…"
docker compose exec orchestrateur node src/cli.mjs plan 1
docker compose exec orchestrateur node src/cli.mjs valider 1
docker compose exec orchestrateur node src/cli.mjs journal 1
docker compose exec orchestrateur node src/cli.mjs decider 3 A "utilise une table séparée"
docker compose exec orchestrateur node src/cli.mjs production 1
```

## Surveiller et entretenir l'usine

- **Les limites d'usage des abonnements** (Claude, ChatGPT) : quand l'abonnement est à sa limite,
  l'usine reprend le même travail avec la clé API du fournisseur, puis avec la passerelle
  (Vercel AI Gateway), et revient à l'abonnement après sa réinitialisation. Si tout est
  épuisé, elle se met en pause sans consommer de tentative et reprend seule. Réglage :
  `secours` dans le contrat ; les limites en cours apparaissent dans la santé.

- **La santé** (onglet Accueil, `/usine sante`, page web) : déployeur, ateliers, vérificateur,
  portier, Caddy, Mailpit, connexions Claude et Codex, GitHub, disque, mémoire, applications.
  Une alerte Slack seulement quand un état change (confirmé deux fois de suite).
- **La durée de vie des aperçus** (`apercus.duree_vie_jours`, 7 par défaut) : un aperçu est
  retiré après 7 jours sans activité sur son projet, avec un rappel 24 h avant
  (Prolonger / Garder / Retirer). La production n'est jamais retirée automatiquement.
- **Supprimer un projet** (`/usine supprimer <n°>` ou la fenêtre de détail) : aperçu et
  production s'arrêtent, la place est libérée ; le code reste sur GitHub et les données de
  production restent sur le serveur.
- **L'entretien**, toutes les 6 heures : vieilles images, cache de construction, sauvegardes
  de plus de 30 jours. La base de l'usine est sauvegardée chaque jour (14 jours gardés).
- **La mise à jour** (voir **Mettre à jour**) : quand une version plus récente existe sur le
  canal de l'usine, le bouton « Mettre à jour l'usine » apparaît dans l'onglet Accueil. L'usine
  termine sa tâche en cours, se reconstruit, redémarre et reprend seule (`bash update.sh` et
  `cli.mjs mettre-a-jour` font de même).
  Si la nouvelle version attend un secret qui n'existe pas encore sur le serveur, la mise à
  jour s'arrête avant tout changement et dit quoi lancer (`bash secrets.sh dechiffrer`).
- **Sentry et PostHog** (facultatifs, secrets `SENTRY_DSN` et `POSTHOG_TOKEN`, comptes en
  région européenne) : un seul DSN et un seul jeton pour l'usine et tous ses produits, chaque
  envoi porte le produit en étiquette. Le détail, produit par produit, et comment vérifier que
  ça remonte : `docs/OBSERVABILITE.md`.
  - Vers Sentry partent les erreurs de l'orchestrateur et du déployeur, un battement de cœur
    par minute (moniteur `usine-orchestrateur`) et un incident quand un produit tombe en panne.
  - Vers PostHog partent un événement par ligne du journal de l'usine (sans son texte),
    l'état de chaque produit toutes les 5 minutes, ses déploiements et les journaux de ses
    conteneurs.
  - Les produits reçoivent les mêmes clés. Rien de personnel ne sort : adresses email,
    téléphones, IBAN, adresses IP et jetons sont masqués (`commun/observabilite.mjs`).
  - **Chaque produit envoie lui-même** ses erreurs à Sentry et son pouls à PostHog (toutes les
    5 minutes, des compteurs seulement), par le module de sa brique (`server/observabilite.js`,
    branché dans `server/demarrage.js`) ou de sa pile s'il a été repris (`usine/`). Un produit
    créé avant ce module ne l'a pas : il faut le lui ajouter (le copier depuis la brique et
    appeler `demarrerObservabilite()` au démarrage).
  - **Ce que la console montre de chaque application**, dans les fenêtres Sentry et PostHog :
    pas seulement si elle a reçu la clé, mais si elle s'en sert. Le module de chaque produit
    répond `GET /_usine/observabilite` : démarré ou non, la clé présente ou non, et la réponse du
    service à son dernier envoi. La sonde du déployeur lit cette route chaque minute, sur le
    réseau du produit. Caddy ne la sert jamais au public (`CHEMINS_INTERNES`, `deployeur/chemins.mjs`).
    La console en tire un état par application : *reçu* (PostHog a accepté un pouls il y a
    moins de 15 min ; Sentry, la dernière erreur), *en échec* (avec la raison : clé refusée, pas de
    réponse), *muet*, *n'envoie rien* (module pas démarré, ou `sentry-sdk` manquant), *sans clé*,
    *en attente*, *prête* (rien à envoyer encore) ou *sans nouvelles*. Une application qui ne
    publie pas cette route est dite *non vérifié* : son module manque, ou il est plus ancien que
    cette version (un tel module envoie son pouls sans publier la route). Rien ne
    prouve alors qu'elle envoie. Limite : PostHog accepte un pouls même avec un jeton inconnu. C'est le
    bouton « Tester » qui vérifie le jeton.
  - **Les journaux des conteneurs** sont classés par niveau (`niveauDe`, `deployeur/observation.mjs`).
    Une exception Python (`Traceback (most recent call last):`, les cadres, puis
    `ZeroDivisionError: …`) ou Node (`TypeError: …` et sa pile) est une erreur de bout en bout.
    Une ligne ordinaire qui cite un mot comme « KeyError » au milieu d'une phrase reste une
    information.
  - Les clés se posent aussi dans la console (Réglages, Intégrations, Sentry ou PostHog), sans
    SSH ni redémarrage : chiffrées dans le coffre, elles servent tout de suite à l'orchestrateur,
    au déployeur dans les 30 s (par la boîte, un volume en mémoire vive), et aux applications à
    leur prochaine mise en ligne ou par « Appliquer ». « Couper l'envoi » l'emporte sur la valeur
    du serveur et garde celle de la console, que « Ne plus couper » rétablit ; « Retirer » efface
    tout et rend la main au serveur.

## La boucle d'amélioration

Un incident en production devient une proposition de correction, avec son contexte, sans
attendre qu'une personne le remarque. En mode « proposer », rien ne part sans elle : elle lance
la correction, ou l'écarte. La boucle suit celle que décrit PostHog (« self-improving loop » :
signaux, regroupement, enquête, revue humaine, mesure), avec les briques de l'usine. Le schéma
ci-dessous est celui du mode « proposer » ; le mode « corriger » (plus bas) saute la validation
pour une panne du code.

```
 un incident en production
   │  la sonde, chaque minute : une panne due au code, depuis 10 min        (pilote.mjs)
   │  Sentry, toutes les 5 min : une erreur nouvelle, qui revient, en hausse (signaux.mjs)
   ▼
 une proposition de correction : une seule ouverte par produit, les signaux s'y regroupent
   │  ce que l'usine a relevé, et les chiffres de PostHog (signes de vie, erreurs, journaux,
   │  mises en ligne)
   ▼
 une personne : « Lancer la correction » ou « Écarter »   (console, Ce qui t'attend · Slack)
   │  lancer = une demande de corrections : l'analyste enquête (journaux, et Sentry et PostHog
   │  par leurs connecteurs), puis un lot passe par la fabrique, le vérificateur et la recette,
   │  et s'arrête à l'aperçu
   ▼
 la mise en ligne, par une personne, comme toujours
   ▼
 la mesure, pendant 7 jours : l'incident revient, c'est une rechute (une nouvelle
 proposition) ; 48 h sans lui, la correction tient
```

**Ce qui fait naître une proposition** (des règles codées, jamais un modèle) :
- **Une panne due au code**, vue par la sonde depuis `minutes_avant_action` (10 min) : l'application
  redémarre en boucle, `/api/health` répond une erreur ou ne répond plus, ou elle s'arrête sur une
  erreur. Si la cause est ailleurs (mémoire, disque, plusieurs applications en panne à la fois), si
  elle est inconnue, ou si le projet n'est pas en production, l'usine envoie un message, sans
  proposition.
- **Une erreur Sentry** non résolue, de niveau erreur, dans l'environnement production d'une
  application, nouvelle, qui revient ou en hausse, et vue dans l'heure. Les incidents « en panne »
  que le déployeur envoie à Sentry n'y sont pas : la sonde les voit déjà.
- PostHog ne déclenche rien. Ses chiffres servent de contexte, et l'analyste peut l'interroger.

**Une proposition** regroupe les signaux d'un même produit. Un signal déjà connu ne revient pas.
Un signal écarté ne revient pas pendant 7 jours. Un signal dont la correction est en route ne
revient pas non plus. Elle ne cite que des faits mesurés : état, version, redémarrages, titre et
lieu de l'erreur, nombre d'occurrences. Les textes venus de l'application sont neutralisés : une
ligne, sans balise ni caractère invisible. Les données personnelles sont masquées dès l'envoi
(`commun/observabilite.mjs`). Dans la demande faite à l'analyste, la consigne passe avant les
faits, et elle reste toujours entière. Pendant que le projet est en travail, la proposition
attend.

**Qui la valide** : un administrateur, depuis la console (Ce qui t'attend, groupe À décider) ou
depuis Slack (`ADMIN_USER_IDS`). Un seul clic compte, d'un côté ou de l'autre. Dans la boucle,
seule `lancerProposition()` appelle `demanderCorrections()`, et seules la console et Slack
l'appellent. La lecture de Sentry ne reçoit que `proposer()`. Les tests le vérifient.

**Le lien avec l'aiguillage** : pour un texte libre (`/usine …`), l'aiguillage
(`aiguillage.mjs`) décide s'il s'agit d'un nouveau produit ou d'une correction. Une proposition
connaît déjà son produit : elle va directement à la demande de corrections, la même porte que le
résultat « correction » de l'aiguillage.

**Brancher Sentry et PostHog** (facultatif, en lecture seule) : dans la console, Connecteurs.
- **Sentry** : un jeton de lecture (`org:read`, `project:read`, `event:read`). La boucle s'en sert
  pour lire les erreurs toutes les 5 minutes, et l'analyste pour enquêter : coche le rôle « plan »
  en plus de « construction ». La région et le projet se déduisent du DSN de l'usine. Le jeton ne
  part que vers sentry.io : avec un Sentry hébergé ailleurs, la boucle ne lit rien.
- **PostHog** : une clé personnelle `phx_` avec le préréglage « MCP Server », limitée au projet de
  l'usine. Les IA passent par le serveur MCP de PostHog en lecture seule (`?readonly=true`). La
  boucle reconnaît le projet au jeton d'envoi (`POSTHOG_TOKEN`). La clé ne part que vers PostHog,
  en Europe ou aux États-Unis, jamais vers un relais d'envoi.
- Sans ces connecteurs, la boucle marche avec la sonde seule.
- Une clé se colle dans la console, jamais dans un message.

**Régler et vérifier** : dans la console, ouvre Règles de l'usine, puis la carte « Pannes et
erreurs des applications en ligne ». Elle propose quatre modes :
- **coupé** ;
- **observer**, le mode par défaut : l'usine dit ce qu'elle aurait fait, sans rien lancer ;
- **proposer** : chaque panne du code et chaque nouvelle erreur deviennent une proposition, et rien
  ne part sans une personne ;
- **corriger**, le mode du pilote des pannes, gardé tel quel : l'usine corrige seule une panne du
  code, jusqu'à l'aperçu, dans ses plafonds (une correction par application sur 7 jours, trois par
  24 h). Une erreur Sentry, elle, reste une proposition. La console demande une confirmation.

La même carte compte les propositions à décider, en cours et suivies. Elle dit aussi quand Sentry
et PostHog ont été lus pour la dernière fois, ou pourquoi la lecture a échoué. C'est le moyen de
vérifier que les événements remontent. Chaque décision est notée dans l'Historique (filtres
« Pannes » et « Propositions »). Le contrat a une section `pilote` (`mode`,
`minutes_avant_action`, et les plafonds du mode « corriger »).

Limites connues :
- Une application sans module d'observabilité n'envoie rien à Sentry. Pour elle, seule la sonde
  compte.
- La mesure attend que la version en ligne change après le lancement. Une correction lancée et
  jamais mise en ligne est close au bout de 14 jours.
- Les « lignes d'erreur » que compte PostHog dépendent du niveau que le déployeur lit sur le texte
  de chaque ligne de journal. Les plantages Python et Node sont reconnus ; ceux d'autres langages,
  ou un niveau numérique (pino), comptent comme des lignes d'information.

## Le proposer à d'autres

`docs/INDUSTRIALISATION.md` : l'offre pour un hébergeur (clients visés, garanties,
architecture, dimensionnement, installation, exploitation, sécurité, ce qui reste à faire).

## Le contrat

`usine.config.yml` (créé depuis `usine.config.example.yml`, non suivi par Git) fixe les
limites : modèles par rôle, tentatives, approches, durées, périmètre protégé, politiques
(`mettre_en_production: manuel`, `supprimer_des_donnees: jamais`), mode démo.
Il est laissé au soin de la personne qui configure l'usine.

## Obstacles connus

- **DNS** : pas d'API DNS publique documentée chez l'hébergeur ; la démo utilise un DNS
  joker (sslip.io), et un domaine personnalisé demande un enregistrement créé par son
  propriétaire (`/usine domaine`, qui vérifie ensuite tout seul).
- **Petit serveur partagé** : un seul atelier, une tâche à la fois, les projets servis à
  tour de rôle (aucun ne fait attendre les autres) ; la construction des
  images et Chromium sont les pics de mémoire.
- **Limites d'usage des abonnements** (Claude, ChatGPT) : tester le parcours complet avant
  une démo ; une clé API plafonnée sert de secours.
