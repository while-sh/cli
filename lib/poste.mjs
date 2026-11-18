// Le côté poste du tunnel inverse du mode dev (docs/while-dev.md dans le dépôt de while) : rien que Node (22 au moins),
// le WebSocket natif, node:http2, node:http et node:net.
//
// Le poste ouvre un WebSocket vers le relais (sous-protocole while-dev.v1), y présente son ticket, reçoit l'adresse que
// while a fixée, puis sert du HTTP/2 dans ce WebSocket : le relais est le client, le poste le serveur. Chaque requête
// d'un visiteur arrive en flux HTTP/2 et part vers le serveur de dev local ; un WebSocket de visiteur (le HMR) arrive en
// CONNECT étendu (RFC 8441) et devient une poignée de main HTTP/1.1 vers le même serveur, puis un tuyau d'octets.
// La cible est fixée au lancement (la boucle locale, <port>) : ni l'en-tête Host ni le chemin ne choisissent où le poste se
// connecte, le relais ne peut donc rien faire joindre d'autre au poste.
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { Duplex } from 'node:stream';

/** Le sous-protocole du WebSocket du poste, que le relais exige (PROTOCOLE_DEV de src/core/dev.ts). */
export const PROTOCOLE_DEV = 'while-dev.v1';
/** Propres à un saut de connexion : retirés de ce qui passe d'un côté à l'autre (HTTP/2 les interdit). */
const SAUT = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'http2-settings', 'host']);
const sansSaut = (e) => {
  const out = {};
  for (const [k, v] of Object.entries(e)) if (v !== undefined && !k.startsWith(':') && !SAUT.has(k.toLowerCase())) out[k.toLowerCase()] = v;
  return out;
};

/** Un WebSocket (l'API du navigateur, celle de Node 22) vu comme un flux d'octets : chaque écriture part en un message binaire. */
export function fluxDuWebSocket(ws, recus) {
  const d = new Duplex({
    read() {},
    write(morceau, _e, fini) {
      if (ws.readyState !== WebSocket.OPEN) { fini(new Error('WebSocket fermé')); return; }
      ws.send(morceau);
      const attendre = () => (ws.bufferedAmount > 4 * 1024 * 1024 && ws.readyState === WebSocket.OPEN ? setTimeout(attendre, 10) : fini());
      attendre();
    },
    final(fini) { try { ws.close(1000); } catch { /* déjà fermé */ } fini(); },
    destroy(e, fini) { try { ws.close(1000); } catch { /* déjà fermé */ } fini(e); },
  });
  for (const b of recus.splice(0)) d.push(b);
  return d;
}

/** La boucle locale, 127.0.0.1 puis ::1 : Vite et Astro écoutent sur « localhost », que Node résout souvent en ::1 seul. */
const BOUCLE = [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }];
const boucle = (_nom, o, rappel) => (o?.all ? rappel(null, BOUCLE) : rappel(null, BOUCLE[0].address, BOUCLE[0].family));
/** Les options d'une connexion au serveur de dev : son port sur la boucle locale, les deux familles essayées tour à tour. */
export const versLocal = (port) => ({ host: 'localhost', port, lookup: boucle, autoSelectFamily: true });
const versCible = (cible) => (cible.hote ? { host: cible.hote, port: cible.port } : versLocal(cible.port));

/** Le 403 de Vite à un en-tête Host qu'il ne connaît pas (server.allowedHosts). */
const REFUS_VITE = /^Blocked request\. This host /;

/** Une poignée de main WebSocket vers le serveur local, pour un CONNECT étendu ; puis un tuyau d'octets. */
function poignee(flux, e, cible, signaler) {
  const s = net.connect(versCible(cible));
  const lignes = [`GET ${e[':path'] ?? '/'} HTTP/1.1`, `host: ${e[':authority'] ?? ''}`, 'connection: Upgrade', 'upgrade: websocket'];
  for (const [k, v] of Object.entries(sansSaut(e))) for (const x of Array.isArray(v) ? v : [v]) lignes.push(`${k}: ${x}`);
  s.write(`${lignes.join('\r\n')}\r\n\r\n`);
  let tampon = Buffer.alloc(0);
  const surDonnees = (b) => {
    tampon = Buffer.concat([tampon, b]);
    const i = tampon.indexOf('\r\n\r\n');
    if (i < 0) { if (tampon.length > 64 * 1024) s.destroy(); return; }
    s.off('data', surDonnees);
    const [ligne, ...brutes] = tampon.subarray(0, i).toString('latin1').split('\r\n');
    const reste = tampon.subarray(i + 4);
    const statut = Number(ligne.split(' ')[1]) || 502;
    const h = {};
    for (const l of brutes) { const j = l.indexOf(':'); if (j > 0) h[l.slice(0, j).trim().toLowerCase()] = l.slice(j + 1).trim(); }
    if (statut !== 101) {
      flux.respond({ ':status': statut, ...(h['content-type'] ? { 'content-type': h['content-type'] } : {}) });
      flux.end(reste);
      s.destroy();
      return;
    }
    const poignees = Object.fromEntries(Object.entries(h).filter(([k]) => /^sec-websocket-(accept|protocol|extensions)$/.test(k)));
    flux.respond({ ':status': 200, ...poignees });
    if (reste.length) flux.write(reste);
    s.pipe(flux);
    flux.pipe(s);
  };
  s.on('data', surDonnees);
  s.on('error', () => {
    if (!flux.headersSent) {
      signaler({ type: 'sans-serveur', message: `rien n'écoute sur le port ${cible.port}` });
      flux.respond({ ':status': 502 });
      flux.end();
    } else flux.destroy();
  });
  s.on('close', () => { if (!flux.destroyed) flux.end(); });
  flux.on('close', () => s.destroy());
  flux.on('error', () => s.destroy());
}

