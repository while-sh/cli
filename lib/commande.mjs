// La ligne de commande de while (while-sh) : wh dev, wh dev database, wh dev cache, wh dev service, wh dev status,
// wh dev stop, wh login, wh logout.
import { createRequire } from 'node:module';
import { connecter, deconnecter, jeton } from './compte.mjs';
import { arreter, dev, devBase, devService, statut } from './dev.mjs';

const AIDE = `wh — le mode dev de while (https://while.sh). Sans installation : npx while-sh <commande>.

  wh dev [--project <slug>] [--port <n>] [--name <nom>] [--json] [-- <commande du serveur de dev>]
      Sert le serveur de dev de ce poste sous une adresse de while, que seuls les membres de l'organisation ouvrent.
      stdout : l'adresse ; stderr : l'état. Le port : --port, sinon le premier qui écoute parmi 5173, 3000, 4321, 8080.
  wh dev database [nom] --env <env> [--project <slug>] [--port 5432] [--json] [-- <commande>]
      Ouvre une base de l'environnement sur un port local, sous votre rôle SQL et vos droits. stdout : l'adresse, avec un
      mot de passe local tiré pour cette session (DATABASE_URL de la commande lancée après --). En production : en
      lecture seule, après votre confirmation (admin, propriétaire) ou par une attribution bornée dans le temps.
  wh dev cache <nom> --env <env> [--project <slug>] [--port 6379] [--json] [-- <commande>]
      Ouvre un cache Valkey de l'environnement sur un port local, sous votre utilisateur ACL : lecture avec data.read sur
      l'environnement, écriture avec data.write (hors production). stdout : l'adresse redis://, avec un mot de passe local
      tiré pour cette session (REDIS_URL de la commande lancée après --). KEYS est fermé : SCAN.
  wh dev service [nom] --env <env> [--project <slug>] [--port 8000] [--json] [-- <commande>]
      Ouvre une appli interne de l'organisation (son adresse while) sur un port local, sous votre identité : l'appli vous
      reçoit comme dans votre navigateur. stdout : l'adresse http://dev:<mot de passe local>@127.0.0.1:8000
      (WHILE_SERVICE_URL de la commande lancée après --). En production : GET et HEAD seulement.
  wh dev status      Les adresses reliées depuis ce poste.
  wh dev stop [nom]  Les arrête (toutes, ou celle de ce nom).
  wh login           Connecte ce poste (une page de while à ouvrir, un code à vérifier).
  wh logout          Oublie la connexion de ce poste.
`;

/** Les options : --x valeur, --x=valeur, --drapeau ; ce qui suit « -- » est la commande du serveur de dev. */
export function lireArguments(args) {
  const i = args.indexOf('--');
  const avant = i < 0 ? args : args.slice(0, i);
  const o = { mots: [], commande: i < 0 ? [] : args.slice(i + 1) };
  for (let k = 0; k < avant.length; k++) {
    const a = avant[k];
    if (!a.startsWith('--')) { o.mots.push(a); continue; }
    const [nom, valeur] = a.slice(2).split(/=(.*)/s);
    if (['json', 'help', 'version'].includes(nom)) o[nom] = true;
    else o[nom] = valeur ?? avant[++k];
  }
  return o;
}

export async function principal(args, io = { sortie: (l) => process.stdout.write(`${l}\n`), dire: (l) => process.stderr.write(`wh: ${l}\n`) }) {
  const majeure = Number(process.versions.node.split('.')[0]);
  if (majeure < 22) { io.dire(`Node 22 au moins (ici ${process.versions.node})`); return 1; }
  const o = lireArguments(args);
  if (o.version) { io.sortie(createRequire(import.meta.url)('../package.json').version); return 0; }
  const [cmd, sous, quoi] = o.mots;
  try {
    if (o.help || !cmd) { io.sortie(AIDE); return cmd || o.help ? 0 : 1; }
    if (cmd === 'login') { if (await jeton()) { io.dire('ce poste est déjà connecté'); return 0; } await connecter(io); return 0; }
    if (cmd === 'logout') { deconnecter(); io.dire('connexion du poste oubliée'); return 0; }
    if (cmd === 'dev' && sous === 'status') return statut(io);
    if (cmd === 'dev' && sous === 'stop') return arreter({ ...io, quoi });
    if (cmd === 'dev' && (sous === 'database' || sous === 'db' || sous === 'cache')) {
      // --port 0 : un port libre, que l'adresse donne.
      const port = o.port === undefined ? null : Number(o.port);
      if (port !== null && !(Number.isInteger(port) && port >= 0 && port < 65536)) { io.dire('--port : un numéro de port (0 : un port libre)'); return 1; }
      if (sous === 'cache' && !(quoi ?? o.cache)) { io.dire('wh dev cache <nom> : le nom du cache (celui de while.yaml)'); return 1; }
      return await devBase({ ...io, genre: sous === 'cache' ? 'cache' : 'base', projet: o.project, env: o.env, base: quoi ?? (sous === 'cache' ? o.cache : o.database), port, json: !!o.json, commande: o.commande });
    }
    if (cmd === 'dev' && sous === 'service') {
      const port = o.port === undefined ? null : Number(o.port);
      if (port !== null && !(Number.isInteger(port) && port >= 0 && port < 65536)) { io.dire('--port : un numéro de port (0 : un port libre)'); return 1; }
      return await devService({ ...io, projet: o.project, env: o.env, service: quoi ?? o.service, port, json: !!o.json, commande: o.commande });
    }
    if (cmd === 'dev' && !sous) {
      const port = o.port === undefined ? null : Number(o.port);
      if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) { io.dire('--port : un numéro de port'); return 1; }
      return await dev({ ...io, projet: o.project, port, nom: o.name, json: !!o.json, commande: o.commande });
    }
    io.dire(`commande inconnue : ${o.mots.join(' ')} (wh --help)`);
    return 1;
  } catch (e) {
    io.dire(e.message);
    return 1;
  }
}
