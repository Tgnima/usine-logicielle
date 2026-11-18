# Observabilité : erreurs, état et journaux

Ce que l'usine envoie à Sentry et à PostHog, comment le brancher, comment le lire et comment
vérifier que ça arrive. Écrit d'après le code de `main` du 18 novembre 2026 (après la v1.1.1),
puis mis à jour le 19 novembre avec la PR #23 : chaque produit dit à l'usine ce qu'il envoie, les
plantages sont des erreurs dans les journaux, et un dépôt repris envoie ses erreurs et son pouls.
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
- **La console dit, application par application**, si son pouls arrive à PostHog et si ses
  erreurs arrivent à Sentry : voir « Vérifier que ça remonte ».
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
| PostHog (journaux) | Les nouvelles lignes de `docker logs` du conteneur en service de chaque produit (celui qu'indique `statut.json`). `service.name` porte le slug, `deployment.environment` l'environnement. Le niveau (`error`, `warn`, `info`) se lit sur le texte de la ligne (voir plus bas) | Environ une fois par minute au calme (tous les trois tours du déployeur), au plus 200 lignes par conteneur et par passage. Au premier passage après la pose du jeton, ses 200 dernières lignes partent d'un coup |

La raison d'une panne est écrite par la sonde du déployeur, par exemple : « ne répond pas à
/api/health », « /api/health répond 500 », « arrêté (exited, code de sortie 1) », « redémarre en
boucle ».

**Le niveau d'une ligne de journal** (`niveauDe` et `niveauxDe`, `deployeur/observation.mjs`) :
- `error` : un mot comme « error », « erreur », « exception », « fatal », « échec » ; `CRITICAL` ;
  et un plantage, de bout en bout. En Python : `Traceback (most recent call last):`, les cadres
  (`File "/app/main.py", line 10`), le code, puis la ligne de l'exception (`KeyError: 'plan'`,
  `sqlite3.OperationalError: …`, même si son nom ne finit pas par `Error`). En Node :
  `TypeError: …` ou `TypeError [ERR_…]: …`, puis sa pile (les lignes en retrait qui suivent) ;
- `warn` : « warning », « deprecated », ou une classe d'avertissement (`DeprecationWarning: …`) ;
- `info` : le reste. Le nom d'une exception ne compte qu'en tête de ligne : « KeyError handling
  enabled » ou « Envoi impossible (TypeError: fetch failed) » restent des informations.

**Ce que la sonde lit aussi**, chaque minute, sans rien envoyer : `GET /_usine/observabilite`
de chaque produit qui répond, pour savoir ce qu'il envoie lui-même (voir « Vérifier que ça
remonte »).

### Ce que le produit envoie lui-même, s'il a le module

Un produit fabriqué à partir d'une brique (`webapp`, et ses surcouches `site`, `api` et `pwa`)
contient `server/observabilite.js`, branché dans `server/demarrage.js`. Un dépôt repris par une
usine qui contient la PR #23 a le module de sa pile dans `usine/` : celui de la brique en Node
(`usine/observabilite.mjs`), `usine/observabilite.py` en Python (`briques/reprise/`, avec
`sentry-sdk`). Ces modules envoient, côté serveur seulement :

| Vers | Quoi | Quand |
|---|---|---|
| Sentry | Les erreurs du produit : chaque `console.error`, chaque exception non attrapée, et ce que le code signale avec `signalerErreur(error)`. Avec la pile d'appels, l'environnement et la version | À chaque erreur |
| PostHog | `pouls` (distinct_id `produit:<slug>`) : le slug, l'environnement, la version, puis des nombres seulement : les compteurs métier ajoutés par `ajouterPouls()` (`ajouter_pouls()` en Python), les erreurs depuis le démarrage, la durée de marche et la mémoire | 30 s après le démarrage (`USINE_PREMIER_POULS_S` peut l'avancer), puis toutes les 5 minutes |