/** Le chemin où le relais remet une remarque de page (CHEMIN_REMARQUES de src/donnees/dev.ts). */
export const CHEMIN_REMARQUES = '/__while/remarques';

/** Une remarque remise par le relais : 64 Ko au plus, du JSON ; remarque() la reçoit, le relais reçoit 204. */
function recevoirRemarque(flux, remarque) {
  const morceaux = [];
  let n = 0;
  flux.on('data', (m) => { n += m.length; if (n <= 64 * 1024) morceaux.push(m); });
  flux.on('end', () => {
    let r = null;
    try { r = n <= 64 * 1024 ? JSON.parse(Buffer.concat(morceaux).toString('utf8')) : null; } catch { r = null; }
    if (r && typeof r === 'object') { try { remarque?.(r); } catch { /* l'écriture de la remarque ne coupe pas le tunnel */ } }
    flux.respond({ ':status': r ? 204 : 400 });
    flux.end();
  });
}

/** Une requête de visiteur vers le serveur local, sa réponse en retour. */
function requete(flux, e, cible, signaler) {
  const req = http.request({
    ...versCible(cible), method: String(e[':method'] ?? 'GET'), path: String(e[':path'] ?? '/'),
    headers: { ...sansSaut(e), host: String(e[':authority'] ?? '') },
  });
  req.on('response', (r) => {
    if (flux.destroyed) { r.destroy(); return; }
    flux.respond({ ':status': r.statusCode ?? 502, ...sansSaut(r.headers) });
    if (r.statusCode === 403 && /^text\/plain/.test(String(r.headers['content-type'] ?? ''))) {
      r.once('data', (m) => { if (REFUS_VITE.test(m.toString('utf8', 0, 64))) signaler({ type: 'hote-refuse', hote: String(e[':authority'] ?? '') }); });
    }
    r.pipe(flux);
  });
  req.on('error', () => {
    if (flux.destroyed) return;
    if (!flux.headersSent) {
      signaler({ type: 'sans-serveur', message: `rien n'écoute sur le port ${cible.port} : 502 aux visiteurs` });
      flux.respond({ ':status': 502, 'content-type': 'text/plain; charset=utf-8' });
      flux.end(`Le poste est relié, mais rien n'écoute sur le port ${cible.port}.\n`);
    } else flux.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
  });
  flux.on('close', () => { if (!req.writableFinished || !req.destroyed) req.destroy(); });
  flux.pipe(req);
}

/**
 * Relie le serveur de dev local (la boucle locale, ou `hote` s'il est donné ; `port`) au relais, avec un ticket de l'API (POST /v1/projects/:slug/dev-sessions).
 * Rejette si le relais refuse le ticket ; sinon rend { hote, url, session, expire, fermer(), fin } : `fin` dit quand et
 * pourquoi la connexion tombe ({ code, raison }, les codes de src/core/dev.ts, FERMETURES_DEV).
 * evenement({ type: 'relie' | 'sans-serveur' | 'ferme', message } | { type: 'hote-refuse', hote }) : ce qui arrive, pour
 * l'écrire sur stderr.
 */
export function relierPoste(o) {
  const cible = { hote: o.hote, port: o.port };
  const signaler = o.evenement ?? (() => {});
  return new Promise((ok, ko) => {
    const ws = new WebSocket(o.url, PROTOCOLE_DEV);
    ws.binaryType = 'arraybuffer';
    let accueilli = false;
    let flux = null;
    const recus = [];
    const fin = new Promise((r) => ws.addEventListener('close', (ev) => {
      flux?.push(null);
      flux?.destroy();
      if (!accueilli) ko(new Error(ev.reason || `le relais a fermé (${ev.code})`));
      signaler({ type: 'ferme', message: `${ev.code} ${ev.reason}`.trim() });
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
      if (!a.ok || !a.host) { ws.close(1000); return; }
      accueilli = true;
      const serveur = http2.createServer({ settings: { enableConnectProtocol: true, enablePush: false } });
      serveur.on('stream', (f, e) => {
        f.on('error', () => {});
        // Une remarque de page que le relais remet (un chemin qu'il refuse aux visiteurs) : pour l'agent du poste.
        if (e[':path'] === CHEMIN_REMARQUES && e[':method'] === 'POST') { recevoirRemarque(f, o.remarque); return; }
        if (e[':method'] === 'CONNECT' && e[':protocol'] === 'websocket') poignee(f, e, cible, signaler);
        else requete(f, e, cible, signaler);
      });
      serveur.on('session', (s) => s.on('error', () => {}));
      flux = fluxDuWebSocket(ws, recus);
      flux.on('error', () => {});
      serveur.emit('connection', flux);
      signaler({ type: 'relie', message: a.url });
      ok({ hote: a.host, url: a.url, session: a.session, expire: a.expires_at, fermer: () => ws.close(1000), fin });
    });
  });
}
