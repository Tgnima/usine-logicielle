---
titre: Comment donner à Claude l'accès à mon VPS ?
slug: comment-donner-a-claude-l-acces-a-mon-vps
ordre: 3
resume: Un raccourci SSH, un premier test, et les règles à fixer avant de laisser Claude travailler sur le serveur.
meta_description: Donnez à Claude Code l'accès à votre VPS Wayhost par une clé SSH : raccourci ~/.ssh/config, premier test et règles de sécurité à lui donner.
---
Claude Code se connecte à votre VPS **avec votre clé SSH**, depuis votre ordinateur. Il n'a jamais besoin d'un mot de passe.

## 1. Créer un raccourci SSH

Dans l'[espace client](https://panel.wayhost.cloud), ouvrez **Mes serveurs**, cliquez sur les **⋯** de votre VPS puis sur **Gérer**. La rubrique **Accès Root** donne la **commande SSH** et l'**IP du serveur**.

[[capture:acces-root.png|La rubrique Accès Root d'un VPS dans l'espace client]]

Ouvrez (ou créez) le fichier `config` du dossier `.ssh` de votre compte, et ajoutez :

```
Host usine
    HostName 203.0.113.10
    User ubuntu
    IdentityFile ~/.ssh/id_ed25519
```

Remplacez `203.0.113.10` par l'IP de votre VPS, et `ubuntu` par l'utilisateur de la commande SSH (le mot avant le `@`).

## 2. Tester la connexion

```
ssh usine
```

Vous devez arriver sur le serveur **sans saisir de mot de passe**. Tapez `exit` pour revenir.

## 3. Laisser Claude travailler

Lancez `claude` sur votre ordinateur, puis demandez-lui par exemple :

```
Connecte-toi au serveur avec « ssh usine » et dis-moi quel système, combien de mémoire et quel espace disque il a.
```

Claude lance lui-même les commandes `ssh usine …` et vous montre ce qu'il fait. Lisez ses commandes avant de les accepter : c'est le meilleur moyen d'apprendre.

## Les règles à donner à Claude dès le début

Collez-les au début de chaque session (ou dans un fichier `CLAUDE.md` à la racine de votre projet) :

```
- Ne modifie jamais le pare-feu ni la configuration SSH du serveur sans me demander.
- Ne me demande jamais un mot de passe, une clé privée ou un token dans la conversation : je les range moi-même dans un fichier .env.
- Avant une commande qui supprime ou écrase des données, explique-la et attends mon accord.
```

> Claude vous a coupé l'accès au serveur ? Reprenez la main avec la **console web** de l'espace client : voir *Comment utiliser la console web de mon VPS ?*
