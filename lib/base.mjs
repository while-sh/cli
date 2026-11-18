// Une base de l'organisation ouverte sur le poste (wh dev database) : un port local (127.0.0.1:5432 par défaut) qui
// parle PostgreSQL. Chaque client local s'authentifie avec un mot de passe éphémère que le poste tire lui-même et ne donne
// qu'à qui l'a lancé (l'adresse sur stdout, ou DATABASE_URL de la commande lancée) : un port local sans secret servirait
// tout processus du poste. Puis la connexion part au relais de l'organisation (HTTP/2 dans un WebSocket, le poste est le
// client), qui l'ouvre sous le rôle SQL de la personne ; le poste ne voit jamais le mot de passe de la base.
import http2 from 'node:http2';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { PROTOCOLE_DEV, fluxDuWebSocket } from './poste.mjs';

const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const message = (type, corps) => Buffer.concat([Buffer.from(type, 'latin1'), int32(corps.length + 4), corps]);
/** Une erreur FATAL au client local (S, V, C, M), puis la fin. */
const erreur = (code, texte) => message('E', Buffer.concat([
  Buffer.from('SFATAL\0VFATAL\0', 'utf8'), Buffer.from(`C${code}\0`, 'utf8'), Buffer.from(`M${texte}\0`, 'utf8'), Buffer.from([0]),
]));

/** Lit des octets d'une socket à mesure : n octets, ou un message typé. */
function lecteur(s) {
  let tampon = Buffer.alloc(0);
  let reveil = null;
  let ferme = false;
  s.on('data', (d) => { tampon = Buffer.concat([tampon, d]); reveil?.(); });
  s.on('close', () => { ferme = true; reveil?.(); });
  s.on('error', () => { ferme = true; reveil?.(); });
  const octets = async (n) => {
    while (tampon.length < n) {
      if (ferme || tampon.length > 64 * 1024) throw new Error('fermé');
      await new Promise((ok) => { reveil = ok; });
      reveil = null;
    }
    const b = tampon.subarray(0, n);
    tampon = tampon.subarray(n);
    return b;
  };
  return {
    octets,
    async message() { const t = await octets(5); return { type: String.fromCharCode(t[0]), corps: await octets(t.readInt32BE(1) - 4) }; },
    rendre() { s.removeAllListeners('data'); const r = tampon; tampon = Buffer.alloc(0); return r; },
  };
}

/** Une connexion locale : la poignée de main de PostgreSQL jouée ici (mot de passe local), puis le relais. */
async function client(s, h2, motDePasse) {
  const l = lecteur(s);
  let n;
  let code;
  // SSLRequest et GSSENCRequest : non (le port est local) ; puis le message de démarrage, ou une annulation.
  for (;;) {
    const tete = await l.octets(8);
    n = tete.readInt32BE(0);
    code = tete.readInt32BE(4);
    if (code === 80877103 || code === 80877104) { s.write('N'); continue; }
    break;
  }
  if (code === 80877102) {
    const cle = await l.octets(8);
    const f = h2.request({ ':method': 'POST', ':path': '/pg/annuler' });
    f.on('response', () => f.resume());
    f.on('error', () => {});
    f.end(cle);
    s.end();
    return;
  }
  if (code !== 196608) { s.end(erreur('08P01', 'protocole PostgreSQL 3 attendu')); return; }
  await l.octets(n - 8);
  // Le mot de passe local, en clair sur la boucle locale (jamais hors du poste).
  s.write(message('R', int32(3)));
  const m = await l.message();
  const donne = m.type === 'p' ? m.corps.subarray(0, Math.max(0, m.corps.indexOf(0))) : Buffer.alloc(0);
  const attendu = Buffer.from(motDePasse, 'utf8');
  if (donne.length !== attendu.length || !timingSafeEqual(donne, attendu)) { s.end(erreur('28P01', 'mot de passe local refusé (celui que wh dev a donné)')); return; }
  const f = h2.request({ ':method': 'POST', ':path': '/pg' });
  f.on('error', () => s.destroy());
  f.once('response', (e) => {
    if (Number(e[':status']) !== 200) {
      let texte = '';
      f.setEncoding('utf8');
      f.on('data', (d) => { texte += d; });
      f.on('end', () => s.end(erreur('08006', `while : ${texte || `le relais refuse (${e[':status']})`}`)));
      return;
    }
    const reste = l.rendre();
    if (reste.length) f.write(reste);
    f.pipe(s);
    s.pipe(f);
  });
  s.on('close', () => { if (!f.destroyed) f.close(); });
}

/**
 * Relie une base au poste : le WebSocket vers le relais de l'organisation (connect_url), le ticket, puis le port local.
 * Rend { tunnel, base, port, fermer(), fin } ; `fin` dit le code et la raison quand le relais coupe.
 */
export const relierBase = (o) => relierTunnel(o, client);

/**
 * Le tunnel d'une ressource (une base, un cache) : le WebSocket, le ticket, HTTP/2 dedans, puis le port local, dont
 * chaque connexion passe par `gerer(socket, h2, motDePasse)`.
 */
export function relierTunnel(o, gerer) {
  return new Promise((ok, ko) => {
    const ws = new WebSocket(o.url, PROTOCOLE_DEV);
    ws.binaryType = 'arraybuffer';
    let accueilli = false;
    let flux = null;
    let serveur = null;
    const recus = [];
    const fin = new Promise((r) => ws.addEventListener('close', (ev) => {
      flux?.push(null);
      flux?.destroy();
      serveur?.close();
      if (!accueilli) ko(new Error(ev.reason || `le relais a fermé (${ev.code})`));
      r({ code: ev.code, raison: ev.reason });
    }));
    ws.addEventListener('error', () => { if (!accueilli) ko(new Error('relais injoignable')); });
    ws.addEventListener('open', () => ws.send(JSON.stringify({ ticket: o.ticket })));
    ws.addEventListener('message', (ev) => {
      if (accueilli) {
        if (typeof ev.data === 'string') return;
        const b = Buffer.from(ev.data);
        if (flux) flux.push(b); else recus.push(b);
        return;
      }
      let a = {};
      try { a = JSON.parse(String(ev.data)); } catch { /* refusé plus bas */ }
      if (!a.ok || !a.tunnel) { ws.close(1000); return; }
      accueilli = true;
      flux = fluxDuWebSocket(ws, recus);
      flux.on('error', () => {});
      const h2 = http2.connect('http://relais', { createConnection: () => flux });
      h2.on('error', () => ws.close(1000));
      serveur = net.createServer((s) => { s.on('error', () => {}); void gerer(s, h2, o.motDePasse).catch(() => s.destroy()); });
      serveur.on('error', (e) => { ws.close(1000); ko(e); });
      serveur.listen(o.port, o.hote ?? '127.0.0.1', () => {
        ok({ tunnel: a.tunnel, base: a.base, port: serveur.address().port, expire: a.expires_at, fermer: () => ws.close(1000), fin });
      });
    });
  });
}
