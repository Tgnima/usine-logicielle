---
titre: Comment préparer mon ordinateur pour l'usine logicielle ?
slug: comment-preparer-mon-ordinateur-pour-l-usine-logicielle
ordre: 2
resume: Claude Code sur votre ordinateur pour piloter le serveur, et une clé SSH dédiée au VPS de l'usine.
meta_description: Avant d'installer une usine logicielle sur un VPS Wayhost : Claude Code sur votre ordinateur et une clé SSH dédiée, sans phrase de passe.
---
L'usine tourne sur le VPS, mais vous l'installez et l'entretenez **depuis votre ordinateur**, avec Claude Code. Rien d'autre n'est à installer en local.

## 1. Claude Code

L'usine de démonstration a été montée depuis l'**application Claude** pour ordinateur, onglet **Code** : téléchargez-la sur [claude.ai/download](https://claude.ai/download) et connectez-vous à votre compte. Claude Code en ligne de commande convient aussi.

Claude lance lui-même les commandes sur le serveur et vous les montre avant de les exécuter.

## 2. Une clé SSH dédiée au VPS

Demandez à Claude de créer la clé, ou lancez la commande vous-même dans un terminal :

```
ssh-keygen -t ed25519 -N "" -C "usine-demo" -f ~/.ssh/wayhost_usine
```

- `-f ~/.ssh/wayhost_usine` : une clé **réservée à ce serveur**, séparée de vos autres clés ;
- `-N ""` : sans phrase de passe, pour que Claude puisse s'en servir sans vous la demander à chaque connexion. En échange, la clé privée ne doit **jamais** quitter votre ordinateur.

Deux fichiers sont créés dans le dossier `.ssh` de votre compte (`C:\Users\<vous>\.ssh` sous Windows) :

- `wayhost_usine` : la **clé privée**, à ne partager avec personne, ni dans une conversation avec une IA ;
- `wayhost_usine.pub` : la **clé publique**, celle que vous allez déposer sur le VPS (article suivant).
