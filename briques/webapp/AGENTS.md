# {{NOM}}

{{RESUME}}

Ce produit est fabriqué par l'usine logicielle, tâche par tâche. Le plan validé
est dans `docs/PLAN.md`. Ce fichier donne les conventions : suis-les.

## Stack

- Node 24, ES modules, **Express 5** pour l'API, **SQLite** via `node:sqlite` (aucune dépendance).
- **React 19 + Vite + Tailwind CSS 4** pour l'interface, dans `client/`.
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
test/                  les tests
```

## Règles

1. **Chaque fonctionnalité = une action** dans `server/actions/` + une route dans `server/routes/` + ses tests + son écran. La logique ne vit jamais dans une route ni dans un composant.
2. **Tests d'abord** : écris les tests des critères d'acceptation testables sans navigateur, puis le code. Ne supprime ni n'affaiblis jamais un test existant.
3. **Migrations additives seulement** : ajoute une entrée à `MIGRATIONS` dans `server/db.js` (`CREATE TABLE`, `ALTER TABLE … ADD COLUMN`). Ne modifie ni ne supprime une migration existante.
4. **Erreurs explicites** : une action lève une erreur avec un `status` ; jamais de valeur par défaut qui masquerait une panne.
5. **Aucun secret dans le code.** Les clés arrivent par variables d'environnement.
6. **Les tests ne touchent jamais le réseau** : sous `node --test`, `generer()` renvoie le texte de secours et `envoyer()` n'envoie rien. **Ils ne dépendent pas non plus de l'environnement** (`DEMO`, `DATA_DIR`, `PORT`…) : ils utilisent `dbDeTest()` et doivent passer à l'identique avec ou sans `DEMO=1`.
7. **Interface soignée** : Tailwind, mise en page claire et aérée, responsive, textes en français. C'est une démo : elle doit être belle.
8. **Mode démo** (`DEMO=1`) : si la base est vide au démarrage, remplis-la avec des données fictives mais réalistes (aucune vraie personne). Utilise `maintenant()` pour tout ce qui dépend du temps.
9. **Le démarrage se branche dans `server/demarrage.js`** (`auDemarrage()`) : le remplissage démo et les tâches de fond (minuteurs) y sont appelés. Jamais dans `server/index.js`, qui est protégé.

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
