
## Spécificités de la brique « API »

- **Pas d'interface** : ni `client/` ni Vite. Le produit est une API JSON sous `/api`. Ignore les règles sur les écrans et le kit de composants ; l'équivalent d'un écran est ici **la documentation**.
- **Chaque point d'accès est documenté** dans `docs/API.md` (servi tel quel sur `GET /api/docs`) : méthode, chemin, corps attendu, réponse, codes d'erreur, un exemple `curl`. Une route non documentée n'est pas terminée.
- **Accès** : l'usine protège l'API. Un programme s'authentifie avec une **clé d'API** créée par un administrateur dans Slack (`/usine acces`, « Créer une clé d'API ») et l'envoie dans `Authorization: Bearer <clé>`. Le serveur reçoit le nom de l'appelant dans l'en-tête `X-Usine-Utilisateur` (`cle:<nom>` pour une clé, l'email pour une personne). N'écris **jamais** de gestion de clés, de jetons ni de comptes toi-même.
- **Contrat stable** : réponses JSON cohérentes (`{ erreur }` en cas d'échec, codes HTTP justes : 400, 404, 409, 422), pagination (`?limite=&apres=`) sur les listes, dates en ISO 8601. On ne retire ni ne renomme un champ existant : on en ajoute.
- **Validation stricte** des entrées dans les actions, avec un message clair.
- Les tests appellent les actions directement, et les routes via `creerApp()` et `fetch` sur un port libre.
