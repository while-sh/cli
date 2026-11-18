// La connexion du poste à while : le flux d'appareil OAuth (RFC 8628) du client while-cli, portée « dev », une
// organisation choisie sur la page de while. Le jeton d'accès (une heure) et celui de rafraîchissement (30 jours, qui
// tourne) sont gardés dans ~/.config/while/identifiants.json, lisible du seul compte du poste (0600). Ils n'ouvrent que
// le mode dev : ni les données, ni les mises en ligne de l'organisation.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';

export const CLIENT = 'while-cli';
const OCTROI_APPAREIL = 'urn:ietf:params:oauth:grant-type:device_code';

/** Le dossier de while sur le poste (WHILE_CONFIG_DIR, sinon $XDG_CONFIG_HOME/while, sinon ~/.config/while). */
export const dossier = () => process.env.WHILE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'while');
/** L'adresse de while (WHILE_URL pour une autre instance). */
export const adresseWhile = () => (process.env.WHILE_URL || 'https://app.while.sh').replace(/\/+$/, '');
const fichier = () => join(dossier(), 'identifiants.json');

function lire() {
  try { return JSON.parse(readFileSync(fichier(), 'utf8')); } catch { return null; }
}

function garder(jetons) {
  mkdirSync(dossier(), { recursive: true, mode: 0o700 });
  writeFileSync(fichier(), `${JSON.stringify({
    adresse: adresseWhile(), access_token: jetons.access_token, refresh_token: jetons.refresh_token,
    expire_le: Date.now() + (Number(jetons.expires_in) || 3600) * 1000,
  }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(fichier(), 0o600);
}

async function formulaire(chemin, champs) {
  const r = await fetch(`${adresseWhile()}${chemin}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(champs),
  });
  return { statut: r.status, corps: await r.json().catch(() => ({})) };
}

const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

/**
 * Connecte le poste : la personne ouvre la page de while (dire() l'écrit sur stderr), confirme le nom du poste et choisit
 * l'organisation ; le client interroge while à l'intervalle qu'il donne, jusqu'à la réponse ou l'expiration du code.
 */
export async function connecter({ dire }) {
  const d = await formulaire('/oauth/device_authorization', { client_id: CLIENT, scope: 'dev', device_name: (hostname() || 'poste').slice(0, 64) });
  if (d.statut !== 200 || !d.corps.device_code) throw new Error(`while refuse la connexion du poste : ${d.corps.error_description || d.corps.error || `HTTP ${d.statut}`}`);
  dire(`Pour connecter ce poste à while, ouvrez ${d.corps.verification_uri_complete} et vérifiez le code ${d.corps.user_code} (${Math.round(d.corps.expires_in / 60)} min).`);
  let intervalle = Number(d.corps.interval) || 5;
  const fin = Date.now() + Number(d.corps.expires_in) * 1000;
  while (Date.now() < fin) {
    await pause(intervalle * 1000);
    const t = await formulaire('/oauth/token', { grant_type: OCTROI_APPAREIL, device_code: d.corps.device_code, client_id: CLIENT });
    if (t.statut === 200 && t.corps.access_token) { garder(t.corps); dire('Poste connecté.'); return; }
    const e = t.corps.error;
    if (e === 'authorization_pending') continue;
    if (e === 'slow_down') { intervalle += 5; continue; }
    if (e === 'access_denied') throw new Error('Connexion refusée sur la page de while.');
    if (e === 'expired_token') break;
    throw new Error(`while refuse la connexion du poste : ${t.corps.error_description || e || `HTTP ${t.statut}`}`);
  }
  throw new Error('Le code a expiré : relancez la commande.');
}

/** Un jeton d'accès valable, rafraîchi s'il le faut ; null si le poste n'est pas connecté (ou plus). */
export async function jeton() {
  const x = lire();
  if (!x || x.adresse !== adresseWhile() || !x.access_token) return null;
  if (Number(x.expire_le) - 60_000 > Date.now()) return x.access_token;
  if (!x.refresh_token) return null;
  const t = await formulaire('/oauth/token', { grant_type: 'refresh_token', refresh_token: x.refresh_token, client_id: CLIENT });
  if (t.statut !== 200 || !t.corps.access_token) return null;
  garder(t.corps);
  return t.corps.access_token;
}

/** Oublie les jetons du poste (la page Agents de while déconnecte aussi le poste, de partout). */
export function deconnecter() {
  rmSync(fichier(), { force: true });
}
