# Journal des versions

Chaque version publiée est une étiquette `vX.Y.Z` sur GitHub. Pour mettre une usine à jour :
le bouton « Mettre à jour l'usine » (console ou Slack), ou `bash update.sh` sur le serveur.
Le bloc **À faire** de chaque version liste les gestes à faire à la main ; s'il est vide, il
n'y a rien à faire.

Numérotation : `X` change quand une mise à jour demande un geste à la main ou casse une habitude,
`Y` pour une nouveauté, `Z` pour une correction.

## Non publié

Ce qui est sur `main` sans être encore dans une version.

- **À propos, dans la console** : Réglages, « À propos », montre la version de l'usine en service
  (`v1.2.0`, ou le commit sur le canal `main`), son canal, l'état des mises à jour et la date de
  la dernière vérification. Des liens mènent aux notes de cette version et à toutes les versions.
  Le bas du menu affiche aussi la version (« Usine v1.2.0 ») et ouvre cette page. Quand une
  mise à jour est disponible, la page la nomme, liste ce qui arrive et propose le bouton « Mettre
  à jour l'usine ».

## v1.2.0

Ce qui a été fusionné du 18 au 19 novembre 2026.

- **Le pilote des pannes** : quand une application en ligne tombe en panne à cause de son code
  (elle s'arrête à chaque démarrage, répond par une erreur ou ne répond plus) depuis 10 minutes,
  l'usine demande seule une correction. Le lot passe par la fabrique, le vérificateur et la recette,
  puis s'arrête à l'aperçu : la mise en ligne pour de vrai reste à une personne. Une cause hors du
  code (serveur, mémoire, plusieurs applications à la fois), un plafond atteint (trois corrections
  par 24 h pour l'usine) ou une panne qui revient dans la semaine qui suit une correction
  automatique de la même application : un message, et rien d'autre. Réglages : section `pilote` de
  `usine.config.yml`.
- **La boucle d'amélioration** : un nouveau mode, « proposer ». Un incident en production devient
  une proposition de correction, que l'on lance ou que l'on écarte depuis la console (Ce qui
  t'attend) ou depuis Slack, et rien ne part sans une personne. Deux sortes d'incidents en font
  naître une :
  - une panne due au code, vue par la sonde ;
  - une erreur Sentry nouvelle, qui revient ou en hausse, dans une application en production.

  Une proposition regroupe les signaux d'un même produit, avec les chiffres de PostHog. Lancée,
  elle devient une demande de corrections : le lot s'arrête à l'aperçu. Une fois en ligne, l'usine
  vérifie pendant 7 jours que l'incident ne revient pas (« tenue », ou « rechute » à proposer de
  nouveau). Quatre modes, dans la console (Règles de l'usine) : coupé, observer (par défaut),
  proposer et corriger. Même en « corriger », une erreur Sentry n'est que proposée.
- **L'analyste d'une correction reçoit ses connecteurs** (rôle « plan »), comme pour un plan. Sa
  consigne dit où chercher le produit dans Sentry et PostHog, quand il les a.
- **Connecteur PostHog** (lecture seule, serveur MCP de PostHog, clé personnelle « MCP Server »).
  Les connecteurs Sentry et PostHog sont conseillés aussi pour l'analyste (rôle « plan »).
  **À faire pour s'en servir** : dans la console, Connecteurs, colle le jeton de lecture de
  Sentry et la clé de PostHog, puis active-les pour « plan » et « construction ». Sans eux, la
  boucle marche avec la sonde seule. Le jeton Sentry ne part que vers sentry.io, la clé PostHog
  que vers PostHog (Europe ou États-Unis).
- **Documentation de l'observabilité** (`docs/OBSERVABILITE.md`) : brancher Sentry et PostHog,
  ce que l'usine et chaque produit envoient, quels produits envoient leurs propres erreurs (pas
  ceux fabriqués par une usine d'avant la v1.0.0, ni les dépôts repris avant cette version), ce qui n'est pas masqué
  (les noms, l'adresse d'une requête en erreur 500), lire et vérifier ce qui remonte, ce que fait
  le pilote des pannes, limites connues.
- **Le cliquet ne se réécrit plus en silence** : un test de `.usine/e2e/` qui échoue est une
  régression, que le codeur répare, sauf si un critère de la tâche en cours change exprès ce
  comportement. Le vérificateur cite ce critère, et l'usine vérifie qu'il existe et que le test
  réécrit passe lui-même. Si la réécriture déclarée ne tient pas, une personne tranche, sans
  tentative consommée. La réécriture d'un test qui passait est écartée. Chaque réécriture versée est
  dite dans la PR et au journal. Si elle n'a pas pu être versée, une alerte le dit.
- **Les tests écrits par le vérificateur sont lancés avant de rejoindre le cliquet** : un test qui
  échoue lui-même sur l'application n'y entre pas, et c'est dit au journal.
- **Le rejeu du cliquet est plafonné** : 15 minutes par vérification par défaut, 20 au plus
  (`autonomie.minutes_cliquet` dans `usine.config.yml`), dans un ordre tiré au sort. Les tests non
  rejoués faute de temps sont nommés au journal et passent en premier à la vérification suivante.
  Un test qui échoue est relancé une fois avant d'être compté.
- **Les plantages sont des erreurs dans les journaux** : une trace Python (`Traceback`, ses cadres,
  `KeyError: 'plan'`) ou une exception Node (`TypeError: …` et sa pile) part vers PostHog au
  niveau `error`, et non plus `info`. Une ligne ordinaire ne change pas de niveau.
- **La console dit ce que chaque application envoie vraiment** à Sentry et à PostHog (reçu, en
  échec, muet, non vérifié…), au lieu de « N sur N ont la dernière clé ». Chaque produit le
  dit à l'usine par `GET /_usine/observabilite`, que Caddy ne sert jamais au public.
- **Un dépôt repris envoie ses erreurs et son pouls**, dans sa pile. En Python, c'est un module
  avec `sentry-sdk` (`briques/reprise/observabilite.py`). L'épreuve de l'inventaire exige un
  vrai pouls avant d'aller plus loin.
- **Les applications peuvent utiliser ton propre serveur de modèles** (par exemple un GPU avec
  llama-server, API compatible OpenAI) : console, Réglages, Intégrations, « IA des applications ».
  Elles l'essaient d'abord, avec un délai court (après une panne, il est laissé de côté 5 minutes),
  puis la passerelle Vercel si elle est branchée, puis leur texte de secours : une application ne
  tombe jamais en panne à cause de l'IA, même quand la passerelle atteint son plafond. En http,
  l'adresse n'est permise que sur un réseau privé (réseau local, Tailscale). L'adresse et la
  clé restent dans la console, jamais dans le code. « Retirer l'IA aux applications » retire aussi
  le serveur de modèles. L'usine elle-même garde ses modèles : la fabrication et la vérification ne
  changent pas.

- **Correction** : `bash update.sh` s'arrêtait sans rien faire (code 141) quand plus de 25
  changements séparaient le serveur de la version demandée, ce qui est le cas pour passer à
  celle-ci. L'attente de la fin d'une tâche ne peut plus non plus se tromper pour la même raison.

**À faire** : rien pour l'usine avec le bouton « Mettre à jour l'usine » (console ou Slack). En
ligne de commande, l'ancien `update.sh` s'arrête (code 141) : lance plutôt, dans le dossier de
l'usine, `git fetch -q origin "+main:refs/remotes/origin/main" && git show origin/main:update.sh > .update-neuf.sh && bash .update-neuf.sh v1.2.0; rm -f .update-neuf.sh`.
À savoir pour les applications :

- Une application fabriquée par une usine d'avant la v1.0.0, ou reprise avant cette version,
  n'envoie pas ses propres erreurs : le module ne lui est pas ajouté de lui-même.
- Une application dont le module est plus ancien que cette version envoie, mais la console la dit
  « non vérifié » tant que son code n'a pas le module à jour et la route
  `GET /_usine/observabilite` (`docs/OBSERVABILITE.md`).
- Pour qu'une application déjà livrée utilise le serveur de modèles, elle doit recevoir le nouveau
  `server/llm.js` de la brique (une petite correction par application) ; les nouvelles
  applications l'ont d'office.
- Un test du cliquet devenu faux à cause d'un changement fait hors de l'usine (un commit direct,
  par exemple) bloquera les tâches suivantes jusqu'à ce qu'une personne le mette à jour ou le
  retire de `.usine/e2e/`.

## v1.1.1

Ce qui a été fusionné le 16 novembre 2026.

- **Correction** : le cliquet de non-régression n'avait jamais versé un seul test dans les
  produits. L'usine ne lisait pas les marqueurs dont le nom contient un chiffre (`E2E_NOUVEAUX`,
  `E2E_TOTAL`, `E2E_ECHECS`) : les tests écrits par le vérificateur restaient dans son dossier.
  Désormais, chaque critère validé qui s'observe dans l'application devient un test de
  `.usine/e2e/`, rejoué à chaque tâche suivante. Relevé par l'audit du vérificateur du 16 novembre
  2026 (six bugs plantés dans Vigie Copro).

**À faire** : rien. L'atelier et le vérificateur sont reconstruits par la mise à jour.

## v1.1.0

Ce qui a été fusionné du 13 au 14 novembre 2026.

- **Branchements depuis la console** : Sentry, PostHog, l'envoi d'emails, Slack et la clé d'IA des
  applications se règlent dans Réglages, Intégrations. On colle, on teste, sans SSH ni redémarrage.
  Les clés passent au déployeur par une boîte en mémoire, jamais par GitHub ni vers les agents.
  « Appliquer aux applications » redéploie après confirmation, et la production passe par une PR.
- **File d'attention** : ce qui attend une personne est rangé en À décider, À débloquer et
  À réparer, avec le même compte à l'accueil, dans Visibilité, dans le titre de l'onglet et dans les
  notifications. On décide sur place, avec 5 s pour annuler. Les chiffres sont donnés avec leur
  nombre d'essais, et les échecs sont regroupés par cause.
- **Déconnexion** : un bouton « Se déconnecter » dans la console. `/_portier/deconnexion`, sur
  chaque adresse protégée, ferme aussi la session côté serveur : le même cookie, rejoué ensuite,
  est refusé. Un lien venu d'un autre site demande confirmation. Les sessions ouvertes avant cette
  version restent valables jusqu'à leur expiration (personne n'est déconnecté par la mise à jour).
- **Emails de l'usine toujours chiffrés** : hors TLS direct (port 465), STARTTLS est désormais
  exigé. Un serveur d'envoi qui ne le propose pas est refusé avant l'envoi du mot de passe.
- **Correction** : le chemin de retour de la page de connexion ne peut plus mener vers un autre site
  (une tabulation, retirée par le navigateur, le permettait).
- **Correction** : `update.sh` et la vérification des mises à jour du déployeur n'utilisent plus
  `git fetch --prune` : avec, la lecture des versions échouait sur un serveur en Git 2.34 (Ubuntu 22.04).
- **Correction** : le déployeur ne compte plus un message d'erreur de git comme des changements
  disponibles (« 3 changements » annoncés alors que tout était à jour) ; une cible illisible est
  signalée comme une erreur.
- **Correction** : `update.sh` ne présente plus les secrets (chiffrés, donc absents de `.env`) comme
  des réglages nouveaux.

**À faire** : rien. La table du portier et la boîte en mémoire se créent toutes seules au
démarrage. Si les invitations partaient par un serveur d'envoi sans chiffrement, choisis TLS direct
(port 465) ou un autre serveur, puis lance « Tester » (Réglages, Intégrations, Envoi d'emails).

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
