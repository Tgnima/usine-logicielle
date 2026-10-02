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
- **Les secrets** : les agents ne voient jamais le jeton GitHub (il ne sert qu'aux étapes
  de clone et de push, hors de l'agent), ni Slack. Seul le déployeur a accès à Docker,
  et il n'a aucun port ouvert.

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
| `caddy` | HTTPS automatique devant les produits | ports 80, 443 |
| `mailpit` | Capture les emails des produits (démo) | — |

Les produits partent tous d'une **brique** (`briques/webapp` : Node 24, Express 5, SQLite,
React 19, Vite, Tailwind 4) et de ses conventions (`AGENTS.md`). En démo, ils se remplissent
de données fictives, leur horloge est accélérée (un jour = une minute), et leurs emails
sont capturés par Mailpit.

Adresses (DNS joker via sslip.io, rien à configurer) :
aperçu `https://<produit>.apercu.<base>`, production `https://<produit>.<base>`,
emails capturés `https://mails.apercu.<base>`.

## Installer

Prérequis : un serveur avec Docker (1 CPU / 4 Go suffisent pour la démo, avec du swap),
les ports 80 et 443 libres.

1. **GitHub** : un jeton fine-grained sur le compte qui recevra les produits, accès à tous
   les dépôts, permissions *Administration*, *Contents*, *Issues*, *Pull requests* en
   lecture/écriture.
2. **Slack** (facultatif) : créer l'application depuis `slack-manifest.yml`, l'installer,
   générer le jeton d'application (`connections:write`), inviter le bot dans le canal.
3. Sur le serveur :

   ```bash
   git clone https://github.com/<toi>/usine-logicielle.git && cd usine-logicielle
   bash install.sh            # crée .env et usine.config.yml, puis s'arrête s'il manque un secret
   nano .env                  # colle tes jetons (jamais dans une conversation)
   bash install.sh            # construit et démarre
   ```

   Sur un serveur où l'usine à contenu tourne déjà : `bash install.sh --reprendre-de ../usine-contenu`
   réutilise sa connexion Claude, sa clé Vercel AI Gateway et son volume Codex.
4. Codex, si ce n'est pas déjà fait : `docker compose run --rm verificateur codex login --device-auth`.

## Piloter

Dans Slack : `/usine <ce que tu veux construire>`, puis les boutons du fil.
`/usine statut`, `/usine stop` (après la tâche en cours), `/usine reprendre`.

Sans Slack, la CLI fait la même chose :

```bash
docker compose exec orchestrateur node src/cli.mjs nouveau "Une app de prospection…"
docker compose exec orchestrateur node src/cli.mjs plan 1
docker compose exec orchestrateur node src/cli.mjs valider 1
docker compose exec orchestrateur node src/cli.mjs journal 1
docker compose exec orchestrateur node src/cli.mjs decider 3 A "utilise une table séparée"
docker compose exec orchestrateur node src/cli.mjs production 1
```

## Le contrat

`usine.config.yml` (créé depuis `usine.config.example.yml`, non suivi par Git) fixe les
limites : modèles par rôle, tentatives, approches, durées, périmètre protégé, politiques
(`mettre_en_production: manuel`, `supprimer_des_donnees: jamais`), mode démo.
Il est laissé au soin de la personne qui configure l'usine.

## Obstacles connus

- **DNS** : pas d'API DNS publique documentée chez l'hébergeur ; la démo utilise un DNS
  joker (sslip.io) et les domaines de production se branchent à la main.
- **Petit serveur partagé** : un seul atelier, une tâche à la fois ; la construction des
  images et Chromium sont les pics de mémoire.
- **Limites d'usage des abonnements** (Claude, ChatGPT) : tester le parcours complet avant
  une démo ; une clé API plafonnée sert de secours.
