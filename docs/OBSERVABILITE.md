# Observabilité : erreurs, état et journaux

Ce que l'usine envoie à Sentry et à PostHog, comment le brancher, comment le lire et comment
vérifier que ça arrive. Écrit d'après le code de `main` du 18 novembre 2026 (après la v1.1.1).
Les chemins des écrans de Sentry et de PostHog sont ceux de cette date : ces services peuvent
les changer. Tout est facultatif : sans clé, rien ne part.

## En bref

- **Sentry** reçoit les erreurs de l'orchestrateur, les exceptions non attrapées du déployeur,
  les erreurs des produits qui ont le module d'envoi, et un incident quand un produit tombe en
  panne. Il reçoit aussi un battement de cœur de l'orchestrateur, chaque minute.
- **PostHog** reçoit des événements (le journal de l'usine, l'état et les déploiements de chaque
  produit, le pouls des produits qui ont le module) et les journaux des conteneurs des produits.
- **Une seule clé Sentry et un seul jeton PostHog** servent à l'usine et à tous ses produits.
  Chaque envoi porte l'identifiant du produit (son slug, par exemple `vigie-copro`).
- **Ce qui sort est nettoyé**, mais pas tout : voir « Ce qui est masqué, et ce qui ne l'est pas ».

## Brancher Sentry et PostHog

Chaque installation utilise ses propres comptes. Créer les comptes en région européenne est
recommandé : pour une clé hors d'Europe (Sentry hors de sa région européenne, PostHog États-Unis),
la console demande une confirmation explicite.

1. **Sentry** : sur sentry.io, crée un projet (région Union européenne, plateforme Node.js).
   Dans Settings, Projects, ton projet, **Client Keys (DSN)**, copie la clé d'envoi. Elle commence
   par `https://`.
2. **PostHog** : sur posthog.com, crée un projet en région Europe. Dans Settings, Project, copie le
   **Project token**. Il commence par `phc_`. Jamais une clé personnelle `phx_` : la console la
   refuse.
3. Dans la console, **Réglages, Intégrations, Sentry** (puis PostHog) : colle la clé, puis
   **Tester**.
   - Le test Sentry envoie un battement de cœur et dit si Sentry l'a accepté.
   - Le test PostHog interroge une adresse qui refuse un jeton inconnu. Un simple envoi
     d'événement ne prouve rien : constaté le 13 novembre 2026, PostHog l'accepte même avec un
     mauvais jeton.
4. **Appliquer aux applications.** L'orchestrateur prend la clé tout de suite, et le déployeur
   dans les 30 secondes. Les applications ne la reçoivent qu'à leur prochaine mise en ligne, ou
   par **Appliquer maintenant**. Ce bouton redémarre les applications concernées avec la même
   version du code. Une production repasse par une mise en ligne complète : sauvegarde, puis
   bascule.

Autres gestes dans la même fenêtre :
- **Couper l'envoi** arrête les envois de l'orchestrateur tout de suite, et ceux du déployeur dans
  les 30 secondes, même si le serveur a sa propre clé. Une application déjà lancée garde ses clés
  jusqu'à sa prochaine mise en ligne, ou jusqu'à **Appliquer maintenant**. La clé de la console
  est gardée : **Ne plus couper** la rebranche.
- **Retirer** efface ce que la console a enregistré, et rend la main à la clé du serveur.
- Pour PostHog, la **région** se choisit au même endroit : Europe, États-Unis, ou l'adresse d'un
  relais de l'entreprise. **Revenir à la région du serveur** annule ce choix.

Sans la console, les clés se posent sur le serveur : `SENTRY_DSN` et `POSTHOG_TOKEN` sont des
secrets (voir le README, partie sur les secrets, et `.env.example`), `POSTHOG_HOTE` est un simple
réglage de `.env`. L'orchestrateur ne relit les clés du serveur qu'à son démarrage : la console
évite ce redémarrage. Une clé posée dans la console passe avant celle du serveur.

## Ce qui part, et d'où

### L'usine elle-même

