# homebridge-nice-it4wifi

Plugin Homebridge pour un portail **Nice Robus** (ex. Robus 600HS) piloté par l'interface réseau **IT4WIFI** et l'app **MyNice**.

Fonctions : **ouvrir / arrêter / fermer** le portail et **retour d'état** (ouvert, fermé, en ouverture, en fermeture, arrêté, obstacle).

Dans l'app Maison, le portail apparaît comme une porte de garage. HomeKit n'a pas de commande « stop » : le plugin ajoute donc un interrupteur **« Portail Stop »** (désactivable).

> ⚠️ **Non officiel, et testé uniquement contre une passerelle simulée.** Le protocole (« NHK » : TLS sur le port 443, XML signé SHA-256) est connu par la rétro-ingénierie de la communauté ([intégration Home Assistant IT4WIFI](https://github.com/valdaaak/nice-it4wifi-ha), [binding openHAB MyNice](https://www.openhab.org/addons/bindings/mynice)). Il n'est pas garanti sur toutes les versions de firmware. Plugin non affilié à Nice S.p.A.

## Prérequis

- Un IT4WIFI configuré en technologie **MyNice** (il écoute sur le port 443). Les accessoires configurés en HomeKit natif n'ont pas besoin de ce plugin.
- Un **compte MyNice** qui contrôle déjà le portail. Il est conseillé d'en créer un dédié à Homebridge (invitation d'un second utilisateur dans l'app).
- Node ≥ 18, Homebridge ≥ 1.8. Aucune dépendance.

## 1. Installation

Sur la machine de Homebridge (sans `sudo` si le compte `homebridge` ne l'autorise pas) :

```bash
cd /var/lib/homebridge
npm install --prefix /var/lib/homebridge github:OSS1117/Homebridge-nice-it4wifi#main
```

(Installation globale classique : `npm install -g github:OSS1117/Homebridge-nice-it4wifi#main`. Le plugin doit se trouver dans le dossier où Homebridge cherche ses plugins, `/var/lib/homebridge/node_modules` avec `hb-service`.)

## 2. Importer les identifiants de la passerelle (une seule fois)

L'IT4WIFI n'utilise pas l'e-mail et le mot de passe de votre compte MyNice, mais des identifiants propres, stockés par le cloud MyNice. La commande suivante les récupère, comme le fait l'intégration Home Assistant :

```bash
node /var/lib/homebridge/node_modules/homebridge-nice-it4wifi/cli.js cloud-import votre-email@exemple.org
```

(ou simplement `nice-it4wifi cloud-import votre-email@exemple.org` si la commande est dans votre `PATH`.)

- Le mot de passe de votre compte est demandé en **saisie masquée** : il n'est ni affiché, ni enregistré, ni mis dans l'historique du shell. Il est envoyé uniquement au cloud MyNice, en HTTPS, pour cette requête.
- Rien de secret n'est affiché. Les identifiants de la passerelle sont écrits dans `homebridge-nice-it4wifi.json`, dans le dossier de Homebridge, lisible uniquement par son propriétaire. Ils ne passent jamais par `config.json`.
- Si le compte a plusieurs passerelles, ajoutez `--mac <adresse MAC>`.
- ⚠️ Cette étape utilise l'accès du cloud MyNice tel que le fait l'app Android (identifiant client public de l'app). Elle est non officielle et Nice peut la modifier.

Vérifiez ensuite, **app MyNice fermée** sur tous les téléphones :

```bash
node /var/lib/homebridge/node_modules/homebridge-nice-it4wifi/cli.js check 192.168.1.50
```

Elle doit afficher l'état du portail (`door: 'closed'`, etc.). `--port`, `--mac` et `--save <dossier>` permettent de préciser le cas échéant.

## 3. Configuration Homebridge

Dans l'interface Homebridge (Plugins → Nice IT4WIFI → Paramètres) : le **nom**, l'**IP** et la **MAC** de l'IT4WIFI (liste des appareils de votre box). Laissez le nom d'utilisateur et le mot de passe **vides**.

Ou dans `config.json` :

```json
{
  "accessories": [
    {
      "accessory": "NiceRobus",
      "name": "Portail",
      "host": "192.168.1.50",
      "mac": "AA:BB:CC:11:22:33"
    }
  ]
}
```

Redémarrez Homebridge. Le journal doit indiquer `identifiants : import MyNice`, puis `IT4WIFI joignable`.

## Options

| Option | Défaut | Rôle |
|---|---|---|
| `connectionMode` | `onDemand` | `onDemand` : la session n'est ouverte que pour une commande ou une interrogation (l'app MyNice reste utilisable). `persistent` : session permanente, état instantané, mais l'app MyNice ne peut plus se connecter. |
| `pollInterval` | 30 | Secondes entre deux interrogations d'état (10–3600) |
| `exposeStopSwitch` | true | Interrupteur « Stop » |
| `deviceId` | 1 | Identifiant du moteur sur le bus T4 |
| `idleCloseSeconds` | 5 | Mode `onDemand` : fermeture de la session après inactivité |
| `username`, `password` | vides | Avancé. `password` = mot de passe de 64 caractères hexadécimaux de la passerelle (pas celui du compte MyNice) ; il l'emporte sur l'import. Sans `password` ni import, le plugin tente un appairage automatique (voir plus bas). |
| `port`, `source` | 443, auto | Avancé |

## Alternative : appairage automatique

Sans identifiants importés, le plugin crée lui-même un utilisateur sur l'IT4WIFI. Cet utilisateur reste **« en attente »** (la passerelle répond *code 1*) tant qu'un **administrateur** ne l'a pas approuvé. D'après la documentation du protocole, cette approbation exige une session administrateur ; je n'ai pas pu vérifier où l'app MyNice la propose. L'import ci-dessus évite cette étape.

## Limites connues

- **Une seule session à la fois.** L'IT4WIFI n'accepte qu'un client connecté ; s'il est occupé, il coupe la connexion avant même le TLS (le journal indique « la passerelle a coupé la connexion avant le chiffrement TLS »). Fermez complètement l'app MyNice, attendez quelques minutes.
- **Pas de « stop » natif dans HomeKit** : utilisez l'interrupteur Stop.
- **Obstacle** : remonté à HomeKit s'il est signalé par la passerelle.
- Les identifiants importés peuvent devenir périmés (utilisateur supprimé dans MyNice, réinitialisation de la passerelle) : relancez `cloud-import`.

## Dépannage

- `la passerelle a coupé la connexion avant le chiffrement TLS` : une autre session est ouverte (app MyNice, Home Assistant…). Sinon, coupez puis remettez l'alimentation de l'IT4WIFI.
- `VERIFY refusé` ou `CONNECT refusé` (avec la réponse brute de la passerelle) : utilisateur inconnu ou en attente. Relancez `cloud-import`.
- `e-mail ou mot de passe MyNice refusés` : le compte n'est pas confirmé, ou le mot de passe est faux.
- Journaux détaillés : lancer Homebridge avec `-D`.

## Principe du protocole

TLS (certificat auto-signé, options TLS anciennes) → `VERIFY` → `CONNECT` (échange de défis CC/SC) → requêtes `STATUS` / `CHANGE` signées avec `base64(sha256(sha256(xml) ‖ sha256(pwd ‖ rev(SC) ‖ rev(CC))))`. Commandes : `DoorAction` = `open` / `close` / `stop`. Sources : [protocole NHK documenté](https://github.com/valdaaak/nice-it4wifi-ha/blob/main/docs/PROTOCOL.md), [fil openHAB](https://community.openhab.org/t/nice-garage-door-binding-request/54593).
