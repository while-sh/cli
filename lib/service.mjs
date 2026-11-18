// Une appli interne de l'organisation sur le poste (wh dev service) : un port local (127.0.0.1:8000 par défaut) qui
// relaie chaque requête vers l'adresse de l'appli, par l'entrée de while comme un navigateur, avec l'identifiant d'une
// heure de la personne pour ce poste (le cookie __Host-while-agent : l'appli reçoit la personne). Cet identifiant reste
// dans la mémoire du processus, jamais sur le disque ni dans .while/. Le port est fermé par un mot de passe local tiré
// pour la session (Basic, utilisateur « dev ») : un port ouvert sans secret servirait tout processus du poste. Vérifié
// puis retiré ici ; les cookies de while qu'un client enverrait aussi sont retirés.
import http from 'node:http';
import https from 'node:https';
import { timingSafeEqual } from 'node:crypto';

const SAUT = new Set(['connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);
// Ni le mot de passe local ni les en-têtes d'un proxy ne vont à l'appli (une entrée par appel : la règle generic-api-key
// de gitleaks lirait une liste d'en-têtes d'authentification comme une clé).
SAUT.add('authorization');
SAUT.add('proxy-authorization');
SAUT.add('proxy-authenticate');
const COOKIE_AGENT = '__Host-while-agent';

function bonMotDePasse(entete, attendu) {
  const m = /^basic\s+([A-Za-z0-9+/=._-]+)$/i.exec(String(entete ?? '').trim());
  if (!m) return false;
  const texte = Buffer.from(m[1], 'base64').toString('utf8');
  const donne = Buffer.from(texte.slice(texte.indexOf(':') + 1), 'utf8');
  const b = Buffer.from(attendu, 'utf8');
  return texte.includes(':') && donne.length === b.length && timingSafeEqual(donne, b);
}

/**
 * Sert l'appli sur le port local. `identifiant()` rend l'identifiant en cours ({ credential, address, read_only }) ou
 * null quand il manque (en renouvellement) ; rend { port, fermer }.
 */
export function servirAppli(o) {
  const serveur = http.createServer((req, res) => {
    if (!bonMotDePasse(req.headers.authorization, o.motDePasse)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="while dev", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
      res.end("mot de passe local attendu (celui de l'adresse que wh dev a donnée)\n");
      return;
    }
    const c = o.identifiant();
    if (!c) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '5' }).end("l'identifiant de l'appli se renouvelle : réessayez\n"); return; }
    if (c.read_only && req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' }).end('production : GET et HEAD seulement\n');
      return;
    }
    const cible = new URL(c.address);
    const entetes = {};
    for (const [k, v] of Object.entries(req.headers)) if (!SAUT.has(k) && k !== 'cookie') entetes[k] = v;
    const cookies = String(req.headers.cookie ?? '').split(/;\s*/).filter((x) => x && !/^__Host-while-/i.test(x));
    entetes.cookie = [...cookies, `${COOKIE_AGENT}=${c.credential}`].join('; ');
    entetes.host = cible.host;
    const amont = (cible.protocol === 'http:' ? http : https).request({
      hostname: cible.hostname, port: cible.port || (cible.protocol === 'http:' ? 80 : 443), method: req.method, path: req.url, headers: entetes,
    }, (r) => {
      const retour = {};
      for (const [k, v] of Object.entries(r.headers)) if (!SAUT.has(k)) retour[k] = v;
      res.writeHead(r.statusCode ?? 502, retour);
      r.pipe(res);
    });
    amont.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end(`while : l'appli ne répond pas (${e.message})\n`); });
    req.pipe(amont);
  });
  return new Promise((ok, ko) => {
    serveur.on('error', ko);
    serveur.listen(o.port, o.hote ?? '127.0.0.1', () => ok({ port: serveur.address().port, fermer: () => new Promise((r) => serveur.close(() => r())) }));
  });
}
