# homebridge-nice-it4wifi

Plugin Homebridge pour un portail **Nice Robus** (ex. Robus 600HS) piloté par l'interface réseau **IT4WIFI** et l'app **MyNice**.

Fonctions : **ouvrir / arrêter / fermer** le portail et **retour d'état** (ouvert, fermé, en ouverture, en fermeture, arrêté, obstacle).

Dans l'app Maison, le portail apparaît comme une porte de garage. HomeKit ne connaît pas la commande « stop » : le plugin ajoute donc un interrupteur **« Portail Stop »** (désactivable).

> ⚠️ **Statut : non testé sur du matériel réel.** Le protocole (« NHK », TLS 443, XML signé SHA-256) vient de la rétro-ingénierie publiée par la communauté (openHAB, intégration Home Assistant IT4WIFI). Le code a été validé contre une passerelle simulée écrite d'après cette spécification, pas contre votre IT4WIFI. Commencez par `nice-it4wifi status` (ci-dessous) avant de l'ajouter à Homebridge.

## Installation

```bash
# depuis l'archive fournie
sudo npm install -g ./homebridge-nice-it4wifi-0.1.0.tgz
```

Aucune dépendance. Node ≥ 18, Homebridge ≥ 1.8.

## 1. Appairage (une seule fois)

Il faut créer un utilisateur sur la passerelle, puis l'autoriser depuis MyNice.

```bash
nice-it4wifi pair <IP_IT4WIFI> <MAC_IT4WIFI> homebridge
```

La commande affiche un `password`. Ensuite, dans l'app **MyNice** (compte administrateur) : gestion des utilisateurs → **autoriser** l'utilisateur `homebridge`.

La MAC est celle de l'IT4WIFI (étiquette de l'appareil ou liste des clients de votre box), par ex. `00:0B:6C:11:22:33`.

## 2. Test sans Homebridge

```bash
nice-it4wifi status <IP> <MAC> homebridge <password>
nice-it4wifi watch  <IP> <MAC> homebridge <password>    # affiche les évènements en direct
nice-it4wifi open   <IP> <MAC> homebridge <password>    # ⚠️ le portail bouge vraiment
DEBUG=1 nice-it4wifi status ...                          # trames échangées
```

## 3. Configuration Homebridge

Via l'interface Homebridge UI, ou dans `config.json` :

```json
{
  "accessories": [
    {
      "accessory": "NiceRobus",
      "name": "Portail",
      "host": "192.168.1.50",
      "mac": "00:0B:6C:11:22:33",
      "username": "homebridge",
      "password": "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx=",
      "connectionMode": "persistent"
    }
  ]
}
```

| Option | Défaut | Rôle |
|---|---|---|
| `connectionMode` | `persistent` | `persistent` : session ouverte en permanence, état instantané (évènements). `onDemand` : session ouverte seulement pour une commande ou une interrogation. |
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