| Qui envoie | Vers | Quoi | Quand |
|---|---|---|---|
| Orchestrateur | Sentry | Ses erreurs : chaque `console.error` et les exceptions non attrapées. Service `usine-orchestrateur` | À chaque erreur |
| Orchestrateur | Sentry | Un battement de cœur, moniteur `usine-orchestrateur`. L'envoi porte la configuration du moniteur (`monitor_config`), pour que Sentry le crée de lui-même : rien à régler à la main | Chaque minute |
| Orchestrateur | PostHog | Un événement `journal` par ligne du journal de l'usine : type, projet, produit, tâche, lot, tentative, et la consommation **cumulée** de la tâche (ou du projet) à ce moment : appels aux modèles, durée, coût équivalent API, jetons. **Jamais le texte du message** | À chaque ligne |
| Déployeur | Sentry | Ses exceptions non attrapées seulement, service `usine-deployeur`. Ses échecs ordinaires (un tour, une construction, une sonde) restent dans son propre journal | À chaque exception |

Les nombres d'un événement `journal` sont un cumul : les additionner d'une ligne à l'autre compte
plusieurs fois la même consommation. Prends la dernière valeur d'une tâche.

**Seul l'orchestrateur a un battement de cœur.** Une panne du déployeur, d'un atelier, du
vérificateur, du portier ou de Caddy ne crée rien dans Sentry : elle donne une alerte Slack (ou
dans la console) et une ligne « À réparer ». Si le déployeur s'arrête, plus aucun état de produit
ni incident de produit ne part.

### Ce que le déployeur voit de chaque produit, quel que soit son code

Le déployeur regarde chaque produit de l'extérieur. Ces envois existent donc pour **tous** les
produits, quelle que soit leur pile (Node, Python, etc.).

