---
titre: Comment donner à Claude l'accès à mon VPS ?
slug: comment-donner-a-claude-l-acces-a-mon-vps
ordre: 3
resume: Déposer la clé publique sur le VPS une seule fois avec le mot de passe, puis laisser Claude se connecter avec la clé uniquement.
meta_description: Donnez à Claude Code l'accès à votre VPS Wayhost : dépôt de la clé SSH, premier test, et les règles à suivre (mot de passe, connexions, pare-feu).
---
Claude se connecte au VPS **avec la clé SSH** créée à l'étape précédente. Le mot de passe du serveur ne sert qu'une fois, pour déposer cette clé, et c'est **vous** qui le tapez.

## 1. Trouver l'IP et l'utilisateur

Dans l'[espace client](https://panel.wayhost.cloud), ouvrez **Mes serveurs**, cliquez sur les **⋯** de votre VPS puis sur **Gérer**. La rubrique **Accès Root** donne la **commande SSH** (par exemple `ssh ubuntu@203.0.113.10`) : l'utilisateur est le mot avant le `@`, l'IP celui d'après.

[[capture:acces-root.png|La rubrique Accès Root d'un VPS dans l'espace client]]

## 2. Déposer la clé publique (vous, une seule fois)

Sous Windows, dans **PowerShell**, en remplaçant l'utilisateur et l'IP par les vôtres :

```
type $env:USERPROFILE\.ssh\wayhost_usine.pub | ssh ubuntu@203.0.113.10 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Répondez `yes` à la première question, puis tapez le mot de passe du VPS (rien ne s'affiche pendant la saisie, c'est normal).

## 3. Laisser Claude tester

Demandez à Claude de se connecter avec la clé et de décrire le serveur. Il lance une commande de ce type :

```
ssh -i ~/.ssh/wayhost_usine ubuntu@203.0.113.10 "lsb_release -ds; nproc; free -h; df -h /; sudo -n true && echo SUDO_OK"
```

Vous voyez le système, le nombre de processeurs, la mémoire, le disque, et `SUDO_OK` si l'utilisateur a les droits d'administration.

## Les règles apprises en route

- **Ne tapez jamais le mot de passe du serveur dans la conversation.** Claude n'en a pas besoin. S'il y a été écrit, changez-le.
- **Le serveur coupe les connexions SSH trop rapprochées** (« Connection reset », « Connection timed out »). Il ne s'agit pas d'une panne : demandez à Claude de regrouper ses commandes et de réessayer après une pause.
- **Pas de pare-feu ni de réglage SSH sans votre accord** : une erreur vous coupe l'accès, à vous comme à Claude.
- **Les secrets ne passent jamais par la conversation** : vous les collez vous-même dans un fichier sur le serveur (voir *Comment ranger les secrets de mon usine ?*).
