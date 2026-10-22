---
titre: Comment ranger mes secrets dans un fichier .env ?
slug: comment-ranger-mes-secrets-dans-un-fichier-env
ordre: 6
resume: Créer le fichier .env sur le VPS, le protéger, et laisser Claude vérifier qu'il est rempli sans jamais lire les valeurs.
meta_description: Rangez les tokens et clés de votre usine dans un fichier .env sur votre VPS Wayhost : création, droits 600, .gitignore et vérification sans affichage.
---
Les secrets (token GitHub, clé API, jeton Claude) se rangent **dans un fichier `.env` sur le serveur**, que vous remplissez **vous-même**. Claude s'en sert sans jamais les afficher.

## 1. Créer le fichier

Sur le VPS (`ssh usine`), dans le dossier de votre usine :

```
nano .env
```

Écrivez une ligne par secret :

```
GITHUB_TOKEN=collez-le-token-ici
ANTHROPIC_API_KEY=
CLAUDE_CODE_OAUTH_TOKEN=
```

Enregistrez avec **Ctrl + O**, puis **Entrée**, et quittez avec **Ctrl + X**.

## 2. Le protéger

```
chmod 600 .env
echo ".env" >> .gitignore
```

- `chmod 600` : seul votre compte peut lire le fichier ;
- `.gitignore` : le fichier ne partira jamais sur GitHub.

## 3. Vérifier sans afficher les valeurs

Demandez à Claude de vérifier, sans lire les secrets :

```
Vérifie quelles variables de .env sont remplies, sans jamais afficher leurs valeurs.
```

Ou vérifiez vous-même :

```
grep -c "=." .env
```

Le chiffre affiché est le nombre de lignes remplies.

> Claude vous demande un secret dans la conversation ? Répondez-lui de le lire dans `.env`. Un secret écrit dans une conversation doit être considéré comme exposé : changez-le.
