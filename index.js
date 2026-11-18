'use strict';

const { NiceClient } = require('./nice-client');

const ACCESSORY_NAME = 'NiceRobus';
const MOVE_POLL_MS = 4000; // interrogation pendant un mouvement (l'évènement final peut manquer)
const MOVING_IDLE_S = 120; // mode "onDemand" : durée max de maintien de session pendant un mouvement

module.exports = (api) => {
  api.registerAccessory(ACCESSORY_NAME, NiceGate);
};

class NiceGate {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;

    const { Service, Characteristic } = api.hap;
    this.Service = Service;
    this.Characteristic = Characteristic;
    const C = Characteristic;

    this.name = config.name || 'Portail';
    this.mode = config.connectionMode === 'onDemand' ? 'onDemand' : 'persistent';
    this.pollInterval = Math.min(Math.max(Number(config.pollInterval) || 30, 10), 3600);
    this.idleCloseSeconds = Math.max(Number(config.idleCloseSeconds) || 5, 1);

    this.state = { door: 'closed', obstruct: false };
    this.online = false;
    this._queue = Promise.resolve();
    this._failures = 0;
    this._timers = { poll: null, move: null, idle: null, reconnect: null };

    // ---- services HomeKit ----
    this.info = new Service.AccessoryInformation()
      .setCharacteristic(C.Manufacturer, 'Nice')
      .setCharacteristic(C.Model, 'Robus 600HS (IT4WIFI)')
      .setCharacteristic(C.SerialNumber, String(config.mac || 'unknown'));

    this.garage = new Service.GarageDoorOpener(this.name);
    this.garage
      .getCharacteristic(C.CurrentDoorState)
      .onGet(() => this._read(() => this._hkCurrent()));
    this.garage
      .getCharacteristic(C.TargetDoorState)
      .onGet(() => this._read(() => this._hkTarget))
      .onSet((v) => this._setTarget(v));
    this.garage
      .getCharacteristic(C.ObstructionDetected)
      .onGet(() => this._read(() => this.state.obstruct));
    this._hkTarget = C.TargetDoorState.CLOSED;

    this.services = [this.info, this.garage];

    if (config.exposeStopSwitch !== false) {
      this.stopSwitch = new Service.Switch(`${this.name} Stop`, 'stop');
      this.stopSwitch
        .getCharacteristic(C.On)
        .onGet(() => false)
        .onSet((v) => this._onStopSwitch(v));
      this.services.push(this.stopSwitch);
    }

    // ---- client Nice ----
    const missing = ['host', 'mac', 'username', 'password'].filter((k) => !config[k]);
    if (missing.length) {
      this.log.error(`Configuration incomplète, champs manquants : ${missing.join(', ')}`);
      return;
    }
    try {
      this.client = new NiceClient({
        host: config.host,
        port: config.port,
        mac: config.mac,
        username: config.username,
        password: config.password,
        source: config.source,
        deviceId: config.deviceId,
        log: this.log,
      });
    } catch (err) {
      this.log.error(`Configuration invalide : ${err.message}`);
      return;
    }

    this.client.on('event', (st) => this._apply(st));
    this.client.on('close', () => {
      this.log.warn('Connexion à l’IT4WIFI perdue');
      if (this.mode === 'persistent') this._markOffline(new Error('connexion perdue'));
    });

