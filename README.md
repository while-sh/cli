# while-sh

while-sh montre à votre équipe le serveur de dev de votre poste, sans mise en ligne. Il le sert à une adresse de while, `<projet>-dev-<nom>.while.cloud`. Qui entre dans l'appli du projet en production entre à cette adresse.

Sur while, votre IA met vos applis en ligne, lit leurs journaux et revient en arrière : https://while.sh. Il faut un compte while et un projet que vous pouvez mettre en ligne (permission `project.deploy`).

## Lancer

Sans installation, avec Node 22 au moins :

```sh
npx while-sh dev --project boutique                 # le serveur de dev tourne déjà, sur le port 5173, 3000, 4321 ou 8080
npx while-sh dev --project boutique -- npm run dev  # while-sh lance le serveur de dev
```

while-sh écrit l'adresse sur stdout. `--port` indique le port de votre serveur de dev, `--name` choisit le nom dans l'adresse.

## La première connexion

La première fois, while-sh donne une page de while et un code de connexion. Ouvrez la page et vérifiez qu'elle montre le même code. Le poste reçoit alors un accès au seul mode dev de l'organisation choisie.

## Une fois installé, il se lance par wh

```sh
npm install -g while-sh

wh dev --project boutique
wh dev status        # dans un autre terminal : les adresses servies depuis ce poste
wh dev stop [nom]    # arrête toutes ces adresses, ou celle de ce nom
wh login             # connecte ce poste
wh logout            # oublie la connexion de ce poste
```

## Les remarques

À cette adresse, les pages ont un widget de remarques : un collègue y pointe ce qui ne va pas. Sa remarque arrive sur votre poste en quelques secondes, sur stderr et dans `.while/remarques/`, où votre IA la lit.

## Une base, un cache ou une appli interne sur un port local

```sh
wh dev database [nom] --env <env>   # une base PostgreSQL, sous votre rôle SQL et vos droits
wh dev cache <nom> --env <env>      # un cache Valkey
wh dev service [nom] --env <env>    # une appli interne de l'environnement, sous votre identité
```

Ici, `nom` est celui de la base, du cache ou de l'appli. Il est obligatoire pour un cache.

## La doc

Les options, et le lien de partage pour quelqu'un qui n'a pas de compte while : https://while.sh/docs
