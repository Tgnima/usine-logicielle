# Sécurité de l'usine logicielle

Audit du 30 octobre 2026, fait avant que le projet soit repris par une autre équipe.
Sont couverts : les routes HTTP (portier, console, serveurs de travaux), Slack, le déployeur,
les secrets et l'installation. Les corrections sont dans la branche `securite/audit-reprise`.

## Surface exposée

| Composant | Exposé à | Protection |
|---|---|---|
| Caddy (80, 443) | Internet | HTTPS, portier devant chaque adresse, `/_portier/api/*` bloqué |
| Portier `/_portier/*` | Internet (via Caddy) | sessions HMAC liées à l'adresse, essais limités |
| Portier `/_portier/api/*` | réseau `usine` | jeton `portier_api_token` |
| Console `:8091` (`/api/*`) | Internet (via Caddy et portier) | session d'administrateur revérifiée, `Origin` contrôlé, JSON exigé |
| API locale `:8090` | l'intérieur du conteneur | écoute sur 127.0.0.1 |
| Serveurs de travaux `:8080` | réseau `usine` | jeton propre à chaque serveur |
| Produits `:3000` | Caddy | réseau Docker propre à chaque produit |
| Slack | l'espace de travail | `ADMIN_USER_IDS` |

## Failles corrigées

### Graves

1. **Slack : tout l'espace de travail était administrateur par défaut.** Avec
   `ADMIN_USER_IDS` vide (la valeur de `.env.example`), n'importe quel membre pouvait valider
   un plan, mettre en production en accès public, supprimer un projet, créer des comptes et des
   clés d'API. Désormais une liste vide ne donne les droits à personne. `*` les donne à tous,
   mais seulement si on l'écrit exprès. Chaque fenêtre Slack revérifie l'administrateur à l'envoi
   (la création de compte ne le faisait pas). Voir `estAdminSlack` dans `config.mjs`.
2. **L'atelier pouvait commander le vérificateur.** Les deux serveurs partageaient
   `worker_token`, que tout agent de l'atelier peut lire. Un agent piégé (par un dépôt repris,
   une page lue pendant une recherche ou une dépendance) pouvait lancer des scripts chez son
   juge, et la clé du coffre de la console était dérivée de ce même jeton. Désormais chaque
   serveur a son jeton (`atelier_token`, `verificateur_token`), comparé en temps constant, et
   `worker_token` ne quitte plus l'orchestrateur.
3. **Les produits partageaient un réseau Docker.** Un produit pouvait appeler directement
   `usine-prod-autre-blue:3000`, sans passer par le portier, avec un faux en-tête
   `X-Usine-Utilisateur` (les briques font confiance à cet en-tête). Désormais chaque produit a son
   réseau (`usine-p-<slug>`, un /27 dans `10.231.0.0/16`, réglable avec `RESEAUX_PRODUITS`), où ne
   sont branchés que Caddy, le déployeur et, s'il capture ses emails, Mailpit. Les produits déjà en
   ligne y passent au démarrage du déployeur, sans coupure.
4. **Les sauvegardes passaient par l'image du produit, en root.** Le code d'un produit voyait
   ainsi le volume de sauvegardes de tous les produits. Désormais l'image du déployeur fait les
   sauvegardes (`IMAGE_OUTILS`), sans réseau.
5. **La porte de fusion pouvait être trompée.** La sortie du build, des tests et de l'application
   allait dans le journal où l'usine lit ses marqueurs. Un test qui affichait
   `@@ TESTS_PASSES 99` ou `@@ VULN_GRAVES 0` passait pour l'usine. Désormais ces sorties passent
   par `NEUTRALISER` (`profil.mjs`).

### Moyennes

6. **Un état souhaité pouvait prendre n'importe quelle adresse** (celle de la console ou du
   portail). Le déployeur n'accepte plus que `<slug>.apercu.<base>` ou `<slug>.<base>`, et
   refuse les noms réservés (`hotesValides`).
