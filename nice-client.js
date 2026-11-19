'use strict';

/**
 * Client du protocole "NHK" utilisé par l'interface Nice IT4WIFI (app MyNice).
 *
 * Protocole (rétro-ingénierie documentée par la communauté openHAB) :
 *  - TLS sur le port 443 (certificat auto-signé, pile TLS ancienne)
 *  - messages XML encadrés par STX (0x02) ... ETX (0x03)
 *  - VERIFY -> CONNECT (échange de challenges) -> requêtes signées (STATUS / CHANGE)
 *  - signature = base64( sha256( sha256(xml) || motDePasseDeSession ) )
 *  - motDePasseDeSession = sha256( pwdAppairage || inverse(SC) || inverse(CC) )
 */

const tls = require('tls');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const STX = 0x02;
const ETX = 0x03;
const MAX_RX_BYTES = 1024 * 1024;

const sha256 = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
const reverse = (buf) => Buffer.from(buf).reverse();
const xmlEscape = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function normalizeMac(mac) {
  const hex = String(mac).replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (hex.length !== 12) throw new Error(`Adresse MAC invalide : ${mac}`);
  return hex.match(/.{2}/g).join(':');
}

// Mot de passe d'appairage : base64 (renvoyé par PAIR) ou 64 caractères hexadécimaux.
function parsePairingPassword(pwd) {
  const s = String(pwd).trim();
  return /^[0-9a-fA-F]{64}$/.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
}

// open | closed | opening | closing | stopped  (ou null si inconnu)
function normalizeDoorState(raw) {
  switch (String(raw).trim().toLowerCase()) {
    case 'open':
    case 'opened':
      return 'open';
    case 'closed':
    case 'close':
      return 'closed';
    case 'opening':
      return 'opening';
    case 'closing':
      return 'closing';
    case 'stopped':
    case 'stop':
      return 'stopped';
    default:
      return null;
  }
}

// Extrait l'état d'un équipement d'une réponse STATUS ou d'un évènement CHANGE.
function parseDeviceStatus(xml, deviceId) {
  const dev = new RegExp(`<Device\\s+id="${deviceId}"[^>]*>([\\s\\S]*?)</Device>`).exec(xml);
  if (!dev) return null;
  const door = /<DoorStatus[^>]*>\s*([A-Za-z]+)\s*<\/DoorStatus>/.exec(dev[1]);
  const state = door ? normalizeDoorState(door[1]) : null;
  if (!state) return null;
  const obs = /<Obstruct[^>]*>\s*(\w+)\s*<\/Obstruct>/.exec(dev[1]);
  return {
    door: state,
    obstruct: obs ? obs[1] === '1' || obs[1].toLowerCase() === 'true' : null,
  };
}

function findError(xml) {
  if (/<Error\b/.test(xml) || /\btype="ERROR"/.test(xml)) {
    const code = /<Error\b[^>]*\bcode="?(\w+)/.exec(xml);
    return code ? `code ${code[1]}` : 'erreur';
  }
  return null;
}