| Vers | Quoi | Quand |
|---|---|---|
| PostHog | `etat_produit` (distinct_id `produit:<slug>`) : état (`ok`, `alerte`, `panne`, ou `inconnu` pendant un déploiement), raison, version, état du dernier déploiement, état Docker, code et temps de réponse de `/api/health`, redémarrages des 30 dernières minutes, mémoire dépassée, et s'il s'agit d'un changement (avec l'état précédent) | Toutes les 5 minutes, et à chaque changement d'état |
| Sentry | Un incident « `<slug> (<environnement>) en panne : <raison>` ». Toutes les pannes d'un même produit, dans un même environnement, ont la même empreinte : elles vont dans un seul sujet | Quand la panne est vue sur deux relevés de suite (un relevé par minute) |
| PostHog | `deploiement` : résultat (`ok`, `echec`, `abandonne`), durée, reprise, couleur, raison d'un échec (sa première ligne) | À chaque mise en ligne |
| PostHog (journaux) | Les nouvelles lignes de `docker logs` du conteneur en service de chaque produit (celui qu'indique `statut.json`). `service.name` porte le slug, `deployment.environment` l'environnement. Le niveau (`error`, `warn`, `info`) est deviné d'après des mots de la ligne | Environ une fois par minute au calme (tous les trois tours du déployeur), au plus 200 lignes par conteneur et par passage. Au premier passage après la pose du jeton, ses 200 dernières lignes partent d'un coup |

La raison d'une panne est écrite par la sonde du déployeur, par exemple : « ne répond pas à
/api/health », « /api/health répond 500 », « arrêté (exited, code de sortie 1) », « redémarre en
boucle ».

### Ce que le produit envoie lui-même, s'il a le module

Un produit fabriqué à partir d'une brique (`webapp`, et ses surcouches `site`, `api` et `pwa`)
contient `server/observabilite.js`, branché dans `server/demarrage.js`. Ce module envoie, côté
serveur seulement :

| Vers | Quoi | Quand |
|---|---|---|
| Sentry | Les erreurs du produit : chaque `console.error`, chaque exception non attrapée, et ce que le code signale avec `signalerErreur(error)`. Avec la pile d'appels, l'environnement et la version | À chaque erreur |
| PostHog | `pouls` (distinct_id `produit:<slug>`) : le slug, l'environnement, la version, puis des nombres seulement : les compteurs métier ajoutés par `ajouterPouls()`, les erreurs depuis le démarrage, la durée de marche et la mémoire | 30 s après le démarrage, puis toutes les 5 minutes |

**Quels produits envoient leurs propres erreurs :**

| Produit | Erreurs de l'application et pouls | État, pannes, déploiements, journaux |
|---|---|---|
| Fabriqué à partir d'une brique par une usine qui contient la PR #9 (sur `main` depuis le 12 novembre 2026, première version publiée : v1.0.0) | Oui, dès que l'application a reçu les clés | Oui |
| Fabriqué par une usine plus ancienne | Non : le module n'est copié qu'à la création du dépôt, et une mise à jour de l'usine ne l'ajoute pas. Il faut l'ajouter au produit, par exemple par une demande de corrections | Oui |
| **Repris** d'un dépôt existant, quelle que soit sa pile | Non : la reprise ne met le dépôt qu'au contrat d'hébergement (Dockerfile, port, `/api/health`, dossier de données). **Mais** le déployeur lui donne quand même `SENTRY_DSN`, `POSTHOG_TOKEN` et `POSTHOG_HOTE` : si son code contient déjà un kit Sentry ou PostHog qui lit ces variables, il enverra dans les projets de l'usine, sans le masquage ni les plafonds de l'usine | Oui |

## Ce qui est masqué, et ce qui ne l'est pas

- Tout texte envoyé par le module commun et par le module des produits passe par `nettoyer()` :
  les adresses email, les numéros de téléphone, les IBAN, les adresses IP et les jetons ou
  secrets reconnaissables sont remplacés par `[email]`, `[téléphone]`, `[iban]`, `[ip]`,
  `[secret]` ou `[jeton]`.
- **Un nom de personne n'est pas masqué**, ni un texte libre. Un produit ne doit jamais en écrire
  dans ses journaux : c'est une consigne des agents (`briques/webapp/AGENTS.md`), pas un blocage.
- **L'adresse complète d'une requête qui échoue part** : en cas d'erreur 500, la brique écrit la
  méthode et l'URL, chemin et paramètres compris (`server/securite.js`). Cette ligne va vers
  Sentry et vers les journaux. Un nom ou un texte saisi dans une URL sortirait donc tel quel.
- Les événements PostHog ne créent aucun profil de personne (`$process_person_profile: false`) et
  demandent à PostHog de ne pas les géolocaliser (`$geoip_disable: true`). Vérifié le 12 novembre
  2026 : les pouls arrivent sans ville ni coordonnées.
- Rien ne part du navigateur d'un produit fabriqué à partir d'une brique : sa politique de
  sécurité (CSP) l'interdit. Ce n'est pas garanti pour un produit repris.

## Lire les données

**Dans Sentry :**
- **Issues** : filtre par l'étiquette `service` (`usine-orchestrateur`, `usine-deployeur`, ou le
  slug d'un produit) et par environnement (`production`, `apercu`).
- Les pannes signalées par le déployeur ont leur propre sujet par produit et par environnement,
  avec les étiquettes `produit`, `version` et `deploiement`. Elles n'ont pas de pile d'appels :
  c'est le déployeur qui a vu la panne, pas l'application.
- **Crons** : le moniteur `usine-orchestrateur`. Il est réglé pour que Sentry ouvre un sujet
  après deux battements manqués de suite (`failure_issue_threshold: 2`).
- Les alertes par e-mail ou Slack se règlent dans Sentry. L'usine envoie déjà ses propres alertes
  Slack quand l'état d'un composant ou d'un produit change.

**Dans PostHog :**
- **Activité / Événements** : filtre sur `etat_produit`, `deploiement`, `pouls` ou `journal`, et
  sur le distinct_id `produit:<slug>` pour un produit.
- **Logs** : filtre sur le service (le slug du produit) et sur le niveau.
- **SQL** : pour voir d'un coup quels produits envoient quoi sur les dernières 24 heures (requête
  essayée sur une vraie installation le 18 novembre 2026) :

```sql
SELECT
    replaceAll(distinct_id, 'produit:', '') AS produit,
    countIf(event = 'etat_produit') AS etats_vus_par_le_deployeur,
    countIf(event = 'pouls') AS pouls_de_l_application,
    max(timestamp) AS dernier_envoi
FROM events
WHERE timestamp >= now() - INTERVAL 1 DAY
    AND event IN ('etat_produit', 'pouls')
    AND distinct_id LIKE 'produit:%'
GROUP BY produit
ORDER BY produit
```

