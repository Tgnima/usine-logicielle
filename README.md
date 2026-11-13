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
   `$DATA_DIR`) sans ajouter de fonctionnalité, et dit ce qui marche, ce qui est cassé, ce qui
   manque. Le **code** éprouve ensuite chaque commande (installation, build, tests, démarrage,
   santé) : un dépôt qui ne démarre pas s'arrête là, expliqué. Les commandes deviennent le
   profil du projet (`.usine/profil.json`, protégé), utilisé par l'atelier et le vérificateur.
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
  envoi porte le produit en étiquette.
  - Vers Sentry partent les erreurs de l'orchestrateur et du déployeur, un battement de cœur
    par minute (moniteur `usine-orchestrateur`) et un incident quand un produit tombe en panne.
  - Vers PostHog partent un événement par ligne du journal de l'usine (sans son texte),
    l'état de chaque produit toutes les 5 minutes, ses déploiements et les journaux de ses
    conteneurs.
  - Les produits reçoivent les mêmes clés. Rien de personnel ne sort : adresses email,
    téléphones, IBAN, adresses IP et jetons sont masqués (`commun/observabilite.mjs`).
  - Les clés se posent aussi dans la console (Réglages, Intégrations, Sentry ou PostHog), sans
    SSH ni redémarrage : chiffrées dans le coffre, elles servent tout de suite à l'orchestrateur,
    au déployeur dans les 30 s (par la boîte, un volume en mémoire vive), et aux applications à
    leur prochaine mise en ligne ou par « Appliquer ». « Couper l'envoi » l'emporte sur la valeur
    du serveur ; « Retirer » la rend.

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
