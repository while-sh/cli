// Un cache Valkey de l'organisation ouvert sur le poste (wh dev cache) : un port local (127.0.0.1:6379 par défaut) qui
// parle RESP. Chaque client local s'authentifie avec le mot de passe éphémère que le poste a tiré (AUTH <mot de passe>,
// AUTH <utilisateur> <mot de passe>, ou HELLO <version> AUTH <utilisateur> <mot de passe>) ; rien ne part avant. Puis la
// connexion part au relais de l'organisation, qui l'ouvre sous l'utilisateur ACL de la personne ; le poste ne voit jamais
// son mot de passe. HELLO repart sans AUTH : le cache répond lui-même.
import { timingSafeEqual } from 'node:crypto';
import { relierTunnel } from './base.mjs';

const chaine = (x) => `$${Buffer.byteLength(x)}\r\n${x}\r\n`;
const tableau = (a) => `*${a.length}\r\n${a.map(chaine).join('')}`;
/** Une commande d'avant l'authentification : 4 Ko au plus. */
const MAX = 4096;

/** Lit la prochaine commande du client local (RESP ou en ligne), dans le tampon ; null s'il en manque. */
function commandeDe(t) {
  if (!t.length) return null;
  const nl = t.indexOf('\n');
  if (t[0] !== 0x2a) {
    if (nl < 0) return null;
    return { args: t.subarray(0, nl).toString('utf8').replace(/\r$/, '').trim().split(/\s+/).filter(Boolean), lu: nl + 1 };
  }
  if (nl < 0) return null;
  const n = Number(t.subarray(1, nl).toString().trim());
  if (!Number.isInteger(n) || n < 0 || n > 64) throw new Error('commande illisible');
  let i = nl + 1;
  const args = [];
  for (let k = 0; k < n; k++) {
    const f = t.indexOf('\r\n', i);
    if (f < 0) return null;
    const l = Number(t.subarray(i + 1, f).toString());
    if (t[i] !== 0x24 || !Number.isInteger(l) || l < 0 || l > MAX) throw new Error('commande illisible');
    if (t.length < f + 2 + l + 2) return null;
    args.push(t.subarray(f + 2, f + 2 + l).toString('utf8'));
    i = f + 2 + l + 2;
  }
  return { args, lu: i };
}

function bonMotDePasse(donne, attendu) {
  const a = Buffer.from(String(donne ?? ''), 'utf8');
  const b = Buffer.from(attendu, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Une connexion locale : l'authentification jouée ici, puis le relais. */
function client(s, h2, motDePasse) {
  let tampon = Buffer.alloc(0);
  let fini = false;
  const lire = (d) => {
    if (fini) return;
    tampon = Buffer.concat([tampon, d]);
    try {
      for (;;) {
        const c = commandeDe(tampon);
        if (!c) { if (tampon.length > MAX * 2) throw new Error('commande trop longue'); return; }
        tampon = tampon.subarray(c.lu);
        const nom = (c.args[0] ?? '').toUpperCase();
        if (nom === 'AUTH' && (c.args.length === 2 || c.args.length === 3)) {
          if (!bonMotDePasse(c.args.at(-1), motDePasse)) { s.write('-WRONGPASS mot de passe local refusé (celui que wh dev a donné)\r\n'); continue; }
          return ouvrir('+OK\r\n', null);
        }
        if (nom === 'HELLO' && c.args.length >= 2) {
          const k = c.args.findIndex((x, j) => j > 1 && x.toUpperCase() === 'AUTH');
          if (k < 0) { s.write('-NOAUTH HELLO doit porter AUTH <utilisateur> <mot de passe> (le mot de passe local de wh dev)\r\n'); continue; }
          if (!bonMotDePasse(c.args[k + 2], motDePasse)) { s.write('-WRONGPASS mot de passe local refusé (celui que wh dev a donné)\r\n'); continue; }
          return ouvrir(null, tableau([...c.args.slice(0, k), ...c.args.slice(k + 3)]));
        }
        if (nom) s.write('-NOAUTH Authentication required.\r\n');
      }
    } catch {
      fini = true;
      s.end('-ERR commande illisible\r\n');
    }
  };
  /** Le flux vers le relais ; `reponse` au client local (AUTH), ou `premiere` commande pour le cache (HELLO sans AUTH). */
  const ouvrir = (reponse, premiere) => {
    fini = true;
    s.off('data', lire);
    s.pause();
    const f = h2.request({ ':method': 'POST', ':path': '/valkey' });
    f.on('error', () => s.destroy());
    f.once('response', (e) => {
      if (Number(e[':status']) !== 200) {
        let texte = '';
        f.setEncoding('utf8');
        f.on('data', (d) => { texte += d; });
        f.on('end', () => s.end(`-ERR while : ${(texte || `le relais refuse (${e[':status']})`).replace(/[\r\n]+/g, ' ')}\r\n`));
        return;
      }
      if (reponse) s.write(reponse);
      if (premiere) f.write(premiere);
      if (tampon.length) f.write(tampon);
      f.pipe(s);
      s.pipe(f);
    });
    s.on('close', () => { if (!f.destroyed) f.close(); });
  };
  s.on('data', lire);
  return Promise.resolve();
}

/**
 * Relie un cache au poste : le WebSocket vers le relais de l'organisation (connect_url), le ticket, puis le port local.
 * Rend { tunnel, base (le nom du cache), port, fermer(), fin }.
 */
export const relierCache = (o) => relierTunnel(o, client);