7. **Les produits tournaient avec tous les droits Docker par défaut.** Désormais : `NET_RAW`
   retiré (plus d'usurpation ARP sur le réseau), ainsi que `MKNOD`, `AUDIT_WRITE`, `SETFCAP` et
   `SYS_CHROOT`. S'y ajoutent `no-new-privileges` et 512 processus au plus (`DURCI`).
8. **Des secrets passaient sur la ligne de commande.** Le mot de passe SMTP et la clé de la
   passerelle IA étaient passés à `docker run -e` et donc visibles dans `ps`. Ils passent
   maintenant par un fichier privé, effacé aussitôt (`--env-file`).
9. **Portier :**
   - la durée de la réponse révélait quels emails avaient un compte ;
   - un cookie posé pour tout le domaine par une application pouvait masquer la vraie session ;
   - les jokers SQL (`%`, `_`) d'une adresse pouvaient désigner une autre application ;
   - le rôle et les applications d'un compte n'étaient pas validés ;
   - le compteur d'échecs pouvait grossir sans limite et remplir la mémoire ;
   - le formulaire d'invitation ne contrôlait pas son origine.
10. **Serveurs de travaux :** la taille d'une requête n'était pas limitée.

### Pour qui reprend le projet

11. **Plusieurs valeurs du serveur d'origine étaient écrites par défaut** : son IP
    (`45-93-21-17.sslip.io` dans `docker-compose.yml`, `.env.example` et le contrat), son compte
    GitHub (`Tgnima`) et son dépôt d'état (`Tgnima/usine-etat`). Une nouvelle installation
    pouvait donc viser l'infrastructure de quelqu'un d'autre. Ces valeurs sont retirées :
    `install.sh` déduit le domaine de l'IP publique du serveur, `DOMAINE_BASE` est obligatoire, et
    le dépôt d'état est à donner.

## Ce qui reste (choix d'architecture, à décider)

- **Le code d'un produit voit les identifiants des modèles.** Dans l'atelier et le vérificateur,
  le code en cours de construction ou de test tourne sous le même utilisateur que les agents. Il
  peut lire `/run/secrets` (jeton Claude, clé OpenAI) et `~/.codex` (le compte ChatGPT). Il peut
  aussi réécrire `verdict.txt` pendant que Codex juge. Le vrai remède : lancer le produit sous un
  autre utilisateur, sans accès à ces dossiers, et filtrer les sorties réseau.
- **Tous les produits reçoivent la clé `AI_GATEWAY_API_KEY`.** Il faut une clé dédiée, avec un
  plafond de dépense.
- **L'interface de Mailpit est ouverte** aux produits qui capturent leurs emails : un produit peut
  y lire les emails de démo des autres. Il faudrait protéger cette interface (`MP_UI_AUTH_FILE`).
- **Images en `latest`** (`caddy`, `mailpit`, `docker:cli`, Claude Code, Codex) : c'est un choix
  assumé, mais une image compromise en amont arrive à la reconstruction suivante. Il vaut mieux
  fixer les versions par empreinte (digest) en production.
- **Le socket Docker du déployeur donne root sur le serveur.** C'est inhérent : le déployeur
  n'ouvre aucun port et ne lance rien sans `valide()`. Le dépôt d'état reste la source de
  confiance : qui peut y écrire déploie.

## Appliquer sur un serveur existant

L'usine en place a besoin de deux nouveaux jetons (`atelier_token`, `verificateur_token`). Tant
qu'ils n'existent pas, `docker compose up` refuse de démarrer, et l'ancienne version continue de
tourner. Après la fusion :

```bash
git pull
sudo bash secrets.sh migrer      # génère et chiffre les nouveaux jetons
docker compose build && docker compose up -d
docker compose logs -f deployeur # « isolé sur le réseau usine-p-… » pour chaque produit
```

Vérifie aussi que `ADMIN_USER_IDS` contient bien tes identifiants Slack. Sinon, plus personne ne
peut décider depuis Slack (la console reste utilisable).

## Vérifications

- `cd orchestrateur && npm test` : 119 tests, dont `securite.test.mjs` (administrateurs Slack,
  marqueurs neutralisés, jeton propre à chaque serveur).
- `cd portier && npm test` : 13 tests, dont le cookie masqué, les rôles inventés et les jokers SQL.
- `cd deployeur && node --test test/` : 7 tests, dont les adresses imposées et les sous-réseaux.
- Pas encore éprouvé sur un vrai serveur : la bascule des produits vers leur réseau, et le
  démarrage avec les nouveaux jetons.
