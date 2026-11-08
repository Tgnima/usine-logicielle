# {{NOM}}

{{RESUME}}

Ce produit est fabriqué par l'usine logicielle, tâche par tâche. Le plan validé
est dans `docs/PLAN.md`. Ce fichier donne les conventions : suis-les.

## Stack

- Node 24, ES modules, **Express 5** pour l'API, **SQLite** via `node:sqlite` (aucune dépendance).
- **React 19 + Vite + Tailwind CSS 4** pour l'interface, dans `client/`, avec les composants **shadcn/ui** (Radix) de `client/src/ui` et les icônes **Lucide** (`lucide-react`).
- Tests : `node:test` et `node:assert/strict`, dans `test/` (`*.test.js`).

## Commandes

| Commande | Rôle |
| --- | --- |
| `npm run verify` | Build + tests : **doit passer avant de terminer une tâche** |
| `npm test` | Les tests seuls |
| `npm start` | Le serveur (port `PORT`, 3000 par défaut) |

## Structure

```
server/index.js        l'app Express (creerApp), /api/health, sert dist/
server/db.js           SQLite + migrations additives (tableau MIGRATIONS)
server/routes/         une route par fonctionnalité, branchée dans routes/index.js
server/actions/        la logique métier, sans Express, testée dans test/
server/horloge.js      maintenant() : l'heure du produit (accélérée en démo)
server/llm.js          generer() : appeler un modèle (secours sans clé)
server/email.js        envoyer() : un email (vers Mailpit en démo)
client/src/            l'interface React
client/src/ui/         le kit : composants de base (index.jsx) et shadcn/ui (shadcn/)
client/src/Kit.jsx     la page /kit : tous les composants aux couleurs du produit
client/src/styles.css  les jetons du brief (les seules couleurs du produit)
test/                  les tests
```

## Règles

1. **Chaque fonctionnalité = une action** dans `server/actions/` + une route dans `server/routes/` + ses tests + son écran. La logique ne vit jamais dans une route ni dans un composant.
2. **Tests d'abord** : écris les tests des critères d'acceptation testables sans navigateur, puis le code. Ne supprime ni n'affaiblis jamais un test existant.
3. **Migrations additives seulement** : ajoute une entrée à `MIGRATIONS` dans `server/db.js` (`CREATE TABLE`, `ALTER TABLE … ADD COLUMN`). Ne modifie ni ne supprime une migration existante.
4. **Erreurs explicites** : une action lève une erreur avec un `status` ; jamais de valeur par défaut qui masquerait une panne.
5. **Aucun secret dans le code.** Les clés arrivent par variables d'environnement. **Le code est en lecture seule une fois en ligne** : le serveur n'écrit jamais dans le dossier du projet (ni `dist/`, ni `server/`) ; il n'écrit que dans `DATA_DIR`. Un fichier qui dépend de l'adresse (`robots.txt`, `sitemap.xml`…) est servi par une route.
6. **Les tests ne touchent jamais le réseau** : sous `node --test`, `generer()` renvoie le texte de secours et `envoyer()` n'envoie rien. **Ils ne dépendent pas non plus de l'environnement** (`DEMO`, `DATA_DIR`, `PORT`…) : ils utilisent `dbDeTest()` et doivent passer à l'identique avec ou sans `DEMO=1`.
7. **Interface soignée, sans air « généré »** : lis `docs/DESIGN.md` (le brief : palette, arrondi, typographie, ton, parcours clé, à éviter) et suis sa grille. Avant tout écran :
   - **Pars du kit.** Les composants de `client/src/ui/index.jsx` (`Coque`, `Page`, `Carte`, `Bouton`, `Champ`, `Tableau`, `Statistique`, `Badge`, `EtatVide`, `Chargement`, `Erreur`, `toast`) et ceux de shadcn/ui, chacun dans son fichier de `client/src/ui/shadcn/` (`Dialog`, `Sheet`, `DropdownMenu`, `Select`, `Tabs`, `Tooltip`, `Popover`, `Skeleton`, `Checkbox`, `Switch`, `Table`…), importés depuis leur fichier. N'en réinvente pas un qui existe. Un composant shadcn manquant s'ajoute avec `npx shadcn@latest add <nom>` (il prend les jetons du produit ; si la commande ajoute des variables de couleur dans `client/src/styles.css`, retire-les : les jetons du brief restent les seuls), un composant métier réutilisable se crée dans `client/src/ui/`, et la page `/kit` le montre.
   - **Uniquement les jetons du brief** : `bg-primaire`, `text-doux`, `bg-succes/10`… ou leurs noms shadcn (`bg-primary`, `text-muted-foreground`, `border-border`, `bg-muted`). Attention : `accent` est la couleur d'accent du brief ; un survol discret passe par `bg-muted`.
   - **Interdit, et refusé par le contrôle de l'usine** : une couleur écrite en dur (`#…`, `rgb(…)`), une couleur de la palette Tailwind (`text-gray-500`, `bg-blue-600`), une valeur arbitraire d'espacement ou de texte (`p-[13px]`, `text-[15px]`), des icônes d'une autre famille que Lucide.
   - **Hiérarchie** : une action principale par écran (`Bouton`), les autres en `secondaire`, `discret` ou dans un `DropdownMenu`. Pas de carte dans une carte, pas de badge sur chaque information, pas de dégradés ni d'ombres lourdes.
   - **États** : chaque écran a son état vide (`EtatVide`), de chargement (`Chargement`, des squelettes de préférence), d'erreur (`Erreur`), et chaque action confirme son résultat (`toast.success(…)`).
   - **Responsive et accessible** : rien ne déborde à 390 px ; chaque bouton icône a un `aria-label` ; tout se fait au clavier.

   Les formats français viennent de `client/src/ui/format.js`. Chaque écran est vérifié sur captures d'écran (ordinateur et mobile) par un relecteur design.
