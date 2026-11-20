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

Ctrl-C, `wh dev stop` ou l'arrêt du processus de while-sh arrêtent aussi la commande donnée après `--`. Tout ce qu'elle a lancé s'arrête avec elle, y compris le `next dev` que lance `npm run dev`.

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

Avec `wh dev database`, la base se lit et s'écrit selon vos droits. En production, elle est en lecture seule pour tout le monde.

Hors production, dans une préversion ou un environnement de dev, avec toute la base (lecture, écriture et structure), vous agissez comme l'appli. Ses migrations passent par `wh dev database`, et les tables créées appartiennent à l'appli, qui les lit. C'est vérifié avec `prisma migrate deploy`.

`prisma migrate dev` crée lui-même une base fantôme, ce qui n'est pas permis sur while. Donnez-lui une base locale avec `shadowDatabaseUrl` dans `schema.prisma`, ou appliquez les migrations avec `prisma migrate deploy`.

Avec une partie de la base seulement, une table que vous créez appartient à votre rôle SQL, et l'appli ne la lit pas. Une base créée avant cette version de while garde ce fonctionnement, même si vous avez toute la base.

## Le dossier de la connexion

while-sh garde la connexion du poste dans `~/.config/while`, ou dans `$XDG_CONFIG_HOME/while` si cette variable est définie. Ce dossier contient les jetons du poste, dans un fichier lisible par vous seul, et l'état des adresses servies, que lisent `wh dev status` et `wh dev stop`.

La variable `WHILE_CONFIG_DIR` choisit un autre dossier : chacun le sien sur un poste partagé, ou une connexion par projet.

```sh
WHILE_CONFIG_DIR=~/.config/while-client-a wh login
```

## La doc

Les options, et le lien de partage pour quelqu'un qui n'a pas de compte while : https://while.sh/docs
