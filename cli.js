#!/usr/bin/env node
'use strict';

const { NiceClient } = require('./nice-client');

const USAGE = `Usage :
  nice-it4wifi pair   <ip> <mac> <utilisateur> [description]
  nice-it4wifi status <ip> <mac> <utilisateur> <motDePasse> [idMoteur]
  nice-it4wifi open|close|stop <ip> <mac> <utilisateur> <motDePasse> [idMoteur]
  nice-it4wifi watch  <ip> <mac> <utilisateur> <motDePasse> [idMoteur]   (affiche les évènements)`;

async function main() {
  const [cmd, host, mac, username, arg5, arg6] = process.argv.slice(2);
  if (!cmd || !host || !mac || !username) {
    console.log(USAGE);
    process.exit(1);
  }
  const debug = process.env.DEBUG ? (m) => console.error(`[debug] ${m}`) : () => {};
  const log = { debug };

  if (cmd === 'pair') {
    const client = new NiceClient({ host, mac, username, log });
    const pwd = await client.pair(arg5 || 'Homebridge');
    console.log(`Utilisateur "${username}" créé.\n`);
    console.log(`  password : ${pwd}\n`);
    console.log('Étapes suivantes :');
    console.log('  1. Ouvrir l\'app MyNice (compte administrateur) > gestion des utilisateurs,');
    console.log(`     et AUTORISER l'utilisateur "${username}".`);
    console.log('  2. Copier le mot de passe ci-dessus dans la configuration du plugin.');
    return;
  }

  if (!arg5) {
    console.log(USAGE);
    process.exit(1);
  }
  const client = new NiceClient({
    host,
    mac,
    username,
    password: arg5,
    deviceId: arg6 ? parseInt(arg6, 10) : 1,
    log,
  });
  await client.open();
  try {
    if (cmd === 'status') {
      console.log(await client.getStatus());
    } else if (['open', 'close', 'stop'].includes(cmd)) {
      await client.command(cmd);
      console.log(`Commande "${cmd}" envoyée.`);
      client.on('event', (st) => console.log('évènement :', st));
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
      console.log(USAGE);
      process.exit(1);
    }
  } finally {
    client.close();
  }
}

main().catch((err) => {
  console.error(`Erreur : ${err.message}`);
  process.exit(1);
});
