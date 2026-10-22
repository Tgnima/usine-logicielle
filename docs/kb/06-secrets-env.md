---
titre: Comment ranger les secrets de mon usine ?
slug: comment-ranger-mes-secrets-dans-un-fichier-env
ordre: 6
resume: Vous collez les secrets dans .env ; install.sh les chiffre, les retire du fichier, et chaque conteneur ne reçoit que les siens.
meta_description: Les secrets de l'usine logicielle sur votre VPS Wayhost : collés dans .env, chiffrés avec SOPS et age, vérifiés sans être affichés, la clé à sauvegarder.
---
Les secrets (token GitHub, jeton Claude, jetons Slack) passent par le fichier `.env` du serveur, que vous remplissez **vous-même**. Ils n'y restent pas : `install.sh` les **chiffre**, puis les efface du fichier.

## 1. Les coller dans .env

Sur le VPS, dans le dossier de l'usine :

```
nano .env
```

Collez chaque valeur juste après le `=` de sa ligne, sans espace ni guillemets :

```
GITHUB_TOKEN=
CLAUDE_CODE_OAUTH_TOKEN=
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
```

Enregistrez avec **Ctrl + O**, **Entrée**, puis quittez avec **Ctrl + X**. Chaque ligne est expliquée dans le fichier (créé depuis `.env.example`).

## 2. Les chiffrer

```
bash install.sh
```

Le script installe **SOPS** et **age**, crée une clé de chiffrement (`/etc/usine/age.key`), chiffre les secrets dans `secrets.sops.env`, puis les retire de `.env`. Au démarrage du serveur, ils sont déchiffrés **en mémoire** (`/run/usine-secrets`) et chaque conteneur ne reçoit que les siens. `.env` ne garde que des réglages.

## 3. Vérifier sans afficher les valeurs

```
bash secrets.sh verifier
```

Chaque secret est marqué **rempli** ou **vide**, sans jamais être affiché. Demandez à Claude de faire cette vérification : il n'a pas besoin de lire les valeurs.

> Sur le VPS de démonstration, les deux jetons Slack avaient été collés l'un à la place de l'autre, et le jeton Claude commençait par un espace. Claude l'a vu grâce aux préfixes (`xoxb-` pour le bot, `xapp-` pour l'application, `sk-ant-oat01-` pour Claude), sans afficher les valeurs.

## 4. Sauvegarder la clé

Sans `/etc/usine/age.key`, les secrets chiffrés sont perdus. Affichez-la **vous-même** et rangez-la dans votre gestionnaire de mots de passe, hors du serveur :

```
sudo cat /etc/usine/age.key
```

## Changer un secret

Recollez-le dans `.env`, puis `bash secrets.sh migrer` ; ou modifiez-le directement avec `bash secrets.sh editer`.

> Claude vous demande un secret dans la conversation ? Refusez et collez-le dans `.env`. Un secret écrit dans une conversation doit être considéré comme exposé : changez-le.
