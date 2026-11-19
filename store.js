'use strict';

/**
 * Fichier de stockage du plugin, dans le dossier de Homebridge
 * (homebridge-nice-it4wifi.json, lisible uniquement par son propriétaire).
 *
 *  - "<MAC>|<utilisateur>" : "<mot de passe>"      utilisateur créé par l'appairage automatique
 *  - "imported:<MAC>"      : { username, password, source, name }   importé du compte MyNice
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const FILE = 'homebridge-nice-it4wifi.json';

/** Dossier par défaut quand on n'est pas dans Homebridge (ligne de commande). */
function defaultDir() {
  if (process.env.HOMEBRIDGE_STORAGE) return process.env.HOMEBRIDGE_STORAGE;
  try {
    if (fs.statSync('/var/lib/homebridge').isDirectory()) return '/var/lib/homebridge';
  } catch (err) {
    /* pas un hb-service */
  }
  return path.join(os.homedir(), '.homebridge');
}

class Store {
  constructor(dir) {
    this.file = path.join(dir || defaultDir(), FILE);
  }

  _read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (err) {
      return {};
    }
  }

  _write(all) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  getPaired(key) {
    const v = this._read()[key];
    return typeof v === 'string' ? v : null;
  }

  setPaired(key, password) {
    const all = this._read();
    all[key] = password;
    this._write(all);
  }

  getImported(mac) {
    const v = this._read()[`imported:${mac}`];
    return v && typeof v === 'object' && v.username && v.password && v.source ? v : null;
  }

  listImported() {
    return Object.entries(this._read())
      .filter(([k, v]) => k.startsWith('imported:') && v && typeof v === 'object')
      .map(([k, v]) => ({ mac: k.slice('imported:'.length), ...v }));
  }

  setImported(mac, record) {
    const all = this._read();
    all[`imported:${mac}`] = record;
    this._write(all);
  }
}

module.exports = { Store, FILE };