En Python, les erreurs passent par `sentry-sdk`, initialisé avec `SENTRY_DSN`,
`USINE_ENVIRONNEMENT` et `USINE_VERSION` : les exceptions non attrapées, celles des requêtes
(intégrations de `sentry-sdk`), chaque `logging.error`, et `signaler_erreur(exc)`. Sous gunicorn
avec plusieurs workers, chaque worker envoie son propre pouls.

Chaque module répond aussi `GET /_usine/observabilite` : démarré ou non, clés présentes ou non,
et la réponse de Sentry et de PostHog à son dernier envoi (des comptes et des dates, jamais une
clé). Caddy répond 404 à `/_usine/*` au public, que l'application soit protégée ou publique
(`CHEMINS_INTERNES`, `deployeur/chemins.mjs`) : seul le déployeur la lit, sur le réseau du produit.

**Quels produits envoient leurs propres erreurs :**

| Produit | Erreurs de l'application et pouls | État, pannes, déploiements, journaux |
|---|---|---|
| Fabriqué à partir d'une brique par une usine qui contient la PR #9 (sur `main` depuis le 12 novembre 2026, première version publiée : v1.0.0) | Oui, dès que l'application a reçu les clés. La console ne peut le vérifier qu'avec un module qui publie `GET /_usine/observabilite` (PR #23 et après) : sinon, elle dit « non vérifié » | Oui |
| Fabriqué par une usine plus ancienne | Non : le module n'est copié qu'à la création du dépôt, et une mise à jour de l'usine ne l'ajoute pas. Il faut l'ajouter au produit : copier `server/observabilite.js` de la brique, appeler `demarrerObservabilite()` dans `server/demarrage.js`, ajouter la route `GET /_usine/observabilite` dans `server/index.js` (comme carnet-citations #6, prospecta #78, pret-asso #23) | Oui |
| **Repris** d'un dépôt existant, par une usine qui contient la PR #23 | Oui, en Node comme en Python : le module de sa pile est dans `usine/`, et l'épreuve de l'inventaire a exigé un vrai pouls (voir plus bas) | Oui |
| **Repris** par une usine plus ancienne | Non : la reprise ne mettait le dépôt qu'au contrat d'hébergement (Dockerfile, port, `/api/health`, dossier de données). **Mais** le déployeur lui donne quand même `SENTRY_DSN`, `POSTHOG_TOKEN` et `POSTHOG_HOTE` : si son code contient déjà un kit Sentry ou PostHog qui lit ces variables, il enverra dans les projets de l'usine, sans le masquage ni les plafonds de l'usine | Oui |

**La reprise d'un dépôt** (`orchestrateur/src/reprise.mjs`). L'agent de l'inventaire copie tel quel
le module de la pile du dépôt dans `usine/`, l'appelle au démarrage et ajoute la route ; en Python,
il ajoute `sentry-sdk` aux dépendances. L'épreuve démarre ensuite l'application devant un faux
Sentry et un faux PostHog locaux. Elle exige le module intact (celui de sa pile), un pouls de
compteurs reçu, sans profil ni géolocalisation, et la route. Sinon, l'agent a un second essai,
puis la reprise s'arrête, expliquée. Les deux fichiers du module sont ensuite protégés
(`PROTEGES_REPRIS`, `orchestrateur/src/profil.mjs`).

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
- Le module Python des dépôts repris masque de la même façon : les mêmes cas
  (`briques/reprise/cas-masquage.json`) sont rejoués par les tests de l'usine et par ceux du module.
  Il n'envoie à Sentry ni variables locales, ni code source, ni corps, en-têtes ou paramètres de
  requête, ni utilisateur, ni fil d'Ariane : seulement la méthode et le chemin d'une requête.
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
   - pour Sentry et PostHog, **chaque application** : ce qu'elle fait vraiment de la clé.