Un produit qui a des `etat_produit` mais aucun `pouls` est suivi par le déployeur, mais
n'envoie pas ses propres erreurs : il n'a pas le module, ou n'a pas encore reçu les clés.

## Vérifier que ça remonte

1. **Dans la console**, la fenêtre de chaque service montre :
   - pour l'orchestrateur, une ligne par canal (signal de vie, erreurs, journal de l'usine) :
     quand le dernier envoi a réussi, ou depuis quand les envois échouent, et pourquoi ;
   - pour le déployeur, une seule ligne : le premier canal en échec, sinon son dernier envoi
     réussi ;
   - rien sur ce que les produits envoient eux-mêmes.
2. **« Les applications : N sur N ont la dernière clé »** compte les applications qui ont reçu la
   dernière version des clés **posées dans la console**. Ce n'est pas la preuve qu'elles s'en
   servent : une application sans module les reçoit aussi. Avec des clés posées seulement sur le
   serveur, toutes les applications sont comptées à jour, même celles lancées avant la clé, et
   **Appliquer maintenant** n'apparaît pas : redéploie-les pour qu'elles la reçoivent.
3. **La preuve** est ce que montrent Sentry et PostHog : un sujet dans Sentry, un événement ou
   une ligne de journal dans PostHog. La requête SQL ci-dessus le montre produit par produit.

## Les IA, les journaux et Sentry

- **Les journaux** : quand une correction est demandée, l'analyste qui enquête lit les dernières
  lignes (120 au plus) des journaux du produit, en aperçu et en production. Il les lit dans la
  copie locale du déployeur, pas dans PostHog.
- **Sentry** : le connecteur Sentry (**Réglages, Connecteurs**) donne aux IA un accès en lecture
  aux erreurs, avec un autre jeton que la clé d'envoi : un jeton d'accès Sentry en lecture. Il est
  proposé pour le rôle « construction » (les agents de l'atelier). L'analyste (rôle « plan ») ne
  l'a que si on le lui donne, et aucune consigne des IA ne leur dit de consulter Sentry.
- **PostHog** : il n'existe pas de connecteur. Aucune IA ne lit les événements ni les journaux
  dans PostHog.
- **Aucune correction ne part toute seule d'un incident.** Une panne donne une alerte Slack, un
  sujet Sentry et une ligne « À réparer » dans la file d'attention de la console. C'est une
  personne qui demande ensuite la correction.

## Plafonds d'envoi

- Pour chaque processus, une même erreur ne part qu'une fois par heure, et 20 erreurs par heure
  au plus. Le plafond vaut séparément pour l'orchestrateur, pour le déployeur, et pour chaque
  produit dans chaque environnement.
- Pour le déployeur, les incidents de panne comptent dans ce plafond : au-delà de 20 par heure,
  des pannes ne partent plus.
- Ces plafonds limitent une erreur qui boucle, mais ils ne garantissent pas de rester dans le
  quota gratuit de Sentry : 20 erreurs par heure pendant un mois, c'est bien plus que ce quota.
  Le quota est commun à l'usine et à tous ses produits, puisqu'ils partagent la même clé.

## Limites connues

- **Les produits fabriqués avant la PR #9 et les produits repris** n'envoient pas leurs propres
  erreurs (voir le tableau plus haut). Ils restent suivis par le déployeur.
- **Le niveau des lignes de journal est deviné.** Une ligne d'exception comme
  `ZeroDivisionError: division by zero`, `KeyError: 'plan'`, `TypeError: …` ou
  `Traceback (most recent call last):` est classée `info`. Seules les lignes qui contiennent un
  mot comme « error » ou « exception » isolé sont classées `error`.
- **Les journaux d'un conteneur très bavard peuvent être tronqués** : au plus 200 lignes par
  conteneur et par passage.
- **Le module des produits n'est pas protégé.** `server/observabilite.js` et
  `server/demarrage.js` ne sont pas dans le périmètre protégé : la consigne « Ne modifie pas »
  n'empêche pas une tâche de retirer le masquage ou le branchement.
- **Une même clé pour tous** : un produit pourrait envoyer des événements au nom d'un autre, ou
  épuiser le quota (voir `docs/SECURITE.md`).
- **Pas de boucle automatique** de l'incident à la correction (voir « Les IA, les journaux et
  Sentry »).
