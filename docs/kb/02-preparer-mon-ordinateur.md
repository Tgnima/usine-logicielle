---
titre: Comment préparer mon ordinateur pour l'usine logicielle ?
slug: comment-preparer-mon-ordinateur-pour-l-usine-logicielle
ordre: 2
resume: Ouvrir un terminal, installer Claude Code et créer votre clé SSH.
meta_description: Avant de monter une usine logicielle sur un VPS Wayhost : ouvrir un terminal, installer Claude Code sur votre ordinateur et générer votre clé SSH.
---
## 1. Ouvrir un terminal

- **Windows** : ouvrez **Terminal** (ou **PowerShell**) depuis le menu Démarrer.
- **macOS** : ouvrez **Terminal** depuis Applications › Utilitaires.
- **Linux** : ouvrez le terminal de votre distribution.

Toutes les commandes de ce guide se tapent dans ce terminal.

## 2. Installer Claude Code

Sur macOS ou Linux :

```
curl -fsSL https://claude.ai/install.sh | bash
```

Sur Windows, dans PowerShell :

```
irm https://claude.ai/install.ps1 | iex
```

Lancez-le une première fois et connectez-vous à votre compte Claude :

```
claude
```

Un lien s'affiche : ouvrez-le dans votre navigateur, connectez-vous, puis revenez au terminal.

## 3. Créer votre clé SSH

La clé SSH vous connecte au VPS sans mot de passe, et c'est elle que Claude utilisera.

```
ssh-keygen -t ed25519 -C "votre@email.com"
```

Validez les questions (l'emplacement par défaut convient). Deux fichiers sont créés dans le dossier `.ssh` de votre compte :

- `id_ed25519` : la **clé privée**, à ne **jamais partager**, ni avec une personne ni dans une conversation avec une IA ;
- `id_ed25519.pub` : la **clé publique**, celle à déposer sur votre VPS.

Pour l'ajouter à votre serveur, suivez *Comment ajouter une clé SSH à mon VPS ?*

> Vous avez déjà une clé (`id_rsa.pub`, par exemple) ? Vous pouvez la réutiliser.
