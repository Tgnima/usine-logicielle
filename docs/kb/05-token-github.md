---
titre: Comment créer le token GitHub de mon usine ?
slug: comment-creer-un-token-github-pour-mon-agent
ordre: 5
resume: Un token fine-grained sur tous vos dépôts, avec les droits qui permettent à l'usine de créer des dépôts, pousser et ouvrir des pull requests.
meta_description: Créez le token GitHub fine-grained de votre usine logicielle : tous les dépôts, Administration, Contents, Issues et Pull requests, et son expiration.
---
Avec ce token, l'usine **crée les dépôts** de vos applications, y pousse le code, ouvre les pull requests et les issues. Les agents qui codent ne le voient jamais : il ne sert qu'aux étapes de clone et de push, hors de l'agent.

## 1. Ouvrir la page de création

Connecté au compte GitHub qui recevra les applications, ouvrez [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new).

## 2. Le régler

[[capture:github-nouveau-token.png|Le haut du formulaire : nom, description, propriétaire, expiration et accès à tous les dépôts]]

- **Token name** : un nom clair, par exemple `usine-logicielle` ;
- **Resource owner** : le compte (ou l'organisation) qui recevra les dépôts ;
- **Expiration** : notez la date, l'usine s'arrêtera de pousser ce jour-là ;
- **Repository access** : **All repositories**. L'usine crée de nouveaux dépôts : un token limité à des dépôts choisis ne les verrait pas ;
- **Permissions** : cliquez sur **Add permissions**, ajoutez-les, puis réglez l'accès :
  - **Administration** : *Read and write*, pour créer les dépôts ;
  - **Contents** : *Read and write*, pour pousser le code ;
  - **Issues** : *Read and write*, pour les issues d'escalade ;
  - **Pull requests** : *Read and write*, pour une pull request par tâche ;
  - **Metadata** : *Read-only*, ajouté d'office.

[[capture:github-droits-token.png|Les cinq permissions : Administration, Contents, Issues et Pull requests en lecture et écriture, Metadata en lecture]]

Cliquez sur **Generate token**.

## 3. Le ranger tout de suite

GitHub n'affiche le token **qu'une seule fois**. Collez-le vous-même dans le `.env` du serveur, sur la ligne `GITHUB_TOKEN=`, puis relancez `bash install.sh` : voir *Comment ranger les secrets de mon usine ?*

> Reprendre le dépôt d'un autre compte en mode direct ? Le compte de l'usine doit y être invité en écriture. Sinon, l'usine travaille sur une copie.

> Le token expire : renouvelez-le avant la date, recollez-le dans `.env`, puis lancez `bash secrets.sh migrer`.
