# homebridge-nice-it4wifi

Plugin Homebridge pour un portail **Nice Robus** (ex. Robus 600HS) piloté par l'interface réseau **IT4WIFI** et l'app **MyNice**.

Fonctions : **ouvrir / arrêter / fermer** le portail et **retour d'état** (ouvert, fermé, en ouverture, en fermeture, arrêté, obstacle).

Dans l'app Maison, le portail apparaît comme une porte de garage. HomeKit ne connaît pas la commande « stop » : le plugin ajoute donc un interrupteur **« Portail Stop »** (désactivable).

> ⚠️ **Statut : non testé sur du matériel réel.** Le protocole (« NHK », TLS 443, XML signé SHA-256) vient de la rétro-ingénierie publiée par la communauté (openHAB, intégration Home Assistant IT4WIFI). Le code a été validé contre une passerelle simulée écrite d'après cette spécification, pas contre votre IT4WIFI. Commencez par `nice-it4wifi status` (ci-dessous) avant de l'ajouter à Homebridge.

## Installation

Depuis GitHub, sur la machine qui fait tourner Homebridge (sans `sudo` si le compte `homebridge` ne l'autorise pas) :

```bash
npm install -g github:OSS1117/Homebridge-nice-it4wifi#main
```

Aucune dépendance. Node ≥ 18, Homebridge ≥ 1.8. Redémarrer Homebridge ensuite.

## Configuration (interface Homebridge)

Plugins → **Nice IT4WIFI (Robus)** → Paramètres : renseigner le nom, l'**IP** et la **MAC** de l'IT4WIFI (liste des appareils de votre box ; les MAC Nice commencent par `00:0B:6C`), puis laisser le nom d'utilisateur par défaut (`homebridge`). Le mot de passe se laisse **vide**.

Ou dans `config.json` :

```json
{
  "accessories": [
    {
      "accessory": "NiceRobus",
      "name": "Portail",
      "host": "192.168.1.50",
      "mac": "00:0B:6C:11:22:33",
      "username": "homebridge"
    }
  ]
}
```

## Premier démarrage : appairage automatique

1. Au démarrage, le plugin crée l'utilisateur sur l'IT4WIFI et enregistre le mot de passe dans le dossier de Homebridge (`homebridge-nice-it4wifi.json`, lisible uniquement par le compte Homebridge). Les logs affichent : « Utilisateur "homebridge" créé. Autorisez-le dans l'app MyNice… ».
2. Dans l'app **MyNice** (compte administrateur), gestion des utilisateurs : **autoriser** `homebridge`. Une seule fois.
3. Le plugin se connecte tout seul (nouvelle tentative toutes les 5 à 60 s), sans redémarrage. Le portail apparaît ensuite dans l'app Maison.

Si l'utilisateur existe déjà sur la passerelle mais que le mot de passe est perdu, changez `username` (ou renseignez `password`). L'ancien utilisateur se supprime dans MyNice.

## Outil en ligne de commande (optionnel, diagnostic)

```bash
nice-it4wifi status <IP> <MAC> <utilisateur> <motDePasse>
nice-it4wifi watch  <IP> <MAC> <utilisateur> <motDePasse>   # évènements en direct
DEBUG=1 nice-it4wifi status ...                              # trames échangées
```

Le mot de passe enregistré par le plugin se trouve dans `homebridge-nice-it4wifi.json` (dossier de stockage Homebridge). Les valeurs `<IP>`, `<MAC>`… sont à remplacer, sans les chevrons.

## Options

| Option | Défaut | Rôle |
|---|---|---|
| `password` | vide | Mot de passe d'appairage ; vide = géré automatiquement |
| `connectionMode` | `persistent` | `persistent` : session permanente, état instantané. `onDemand` : session ouverte seulement pour une commande ou une interrogation. |
| `pollInterval` | 30 | Secondes entre deux interrogations d'état (10–3600) |
| `exposeStopSwitch` | true | Interrupteur « Stop » |
| `deviceId` | 1 | Identifiant du moteur sur le bus T4 |
| `idleCloseSeconds` | 5 | Mode `onDemand` : fermeture de la session après inactivité |
| `port`, `source` | 443, auto | Avancé |

## Limites connues

- **Une seule session à la fois.** D'après les retours de la communauté, l'IT4WIFI n'accepte qu'un client connecté. En mode `persistent`, l'app MyNice peut ne plus se connecter tant que Homebridge est actif. Si vous utilisez encore MyNice, passez en `onDemand` (l'état externe, par exemple une télécommande, n'est alors vu qu'à l'interrogation suivante).
- **Pas de « stop » natif dans HomeKit** : utilisez l'interrupteur Stop. Quand le portail est arrêté, un appui sur Ouvrir ou Fermer le relance dans le sens voulu.
- **Obstacle** : remonté à HomeKit s'il est signalé par la passerelle.
- Les codes d'erreur renvoyés par la passerelle ne sont pas documentés ; ils sont affichés tels quels dans les logs.
- Plugin non affilié à Nice S.p.A.

## Dépannage

- `utilisateur inconnu de la passerelle` : refaire l'appairage.
- `CONNECT : challenge serveur absent` : l'utilisateur n'est pas encore autorisé dans MyNice.
- Erreur TLS / `socket closed` : l'IT4WIFI refuse peut-être une session parce que MyNice est connectée ; fermez l'app et réessayez.
- Logs détaillés : lancer Homebridge avec `-D`.

## Principe du protocole

TLS (certificat auto-signé, options TLS anciennes) → `VERIFY` → `CONNECT` (échange de challenges CC/SC) → requêtes `STATUS` / `CHANGE` signées avec `base64(sha256(sha256(xml) ‖ sha256(pwd ‖ rev(SC) ‖ rev(CC))))`. Commandes : `DoorAction` = `open` / `close` / `stop`. Sources : [fil openHAB « Nice Garage Door Binding request »](https://community.openhab.org/t/nice-garage-door-binding-request/54593), [binding openHAB MyNice](https://www.openhab.org/addons/bindings/mynice), [intégration Home Assistant IT4WIFI](https://github.com/valdaaak/nice-it4wifi-ha).