    api.on('didFinishLaunching', () => this._start());
    api.on('shutdown', () => this._stop());
  }

  getServices() {
    return this.services;
  }

  // ---- cycle de vie ------------------------------------------------------

  _start() {
    this.log.info(
      `Démarrage (${this.mode === 'persistent' ? 'connexion permanente' : 'connexion à la demande'}, ` +
        `interrogation toutes les ${this.pollInterval}s)`
    );
    this._refresh();
    this._timers.poll = setInterval(() => {
      if (!this._timers.reconnect) this._refresh();
    }, this.pollInterval * 1000);
  }

  _stop() {
    this._stopped = true;
    for (const k of Object.keys(this._timers)) {
      clearTimeout(this._timers[k]);
      clearInterval(this._timers[k]);
      this._timers[k] = null;
    }
    if (this.client) this.client.close();
  }

  // ---- accès à la passerelle --------------------------------------------

  _exclusive(fn) {
    const p = this._queue.then(() => fn());
    this._queue = p.catch(() => {});
    return p;
  }

  // Ouvre la session si besoin, exécute fn, une relance après échec.
  _op(fn) {
    return this._exclusive(async () => {
      if (this._stopped) throw new Error('plugin arrêté');
      let lastErr;
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (!this.client.isOpen) await this.client.open();
            return await fn();
          } catch (err) {
            lastErr = err;
            this.client.close();
          }
        }
        throw lastErr;
      } finally {
        this._armIdle();
      }
    });
  }

  async _refresh() {
    if (!this.client || this._stopped) return;
    try {
      const st = await this._op(() => this.client.getStatus());
      this._markOnline();
      this._apply(st);
    } catch (err) {
      this._markOffline(err);
    }
  }

  _markOnline() {
    if (!this.online) this.log.info('IT4WIFI joignable');
    this.online = true;
    this._failures = 0;
  }

  _markOffline(err) {
    if (this.online) this.log.warn(`IT4WIFI injoignable : ${err.message}`);
    else this.log.debug(`IT4WIFI injoignable : ${err.message}`);
    this.online = false;
    if (this.mode === 'persistent' && !this._timers.reconnect && !this._stopped) {
      const delay = Math.min(5000 * 2 ** this._failures, 60000);
      this._failures += 1;
      this._timers.reconnect = setTimeout(() => {
        this._timers.reconnect = null;
        this._refresh();
      }, delay);
    }
  }

  // Mode "onDemand" : on referme la session quand plus rien ne se passe.
  _armIdle() {
    if (this.mode !== 'onDemand') return;
    clearTimeout(this._timers.idle);
    const moving = this.state.door === 'opening' || this.state.door === 'closing';
    this._timers.idle = setTimeout(
      () => this._exclusive(async () => this.client.close()),
      (moving ? MOVING_IDLE_S : this.idleCloseSeconds) * 1000
    );
  }

  // ---- état HomeKit -------------------------------------------------------

  _hkCurrent() {
    const C = this.Characteristic.CurrentDoorState;
    return {
      open: C.OPEN,
      closed: C.CLOSED,
      opening: C.OPENING,
      closing: C.CLOSING,
      stopped: C.STOPPED,
    }[this.state.door];
  }

  _read(getter) {
    if (!this.online) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return getter();
  }

  _apply({ door, obstruct }) {
    const C = this.Characteristic;
    if (door) {
      if (door !== this.state.door) this.log.info(`État du portail : ${door}`);
      this.state.door = door;
      this.garage.updateCharacteristic(C.CurrentDoorState, this._hkCurrent());

      if (door === 'open' || door === 'opening') this._hkTarget = C.TargetDoorState.OPEN;
      else if (door === 'closed' || door === 'closing') this._hkTarget = C.TargetDoorState.CLOSED;
      this.garage.updateCharacteristic(C.TargetDoorState, this._hkTarget);

      this._updateMovePoll(door === 'opening' || door === 'closing');
    }
    if (obstruct !== null && obstruct !== undefined) {
      this.state.obstruct = obstruct;
      this.garage.updateCharacteristic(C.ObstructionDetected, obstruct);
    }
    this._armIdle();
  }

  _updateMovePoll(moving) {
    if (moving && !this._timers.move) {
      this._timers.move = setInterval(() => this._refresh(), MOVE_POLL_MS);
    } else if (!moving && this._timers.move) {
      clearInterval(this._timers.move);
      this._timers.move = null;
    }
  }

  // ---- commandes -----------------------------------------------------------

  async _send(action) {
    if (!this.client) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    this.log.info(`Commande : ${action}`);
    try {
      await this._op(() => this.client.command(action));
      this._markOnline();
    } catch (err) {
      this.log.error(`Échec de la commande "${action}" : ${err.message}`);
      this._markOffline(err);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    setTimeout(() => this._refresh(), 1500); // filet de sécurité si l'évènement est manqué
  }

  async _setTarget(value) {
    const T = this.Characteristic.TargetDoorState;
    this._hkTarget = value;
    await this._send(value === T.OPEN ? 'open' : 'close');
  }

  async _onStopSwitch(on) {
    if (!on) return;
    const C = this.Characteristic;
    try {
      await this._send('stop');
    } finally {
      setTimeout(() => this.stopSwitch.updateCharacteristic(C.On, false), 1000);
    }
  }
}
