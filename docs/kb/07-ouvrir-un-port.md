---
titre: Comment ouvrir un port sans perdre l'accès à mon VPS ?
slug: comment-ouvrir-un-port-sans-perdre-l-acces-a-mon-vps
ordre: 7
resume: Le piège du pare-feu, la bonne méthode pour ouvrir un port, et comment reprendre la main si l'accès est coupé.
meta_description: Ouvrir un port sur votre VPS Wayhost sans perdre l'accès : garder le port 22, l'ordre des commandes ufw, la règle à donner à Claude, la console web.
---
Pour montrer une application, il faut ouvrir un **port** : une porte d'entrée vers le serveur (80 et 443 pour un site web, par exemple). C'est aussi l'étape où l'on se coupe le plus souvent l'accès : un pare-feu activé sans autoriser le port **22** bloque SSH, et donc vous comme Claude.

## Le pare-feu de l'espace client

Par défaut, **Wayhost bloque tout le trafic entrant** de votre VPS : seuls les ports autorisés par une règle passent. Dans l'[espace client](https://panel.wayhost.cloud), ouvrez **Mes serveurs**, **Gérer** votre VPS, puis l'onglet **Pare-feu** : chaque groupe liste ses règles (direction, protocole, port, plage d'adresses). Ajoutez une règle **Entrant** pour le port voulu, en gardant le port **22** ouvert. Voir *Comment configurer le pare-feu de mon VPS ?*

[[capture:pare-feu-regles.png|Les règles d'un groupe de sécurité dans l'onglet Pare-feu]]

## Le pare-feu du serveur (ufw)

Si vous utilisez aussi `ufw` sur le serveur, **autorisez toujours SSH avant d'activer le pare-feu** :

```
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Dans cet ordre. Si vous activez `ufw` avant la première ligne, la connexion en cours est coupée.

## La règle à donner à Claude

```
Ne lance aucune commande de pare-feu (ufw, iptables, nftables) ni de configuration SSH sans me la montrer et attendre mon accord. Vérifie toujours que le port 22 reste ouvert.
```

## Vous n'avez plus accès au serveur ?

1. Dans l'espace client, ouvrez votre VPS et lancez la **console web** : elle ne passe pas par SSH. Voir *Comment utiliser la console web de mon VPS ?*
2. Connectez-vous avec le mot de passe root (il se change dans la rubrique **Sécurité** de la vue d'ensemble).
3. Rétablissez SSH :

```
ufw allow OpenSSH
```

Ou, si besoin, désactivez le pare-feu le temps de corriger : `ufw disable`.

Le port 22 est fermé dans le pare-feu de l'espace client ? Rouvrez-le depuis l'onglet **Pare-feu** : aucune console n'est nécessaire.