class NiceClient extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.host       IP de l'IT4WIFI
   * @param {string} o.mac        MAC de l'IT4WIFI (utilisée comme "target")
   * @param {string} o.username   utilisateur appairé
   * @param {string} [o.password] mot de passe d'appairage (obligatoire sauf pour pair())
   * @param {number} [o.deviceId] identifiant du moteur sur le bus T4 (1 par défaut)
   */
  constructor(o) {
    super();
    this.host = o.host;
    this.port = o.port || 443;
    this.mac = normalizeMac(o.mac);
    this.username = o.username;
    this.pairingPassword = o.password ? parsePairingPassword(o.password) : null;
    this.source = o.source || sha256(Buffer.from(String(o.username))).toString('hex').slice(0, 16);
    this.deviceId = o.deviceId == null ? 1 : o.deviceId;
    this.timeoutMs = o.timeoutMs || 8000;
    this.log = o.log || { debug() {} };
    this.seq = 1;
    this.socket = null;
    this.rx = Buffer.alloc(0);
    this.pending = new Map();
    this.sessionId = 0;
    this.sessionPassword = null;
    this.authenticated = false;
  }

  get isOpen() {
    return Boolean(this.socket) && this.authenticated;
  }

  setPassword(pwd) {
    this.pairingPassword = parsePairingPassword(pwd);
  }

  // ---- connexion -------------------------------------------------------

  _tlsConnect() {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        host: this.host,
        port: this.port,
        servername: '',
        rejectUnauthorized: false, // certificat auto-signé
        minVersion: 'TLSv1',
        ciphers: 'DEFAULT:@SECLEVEL=0', // l'IT4WIFI utilise une clé DH de 1024 bits
        secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT, // pile pré-RFC 5746
      });
      const timer = setTimeout(() => socket.destroy(new Error('délai de connexion dépassé')), this.timeoutMs);
      socket.once('secureConnect', () => {
        clearTimeout(timer);
        socket.setKeepAlive(true, 15000);
        socket.setNoDelay(true);
        this.rx = Buffer.alloc(0);
        this.socket = socket;
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('close', () => this._onClosed(socket));
        socket.on('error', (err) => this.log.debug(`socket : ${err.message}`));
        resolve();
      });
      socket.once('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Connexion + VERIFY + CONNECT : après cet appel les requêtes signées sont possibles. */
  async open() {
    if (this.isOpen) return;
    this.close();
    if (!this.pairingPassword) throw new Error("mot de passe d'appairage manquant");
    await this._tlsConnect();
    try {
      this.sessionId = 0;
      this.sessionPassword = null;
      const user = xmlEscape(this.username);

      const v = await this._send('VERIFY', `<User username="${user}"/>`, { sign: false });
      this._assertOk(v, 'VERIFY');
      if (!/<Authentication\b/.test(v)) {
        throw new Error(`utilisateur "${this.username}" inconnu de la passerelle (appairage nécessaire)`);
      }

      const cc = crypto.randomBytes(4).toString('hex').toUpperCase();
      const c = await this._send('CONNECT', `<Authentication username="${user}" cc="${cc}"/>`, { sign: false });
      this._assertOk(c, 'CONNECT');
      const sc = /\bsc="([0-9A-Fa-f]+)"/.exec(c);
      if (!sc) throw new Error('CONNECT : challenge serveur absent (utilisateur non autorisé dans MyNice ?)');
      const sid = /<Authentication\b[^>]*\bid="(\d+)"/.exec(c);
      this.sessionId = sid ? parseInt(sid[1], 10) : 0;
      this.sessionPassword = sha256(
        this.pairingPassword,
        reverse(Buffer.from(sc[1], 'hex')),
        reverse(Buffer.from(cc, 'hex'))
      );
      this.authenticated = true;
    } catch (err) {
      this.close();
      throw err;
    }
  }

  /** Fermeture volontaire (n'émet pas l'évènement "close"). */
  close() {
    const socket = this.socket;
    this.socket = null;
    this.authenticated = false;
    this.sessionPassword = null;
    this.rx = Buffer.alloc(0);
    this._rejectAll(new Error('connexion fermée'));
    if (socket) socket.destroy();
  }

  _onClosed(socket) {
    if (this.socket !== socket) return; // fermeture volontaire déjà traitée
    this.socket = null;
    this.authenticated = false;
    this.sessionPassword = null;
    this._rejectAll(new Error('connexion perdue'));
    this.emit('close');
  }

  _rejectAll(err) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  // ---- messages --------------------------------------------------------

  _sign(xml) {
    return sha256(sha256(Buffer.from(xml, 'utf8')), this.sessionPassword).toString('base64');
  }

  _send(type, body, { sign = true } = {}) {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error('non connecté'));
    if (sign && !this.sessionPassword) return Promise.reject(new Error('session non établie'));

    const id = String(((this.seq++ & 0x7fffff) << 8) | (this.sessionId & 0xff));
    const start =
      `<Request id="${id}" source="${this.source}" target="${this.mac}" gw="gwID" ` +
      `protocolType="NHK" protocolVersion="1.0" type="${type}">\r\n`;
    let xml = start + body;
    if (sign) xml += `<Sign>${this._sign(start + body)}</Sign>`;
    xml += '</Request>\r\n';

    this.log.debug(`-> ${type} (id ${id})`);
    const frame = Buffer.concat([Buffer.from([STX]), Buffer.from(xml, 'utf8'), Buffer.from([ETX])]);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`délai dépassé (${type})`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(frame, (err) => {
        if (err && this.pending.has(id)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  _assertOk(xml, type) {
    const err = findError(xml);
    if (err) {
      // réponse brute (tronquée, mot de passe masqué) pour comprendre ce que dit la passerelle
      const raw = xml.replace(/pwd="[^"]*"/g, 'pwd="***"').replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(`${type} refusé (${err}) – réponse : ${raw}`);
    }
  }

  _onData(chunk) {
    this.rx = Buffer.concat([this.rx, chunk]);
    if (this.rx.length > MAX_RX_BYTES) {
      this.rx = Buffer.alloc(0);
      return;
    }
    for (;;) {
      const s = this.rx.indexOf(STX);
      if (s < 0) {
        this.rx = Buffer.alloc(0);
        return;
      }
      const e = this.rx.indexOf(ETX, s + 1);
      if (e < 0) {
        this.rx = this.rx.subarray(s);
        return;
      }
      const msg = this.rx.subarray(s + 1, e).toString('utf8');
      this.rx = this.rx.subarray(e + 1);
      this._onMessage(msg);
    }
  }

  // Une trame peut contenir plusieurs éléments (ex. <Response> suivi de <Event>).
  _onMessage(msg) {
    const re = /<(Response|Event)\b[\s\S]*?<\/\1>/g;
    let m;
    while ((m = re.exec(msg)) !== null) {
      const xml = m[0];
      if (m[1] === 'Response') {
        const id = /^<Response\s+id="(\d+)"/.exec(xml);
        const p = id && this.pending.get(id[1]);
        this.log.debug(`<- Response (id ${id ? id[1] : '?'})`);
        if (p) {
          clearTimeout(p.timer);
          this.pending.delete(id[1]);
          p.resolve(xml);
        }
      } else {
        const st = parseDeviceStatus(xml, this.deviceId);
        this.log.debug(`<- Event ${st ? JSON.stringify(st) : '(sans état)'}`);
        if (st) this.emit('event', st);
      }
    }
  }

  // ---- API haut niveau -------------------------------------------------

  /** @returns {Promise<{door: string, obstruct: boolean|null}>} */
  async getStatus() {
    const r = await this._send('STATUS', '');
    this._assertOk(r, 'STATUS');
    const st = parseDeviceStatus(r, this.deviceId);
    if (!st) throw new Error(`STATUS : équipement ${this.deviceId} introuvable dans la réponse`);
    return st;
  }

  /** @param {'open'|'close'|'stop'} action */
  async command(action) {
    if (!['open', 'close', 'stop'].includes(action)) throw new Error(`commande inconnue : ${action}`);
    const body =
      `<Devices><Device id="${this.deviceId}">\n` +
      `<Services><DoorAction>${action}</DoorAction>\n` +
      `</Services ></Device></Devices>`;
    const r = await this._send('CHANGE', body);
    this._assertOk(r, 'CHANGE');
  }

  /**
   * Création de l'utilisateur sur la passerelle. Renvoie le mot de passe d'appairage.
   * L'utilisateur doit ensuite être autorisé depuis l'application MyNice.
   */
  async pair(description = 'Homebridge') {
    this.close();
    await this._tlsConnect();
    try {
      const r = await this._send(
        'PAIR',
        `<Authentication username="${xmlEscape(this.username)}" cc="null" CType="phone" ` +
          `OSType="Android" OSVer="6.0.1" desc="${xmlEscape(description)}" />`,
        { sign: false }
      );
      this._assertOk(r, 'PAIR');
      const pwd = /\bpwd="([^"]+)"/.exec(r);
      if (!pwd) throw new Error('PAIR : mot de passe absent de la réponse');
      return pwd[1];
    } finally {
      this.close();
    }
  }
}

module.exports = { NiceClient, normalizeMac, parseDeviceStatus, normalizeDoorState };