2. **L'état de chaque application** vient de ce que son module répond sur
   `GET /_usine/observabilite`, lu chaque minute par la sonde du déployeur
   (`envoisApplication`, `orchestrateur/src/services.mjs`). Ce qui demande quelque chose vient en
   premier, ce qui va bien est regroupé sur une ligne :
   - *reçu* : PostHog a accepté un pouls il y a moins de 15 minutes ; Sentry a accepté sa
     dernière erreur ;
   - *en échec* : le dernier envoi a été refusé ou n'a pas abouti, avec la raison (clé refusée,
     quota atteint, pas de réponse à temps, service injoignable) ;
   - *muet* : plus aucun pouls depuis 15 minutes, ou aucun après 10 minutes de marche ;
   - *n'envoie rien* : la clé est là, mais l'envoi n'est pas démarré dans son code, ou
     `sentry-sdk` manque (Python) ;
   - *non vérifié* : elle ne publie pas la route. Son module manque, ou il est plus ancien que la
     PR #23 (acte-clair et vigie-copro envoient leur pouls sans la publier). Rien ne prouve alors
     qu'elle envoie ;
   - *sans clé*, *en attente* (premier pouls à venir), *prête* (Sentry : aucune erreur à envoyer)
     ou *sans nouvelles* (pas de réponse, ou une sonde de plus de 3 minutes).

   Les applications qui n'ont pas la dernière version des clés **posées dans la console** sont
   nommées, avec **Appliquer maintenant**. Avec des clés posées seulement sur le serveur, toutes
   les applications sont comptées à jour, même celles lancées avant la clé, et **Appliquer
   maintenant** n'apparaît pas : redéploie-les pour qu'elles la reçoivent.
3. **« Reçu » veut dire que le service a répondu 2xx.** Sentry refuse une clé inconnue. PostHog,
   lui, accepte un pouls même avec un jeton inconnu : c'est le bouton **Tester** qui juge le
   jeton. La preuve finale reste ce que montrent Sentry et PostHog : un sujet dans Sentry, un
   événement ou une ligne de journal dans PostHog. La requête SQL ci-dessus le montre produit par
   produit.

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
  au plus. Le module Python applique les mêmes plafonds. Le plafond vaut séparément pour l'orchestrateur, pour le déployeur, et pour chaque
  produit dans chaque environnement.
- Pour le déployeur, les incidents de panne comptent dans ce plafond : au-delà de 20 par heure,
  des pannes ne partent plus.
- Ces plafonds limitent une erreur qui boucle, mais ils ne garantissent pas de rester dans le
  quota gratuit de Sentry : 20 erreurs par heure pendant un mois, c'est bien plus que ce quota.
  Le quota est commun à l'usine et à tous ses produits, puisqu'ils partagent la même clé.

## Limites connues

- **Les produits fabriqués avant la PR #9 (v1.0.0) et ceux repris avant la PR #23** n'envoient
  pas leurs propres erreurs (voir le tableau plus haut). Ils restent suivis par le déployeur. Une
  mise à jour de l'usine ne leur ajoute pas le module : il faut le leur ajouter.
- **Les modules d'avant la PR #23** (acte-clair, vigie-copro) envoient sans le dire à l'usine :
  la console les dit « non vérifié » tant que leur code n'a pas le module à jour et la route.
- **Le niveau des lignes de journal est lu sur leur texte.** Les plantages Python et Node sont
  reconnus, mais pas ceux d'autres langages, ni un niveau numérique dans un journal JSON (pino).
  Une trace dont le début est sorti des 200 dernières lignes n'est plus reconnue.
- **Les journaux d'un conteneur très bavard peuvent être tronqués** : au plus 200 lignes par
  conteneur et par passage.
- **Le module des produits issus d'une brique n'est pas protégé.** `server/observabilite.js` et
  `server/demarrage.js` ne sont pas dans le périmètre protégé : la consigne « Ne modifie pas »
  n'empêche pas une tâche de retirer le masquage ou le branchement. Celui d'un dépôt repris l'est
  (`usine/observabilite.mjs` ou `.py`), mais pas l'appel au démarrage ni la route. Si une tâche
  les retire, la console le montre : « n'envoie rien » ou « non vérifié ».
- **Une même clé pour tous** : un produit pourrait envoyer des événements au nom d'un autre, ou
  épuiser le quota (voir `docs/SECURITE.md`).
- **Pas de boucle automatique** de l'incident à la correction (voir « Les IA, les journaux et
  Sentry »).
