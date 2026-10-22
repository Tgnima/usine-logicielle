---
titre: Comment créer un token GitHub pour mon agent ?
slug: comment-creer-un-token-github-pour-mon-agent
ordre: 5
resume: Un token « fine-grained » limité à vos dépôts, avec les seuls droits dont l'agent a besoin.
meta_description: Créez un token GitHub fine-grained pour l'agent de votre usine logicielle : dépôts choisis, droits minimum, expiration, et où le ranger.
---
Le token permet à l'agent de **cloner vos dépôts, pousser ses branches et ouvrir des pull requests**. Donnez-lui le moins de droits possible.

## 1. Ouvrir la page des tokens

Sur GitHub, cliquez sur votre photo, puis **Settings** › **Developer settings** › **Personal access tokens** › **Fine-grained tokens**, et enfin **Generate new token**.

[[capture:github-nouveau-token.png|La page de création d'un token fine-grained sur GitHub]]

## 2. Le régler

- **Token name** : un nom clair, par exemple `usine-vps-groupe-3` ;
- **Description** : à quoi il sert (facultatif, mais utile quand on en a plusieurs) ;
- **Expiration** : la durée de votre projet (30 jours par défaut, 90 au plus pour un module), jamais « No expiration » ;
- **Repository access** : **Only select repositories**, puis **Select repositories** pour choisir les dépôts de l'usine ;
- **Permissions** : cliquez sur **Add permissions**, cochez **Contents**, **Pull requests** et **Issues**, puis passez chacun sur **Access : Read and write** :
  - **Contents** : lire et pousser le code ;
  - **Pull requests** : ouvrir et commenter les PR ;
  - **Issues** : si votre usine suit son travail dans des issues ;
  - **Metadata** reste en *Read-only* : il est ajouté d'office.

[[capture:github-droits-token.png|Les droits du token : Contents, Pull requests et Issues en lecture et écriture]]

Cliquez sur **Generate token**.

## 3. Le ranger tout de suite

GitHub n'affiche le token **qu'une seule fois**. Copiez-le et collez-le directement dans le fichier `.env` du serveur : voir *Comment ranger mes secrets dans un fichier .env ?*

> Ne collez jamais le token dans une conversation avec Claude, dans un dépôt ou dans un message. S'il a fuité, supprimez-le sur la même page et créez-en un autre.
