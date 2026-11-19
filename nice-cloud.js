'use strict';

/**
 * Import ponctuel des identifiants de la passerelle depuis le cloud MyNice.
 *
 * ⚠️ Non officiel. Reproduit ce que fait l'app Android MyNice (OAuth « password »
 * avec l'identifiant client public de l'app), d'après le code de l'intégration
 * Home Assistant « nice-it4wifi-ha ». Nice peut le modifier à tout moment.
 *
 * Le mot de passe du compte n'est utilisé que pour cette requête : il n'est ni
 * journalisé, ni enregistré. Seuls les identifiants de la passerelle (nom
 * d'utilisateur, mot de passe hexadécimal, identifiant client) sont conservés.
 */

const https = require('https');
const { normalizeMac } = require('./nice-client');

const DEFAULT_BASE_URL = 'https://integration.niceappdomain.com/myNiceCloud/';
const OAUTH_CLIENT_ID = 'android-client-id';
const OAUTH_CLIENT_SECRET = 'android-client-id_21';
const TOKEN_PATH = 'oauth/token';
const MACRO_USER_PATH = 'api/v1/macrouser/user';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 30000;
const HEADERS = {
  OS: 'Android',
  OSVersion: '13',
  DeviceModel: 'Google Pixel pixel',
  'Accept-Language': 'en',
  Accept: 'application/json',
};
const HEX64 = /^[0-9a-fA-F]{64}$/;

class CloudError extends Error {}

function request(url, { method, headers }, tlsOptions) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, timeout: TIMEOUT_MS, ...tlsOptions }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX_RESPONSE_BYTES) {
          req.destroy(new CloudError('réponse du cloud trop volumineuse'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new CloudError('délai dépassé en contactant le cloud MyNice')));
    req.on('error', (err) =>
      reject(err instanceof CloudError ? err : new CloudError(`cloud MyNice injoignable (${err.code || err.message})`))
    );
    req.end();
  });
}

function parseJsonObject(body) {
  let data;
  try {
    data = JSON.parse(body);
  } catch (err) {
    throw new CloudError('réponse du cloud illisible (JSON invalide)');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new CloudError('réponse du cloud inattendue');
  }
  return data;
}

const text = (v) => (typeof v === 'string' && v.trim() && v.trim().length <= 256 ? v.trim() : null);

/** Extrait les identifiants complets de la réponse « macrouser ». */
function parseAccessories(payload) {
  if (payload.result !== true) throw new CloudError('le cloud n’a pas renvoyé de résultat positif');
  const devices = payload.data && payload.data.smartDevices;
  if (!Array.isArray(devices)) throw new CloudError('liste d’appareils absente de la réponse du cloud');
  const found = new Map();
  for (const dev of devices) {
    const records = dev && dev.accessoryCredentials;
    if (!Array.isArray(records)) continue;
    for (const r of records) {
      if (!r || typeof r !== 'object') continue;
      const pwd = text(r.accessoryPassword);
      const user = text(r.accessoryUser);
      const source = text(r.controllerID);
      let mac;
      try {
        mac = normalizeMac(text(r.accessoryMacAddress) || '');
      } catch (err) {
        continue;
      }
      if (!pwd || !HEX64.test(pwd) || !user || !source || found.has(mac)) continue;
      found.set(mac, {
        name: text(r.description) || 'Nice',
        mac,
        username: user,
        password: pwd.toUpperCase(),
        source,
      });
    }
  }
  if (!found.size) throw new CloudError('aucun identifiant de passerelle complet dans la réponse du cloud');
  return [...found.values()];
}

/**
 * @param {string} email     compte MyNice
 * @param {string} password  mot de passe du compte (non conservé)
 * @param {object} [o]
 * @param {string} [o.baseUrl]     (tests) adresse du cloud, en https obligatoirement
 * @param {object} [o.tlsOptions]  (tests) options TLS supplémentaires
 */
async function fetchAccessories(email, password, o = {}) {
  const base = (o.baseUrl || DEFAULT_BASE_URL).replace(/\/?$/, '/');
  if (!base.startsWith('https://')) throw new CloudError('l’adresse du cloud doit être en https');
  if (!email || !password || email.length > 256 || password.length > 256) {
    throw new CloudError('e-mail et mot de passe requis (256 caractères maximum)');
  }

  const query = new URLSearchParams({ grant_type: 'password', username: email, password });
  const basic = Buffer.from(`${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`).toString('base64');
  const tok = await request(
    `${base}${TOKEN_PATH}?${query}`,
    { method: 'POST', headers: { ...HEADERS, Authorization: `Basic ${basic}` } },
    o.tlsOptions
  );
  if (tok.status === 400 || tok.status === 401) throw new CloudError('e-mail ou mot de passe MyNice refusés');
  if (tok.status === 403) throw new CloudError('accès refusé par le cloud MyNice (HTTP 403)');
  if (tok.status !== 200) throw new CloudError(`le cloud MyNice a répondu HTTP ${tok.status} à la connexion`);
  const auth = parseJsonObject(tok.body);
  if (typeof auth.access_token !== 'string' || !auth.access_token || String(auth.token_type || 'Bearer').toLowerCase() !== 'bearer') {
    throw new CloudError('réponse de connexion du cloud inattendue');
  }

  const res = await request(
    `${base}${MACRO_USER_PATH}`,
    { method: 'GET', headers: { ...HEADERS, Authorization: `Bearer ${auth.access_token}` } },
    o.tlsOptions
  );
  if (res.status === 401) throw new CloudError('jeton refusé par le cloud MyNice');
  if (res.status === 403) throw new CloudError('ce compte n’a pas accès aux identifiants de la passerelle (HTTP 403)');
  if (res.status !== 200) throw new CloudError(`le cloud MyNice a répondu HTTP ${res.status} à la lecture des appareils`);
  return parseAccessories(parseJsonObject(res.body));
}

module.exports = { fetchAccessories, parseAccessories, CloudError, DEFAULT_BASE_URL };
