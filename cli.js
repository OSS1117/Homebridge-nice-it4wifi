#!/usr/bin/env node
'use strict';

const { NiceClient, normalizeMac } = require('./nice-client');
const { fetchAccessories, CloudError } = require('./nice-cloud');
const { Store } = require('./store');

const USAGE = `nice-it4wifi : outil de diagnostic et d'import des identifiants

Import des identifiants depuis votre compte MyNice (méthode recommandée) :
  nice-it4wifi cloud-import <e-mail MyNice> [--mac <MAC>] [--save <dossier Homebridge>]
      Le mot de passe du compte est demandé en saisie masquée ; il n'est pas conservé.

Avec les identifiants importés :
  nice-it4wifi check  <IP> [--mac <MAC>] [--save <dossier>]     lit l'état du portail
  nice-it4wifi watch  <IP> [--mac <MAC>] [--save <dossier>]     affiche les évènements en direct
  nice-it4wifi open|close|stop <IP> [--mac <MAC>] [--save <dossier>]   ⚠️ le portail bouge

Avancé (identifiants explicites) :
  nice-it4wifi pair   <IP> <MAC> <utilisateur> [description]
  nice-it4wifi status|open|close|stop|watch <IP> <MAC> <utilisateur> <motDePasse64hex> [idMoteur]

Le dossier par défaut est celui de Homebridge (/var/lib/homebridge ou ~/.homebridge).
DEBUG=1 affiche les trames échangées (sans secret).`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else pos.push(argv[i]);
  }
  return { pos, flags };
}

// Saisie sans écho (le mot de passe n'apparaît ni à l'écran ni dans l'historique du shell).
function promptHidden(label) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('un terminal interactif est nécessaire pour saisir le mot de passe'));
      return;
    }
    process.stdout.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let buf = '';
    const finish = (fn, value) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      fn(value);
    };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') return finish(resolve, buf);
        if (c === '\u0003') return finish(reject, new Error('annulé'));
        if (c === '\u007f' || c === '\b') buf = buf.slice(0, -1);
        else if (c >= ' ') buf += c;
      }
    };
    stdin.on('data', onData);
  });
}

function pickStored(store, mac) {
  const all = store.listImported();
  if (!all.length) {
    throw new Error(
      `aucun identifiant importé dans ${store.file}. Lancez d'abord : nice-it4wifi cloud-import <e-mail MyNice>`
    );
  }
  if (mac) {
    const m = normalizeMac(mac);
    const one = all.find((a) => a.mac === m);
    if (!one) throw new Error(`aucun identifiant importé pour ${m} (disponibles : ${all.map((a) => a.mac).join(', ')})`);
    return one;
  }
  if (all.length > 1) {
    throw new Error(`plusieurs passerelles importées, précisez --mac (${all.map((a) => a.mac).join(', ')})`);
  }
  return all[0];
}

async function cloudImport(email, flags) {
  if (!email) throw new Error('e-mail MyNice manquant\n\n' + USAGE);
  const password = await promptHidden(`Mot de passe MyNice de ${email} (saisie masquée) : `);
  console.log('Connexion au cloud MyNice…');
  const opts = process.env.NICE_CLOUD_URL ? { baseUrl: process.env.NICE_CLOUD_URL } : {};
  const found = await fetchAccessories(email, password, opts);

  console.log(`\nPasserelles trouvées sur ce compte : ${found.length}`);
  found.forEach((a, i) => console.log(`  ${i + 1}. ${a.name} — ${a.mac}`));

  let chosen;
  if (flags.mac) {
    const m = normalizeMac(flags.mac);
    chosen = found.find((a) => a.mac === m);
    if (!chosen) throw new Error(`${m} ne figure pas parmi les passerelles du compte`);
  } else if (found.length === 1) {
    chosen = found[0];
  } else {
    throw new Error('plusieurs passerelles : relancez avec --mac <adresse MAC> pour choisir');
  }

  const store = new Store(flags.save);
  store.setImported(chosen.mac, {
    name: chosen.name,
    username: chosen.username,
    password: chosen.password,
    source: chosen.source,
    importedAt: new Date().toISOString(),
  });
  console.log(`\nIdentifiants de « ${chosen.name} » (${chosen.mac}) enregistrés dans :`);
  console.log(`  ${store.file}   (lisible uniquement par son propriétaire ; rien n'est affiché à l'écran)\n`);
  console.log('Suite :');
  console.log('  1. Fermez complètement l\'app MyNice sur vos téléphones (une seule session à la fois).');
  console.log('  2. Dans la configuration du plugin : "host" = IP de l\'IT4WIFI,');
  console.log(`     "mac" = ${chosen.mac} ; laissez "username" et "password" vides.`);
  console.log('  3. Redémarrez Homebridge.');
  console.log('  Test sans Homebridge : nice-it4wifi check <IP>');
}

async function withClient(client, fn) {
  await client.open();
  try {
    await fn(client);
  } finally {
    client.close();
  }
}

async function run(cmd, client) {
  if (cmd === 'status' || cmd === 'check') {
    console.log(await client.getStatus());
  } else if (['open', 'close', 'stop'].includes(cmd)) {
    client.on('event', (st) => console.log('évènement :', st));
    await client.command(cmd);
    console.log(`Commande "${cmd}" envoyée.`);
    await new Promise((r) => setTimeout(r, 3000));
  } else if (cmd === 'watch') {
    console.log('état initial :', await client.getStatus());
    client.on('event', (st) => console.log(new Date().toISOString(), 'évènement :', st));
    client.on('close', () => {
      console.log('connexion fermée par la passerelle');
      process.exit(0);
    });
    await new Promise(() => {}); // jusqu'à Ctrl+C
  } else {
    throw new Error(`commande inconnue : ${cmd}\n\n${USAGE}`);
  }
}

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd, a1, a2, a3, a4, a5] = pos;
  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(USAGE);
    return;
  }
  const port = flags.port ? parseInt(flags.port, 10) : undefined;
  const debug = process.env.DEBUG ? (m) => console.error(`[debug] ${m}`) : () => {};
  const log = { debug };

  if (cmd === 'cloud-import') return cloudImport(a1, flags);

  if (cmd === 'pair') {
    if (!a1 || !a2 || !a3) throw new Error(USAGE);
    const pwd = await new NiceClient({ host: a1, port, mac: a2, username: a3, log }).pair(a4 || 'Homebridge');
    console.log(`Utilisateur "${a3}" créé, en attente d'approbation par un administrateur.`);
    console.log(`  password : ${pwd}`);
    return;
  }

  if (!a1) throw new Error(USAGE);

  // Forme explicite : <cmd> <IP> <MAC> <utilisateur> <mot de passe> [idMoteur]
  if (a2 && a3 && a4) {
    const client = new NiceClient({
      host: a1,
      port,
      mac: a2,
      username: a3,
      password: a4,
      deviceId: a5 ? parseInt(a5, 10) : 1,
      log,
    });
    return withClient(client, (c) => run(cmd, c));
  }

  // Forme simple : identifiants importés
  const rec = pickStored(new Store(flags.save), flags.mac || a2);
  const client = new NiceClient({
    host: a1,
    port,
    mac: rec.mac,
    username: rec.username,
    password: rec.password,
    source: rec.source,
    log,
  });
  return withClient(client, (c) => run(cmd, c));
}

main().catch((err) => {
  console.error(`Erreur : ${err instanceof CloudError ? `cloud MyNice : ${err.message}` : err.message}`);
  process.exit(1);
});
