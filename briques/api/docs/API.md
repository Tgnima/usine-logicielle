# API de {{NOM}}

{{RESUME}}

## Authentification

Chaque requête porte une clé d'API, créée par un administrateur de l'usine (dans Slack : `/usine acces`, puis « Créer une clé d'API ») :

```
Authorization: Bearer usk_…
```

Sans clé valide, la réponse est `401 { "erreur": "…" }`.

## Conventions

- Corps et réponses en JSON (`Content-Type: application/json`).
- Une erreur renvoie `{ "erreur": "message lisible" }` avec un code HTTP adapté.
- Dates au format ISO 8601.

## Points d'accès

### `GET /api/health`

L'état du service (sans clé). Réponse : `200 { "ok": true }`.

```bash
curl https://<adresse>/api/health
```

### `GET /api/moi`

Qui appelle (le nom de la clé d'API, ou l'email d'une personne connectée).

```bash
curl -H "Authorization: Bearer $CLE" https://<adresse>/api/moi
```

Réponse : `200 { "appelant": "cle:intégration CRM" }`.