8. **Mode démo** (`DEMO=1`) : si la base est vide au démarrage, remplis-la avec des données fictives mais réalistes (aucune vraie personne). Utilise `maintenant()` pour tout ce qui dépend du temps.
9. **Le démarrage se branche dans `server/demarrage.js`** (`auDemarrage()`) : le remplissage démo et les tâches de fond (minuteurs) y sont appelés. Jamais dans `server/index.js`, qui est protégé.
10. **Jamais d'authentification dans le produit.** L'usine protège déjà toute l'application par sa page de connexion (le portier) : ne code ni mot de passe, ni comptes, ni session, ni « mode public ».
11. **Les pages ouvertes SANS connexion** (lien dans un email envoyé à un prospect, formulaire public, pixel de suivi) : place-les sous `/public/…` ou `/api/public/…`, ou déclare leur chemin précis dans `usine.json` (`"chemins_publics": ["/api/t/*", "/merci"]`). Un chemin trop large (`/`, `/api/*`) est refusé par l'usine. Ces pages n'exposent jamais les données d'autres personnes : elles s'appuient sur un jeton aléatoire non devinable.

## Variables d'environnement

| Variable | Rôle |
| --- | --- |
| `PORT`, `DATA_DIR` | Port du serveur, dossier de la base |
| `DEMO`, `DEMO_VITESSE_HORLOGE` | Mode démo, vitesse de l'horloge (1440 = un jour par minute) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_SECURE`, `EMAIL_EXPEDITEUR` | Envoi d'emails (Mailpit en démo), toujours par `envoyer()` |
| `EMAIL_DESTINATAIRES_AUTORISES` | Liste des destinataires permis (contacts de test) ; `envoyer()` bloque les autres |
| `AI_GATEWAY_API_KEY`, `LLM_MODELE` | Modèles via Vercel AI Gateway |
| `PUBLIC_URL` | L'adresse publique du produit |

## Fichiers protégés

Ne les modifie pas : l'usine les restaure et refuse la tâche. `Dockerfile`, `test/sante.test.js`, `test/securite.test.js`, `server/securite.js` (en-têtes, limitation, erreurs), `server/index.js` (seul l'ajout de routes passe par `server/routes/index.js`), `server/email.js` (tout email passe par `envoyer()`, jamais par un autre transport), `.usine/**`, `docs/PLAN.md`.
