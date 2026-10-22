---
titre: Comment ouvrir les ports 80 et 443 de mon usine ?
slug: comment-ouvrir-un-port-sans-perdre-l-acces-a-mon-vps
ordre: 7
resume: Le pare-feu Wayhost bloque tout le trafic entrant ; on y ouvre 80 et 443 pour Caddy, en gardant le port 22.
meta_description: Rendre les applications de l'usine accessibles : règles Entrant 80 et 443 dans le pare-feu Wayhost, port 22 conservé, test HTTP puis HTTPS.
---
Les aperçus et les applications de l'usine sont servis par **Caddy**, le seul conteneur qui ouvre des ports : **80** (HTTP) et **443** (HTTPS). Tant que ces ports sont fermés, les adresses de l'usine ne répondent pas.

## 1. Le pare-feu de l'espace client

Par défaut, **Wayhost bloque tout le trafic entrant** de votre VPS : seuls les ports autorisés par une règle passent. Dans l'[espace client](https://panel.wayhost.cloud), ouvrez **Mes serveurs**, **Gérer** votre VPS, puis l'onglet **Pare-feu**. Ajoutez une règle **Entrant** pour le port **80**, une autre pour le port **443**, et **gardez la règle du port 22** : c'est par lui que vous et Claude passez en SSH.

[[capture:pare-feu-regles.png|Les règles d'un groupe de sécurité dans l'onglet Pare-feu : 22, 443 et 80]]

Sur le VPS de démonstration, c'est le seul pare-feu utilisé : `ufw` n'est pas activé sur le serveur (`sudo ufw status` affiche `inactive`).

## 2. Tester

Depuis votre ordinateur, avec l'adresse d'un aperçu de l'usine :

```
curl -s -o /dev/null -w "%{http_code}\n" http://mon-app.apercu.203-0-113-10.sslip.io/api/health
```

`308` : le port 80 est ouvert et Caddy redirige vers HTTPS. `000` : le port est encore fermé.

Les adresses utilisent **sslip.io**, qui renvoie vers l'IP du serveur : aucun DNS à configurer. Caddy obtient le certificat HTTPS tout seul quand l'aperçu est mis en ligne. Si le navigateur affiche une erreur SSL juste après, le certificat n'est pas encore arrivé : rechargez la page une minute plus tard.

## La règle à donner à Claude

```
Ne modifie ni le pare-feu ni la configuration SSH sans me montrer la commande et attendre mon accord. Le port 22 reste toujours ouvert.
```
