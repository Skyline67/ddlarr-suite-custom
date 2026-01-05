# DDL Torznab

Indexeur Torznab pour sites DDL (Direct Download Links), compatible avec Prowlarr, Sonarr et Radarr.

## Quick Install (Docker)

```bash
# 1. Download docker-compose and .env files
curl -O https://raw.githubusercontent.com/z-m-g/ddlarr-suite/main/docker-compose.prod.yml
curl -O https://raw.githubusercontent.com/z-m-g/ddlarr-suite/main/.env.example
mv .env.example .env

# 2. Edit .env with your settings (debrid API key, site URLs, etc.)
nano .env

# 3. Create download directories
mkdir -p downloads downloads-temp

# 4. Start services
docker compose -f docker-compose.prod.yml up -d
```

**Access:**
- Torznab Indexer: `http://localhost:9117`
- qBittorrent UI: `http://localhost:8080` (admin/adminadmin)

**Configure in Radarr/Sonarr:**
1. Add Indexer: Settings > Indexers > Torznab > URL: `http://<IP>:9117/api/wawacity/`
2. Add Download Client: Settings > Download Clients > qBittorrent > Host: `<IP>`, Port: `8080`

## Soutien
☕ Après minuit, je code. Je bois du café — pas d’eau (c’est dangereux pour les gremlins).  
<a href="https://www.buymeacoffee.com/z.m.g"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me a Coffee" height="40"></a>


## Architecture

Le projet se compose de plusieurs services Docker. Deux approches sont possibles :

### Option A : DDL-qBittorrent (Recommandé)

| Service | Port par défaut | Description |
|---------|-----------------|-------------|
| **ddl-torznab** | 9117 | Indexeur Torznab qui scrape les sites DDL |
| **dlprotect-resolver** | 5000 | Service Botasaurus pour résoudre les liens dl-protect |
| **ddl-qbittorrent** | 8080 | Simule un client qBittorrent pour Sonarr/Radarr |

Cette approche simule un vrai client qBittorrent. Sonarr/Radarr communiquent directement avec ddl-qbittorrent comme s'il s'agissait d'un vrai client torrent.

**Supporte les vrais torrents !** En plus des fake torrents DDL, ddl-qbittorrent peut recevoir de vrais fichiers .torrent et les envoyer automatiquement aux services de debrid (AllDebrid, RealDebrid, Premiumize) pour telechargement.

### Option B : Blackhole + Client externe

| Service | Port par défaut | Description |
|---------|-----------------|-------------|
| **ddl-torznab** | 9117 | Indexeur Torznab qui scrape les sites DDL |
| **dlprotect-resolver** | 5000 | Service Botasaurus pour résoudre les liens dl-protect |
| **ddl-downloader** | 9118 | Surveille un dossier blackhole et envoie les liens aux clients de téléchargement |

Cette approche utilise un dossier blackhole et un client de téléchargement externe (JDownloader, aria2, Download Station).

> Les ports sont configurables via les variables d'environnement

## Sites supportés

| Site | Variable ENV | Telegram | Description |
|------|--------------|----------|-------------|
| WawaCity | `WAWACITY_URL` | [@Wawacityofficiel](https://t.me/s/Wawacityofficiel) | Scraping HTML |
| Zone-Téléchargement | `ZONETELECHARGER_URL` | [@ztofficiel](https://t.me/s/ztofficiel) | Scraping HTML |

> **Auto-détection des URLs** : Si les variables `WAWACITY_URL` ou `ZONETELECHARGER_URL` sont vides, les URLs sont automatiquement récupérées depuis les canaux Telegram officiels.

## Installation

### 1. Cloner le repository

```bash
git clone https://github.com/votre-repo/ddl_torznab.git
cd ddl_torznab
```

### 2. Configurer les variables d'environnement

```bash
cp .env.example .env
```

Éditer le fichier `.env` :

```bash
# URLs des sites (optionnel - auto-détection depuis Telegram si vide)
# Laissez vide pour utiliser l'auto-détection, ou forcez une URL spécifique
WAWACITY_URL=
ZONETELECHARGER_URL=

# Chemin du dossier blackhole (requis pour le downloader)
BLACKHOLE_PATH=/chemin/vers/blackhole

# Clé API AllDebrid (optionnel mais recommandé)
ALLDEBRID_API_KEY=votre_cle_api
```

> **Note** : Les URLs des sites changent régulièrement. L'auto-détection depuis Telegram permet de toujours avoir les URLs à jour sans modifier la configuration.

### 3. Lancer les services

Choisir une des deux options :

**Option A - DDL-qBittorrent (Recommandé) :**
```bash
docker compose --profile qbittorrent up -d
```

**Option B - Blackhole + Client externe :**
```bash
docker compose --profile blackhole up -d
```

> **Note** : `docker compose up -d` (sans profil) ne démarre que les services de base (indexeur + résolveur). Vous devez spécifier un profil pour avoir un système de téléchargement complet.

### 4. Arrêter les services

Pour arrêter tous les services (incluant tous les profils) :

```bash
docker compose --profile qbittorrent --profile blackhole down
```

## Configuration avec DDL-qBittorrent (Option A - Recommandé)

### Lancer les services

```bash
docker compose --profile qbittorrent up -d
```

> Cette commande démarre uniquement : `ddl-torznab`, `dlprotect-resolver` et `ddl-qbittorrent`

### Configuration de Radarr/Sonarr

#### Étape 1 : Ajouter l'indexeur Torznab

1. Aller dans **Settings > Indexers > Add**
2. Choisir **Torznab**
3. Configurer :
   - **Name** : DDL Wawacity (ou ZoneTelecharger)
   - **URL** : `http://<IP>:9117/api/wawacity/` (ou `zonetelecharger`)
   - **API Key** : `ddl-torznab` (n'importe quelle valeur)
   - **Categories** : 2000, 2040, 2045 (Radarr) ou 5000, 5040, 5045 (Sonarr)
4. Cliquer sur **Test** puis **Save**

#### Étape 2 : Configurer DDL-qBittorrent comme Download Client

1. Aller dans **Settings > Download Clients > Add**
2. Choisir **qBittorrent**
3. Configurer :
   - **Name** : DDL-qBittorrent
   - **Host** : `<IP>` (IP du serveur ddl-qbittorrent)
   - **Port** : `8080` (ou votre valeur de `QBITTORRENT_PORT`)
   - **Username** : `admin` (ou votre valeur de `QB_USERNAME`)
   - **Password** : `adminadmin` (ou votre valeur de `QB_PASSWORD`)
   - **Category** : `radarr` ou `sonarr` (optionnel)
4. Cliquer sur **Test** puis **Save**

> **Mappages de chemins distants** : Si Sonarr/Radarr et ddl-qbittorrent ne partagent pas le même système de fichiers, configurez les "Remote Path Mappings" dans Settings > Download Clients. Par exemple, si ddl-qbittorrent télécharge dans `/downloads` mais que Sonarr voit ce dossier comme `/mnt/downloads`, ajoutez un mapping : Host=`<IP ddl-qbittorrent>`, Remote Path=`/downloads`, Local Path=`/mnt/downloads`.

> **Interface Web** : Accessible sur `http://<IP>:<QBITTORRENT_PORT>/` pour voir l'état des téléchargements (port 8080 par défaut)

### Variables d'environnement DDL-qBittorrent

| Variable | Description | Défaut |
|----------|-------------|--------|
| `QBITTORRENT_PORT` | Port du service | 8080 |
| `QB_USERNAME` | Nom d'utilisateur | admin |
| `QB_PASSWORD` | Mot de passe | adminadmin |
| `DOWNLOAD_PATH` | Dossier de destination des téléchargements | /downloads |
| `TEMP_PATH` | Dossier temporaire pour les téléchargements en cours | /downloads-temp |
| `MAX_CONCURRENT_DOWNLOADS` | Nombre de téléchargements simultanés | 3 |
| `AUTO_EXTRACT_ARCHIVE` | Extraire automatiquement les archives (zip, rar, 7z) | 1 (activé) |
| `AUTO_REMOVE_COMPLETED_AFTER` | Supprimer les téléchargements terminés après X minutes (0 = désactivé) | 0 |
| `ALLDEBRID_ENABLED` | Activer AllDebrid | false |
| `ALLDEBRID_API_KEY` | Clé API AllDebrid | - |
| `REALDEBRID_ENABLED` | Activer RealDebrid | false |
| `REALDEBRID_API_KEY` | Clé API RealDebrid | - |
| `PREMIUMIZE_ENABLED` | Activer Premiumize | false |
| `PREMIUMIZE_API_KEY` | Clé API Premiumize | - |
| `DEBRID_TORRENT_TIMEOUT` | Timeout pour le debrid de vrais torrents (heures) | 24 |

### Support des vrais torrents

DDL-qBittorrent detecte automatiquement le type de torrent recu :
- **Fake torrent DDL** (cree par ddl-torznab) : Le lien DDL est extrait et debride normalement
- **Vrai torrent** : Le fichier .torrent est envoye au service de debrid qui le telecharge

#### Comment ca marche

1. Sonarr/Radarr envoie un fichier .torrent a ddl-qbittorrent
2. DDL-qBittorrent analyse le torrent :
   - Si `created by: DDL-Torznab` → traitement DDL classique
   - Sinon → envoi au service de debrid
3. Pour les vrais torrents :
   - Upload du .torrent vers AllDebrid/RealDebrid/Premiumize
   - Attente que le debrid telecharge le torrent (peut prendre du temps si pas en cache)
   - Telechargement des fichiers depuis le debrid

#### Messages de statut

- `Uploading torrent to debrid...` - Envoi du torrent au service
- `Queued on AllDebrid...` - En attente dans la file du debrid
- `Downloading on debrid: 45%` - Le debrid telecharge le torrent
- `Downloading from debrid...` - Telechargement des fichiers depuis le debrid

> **Note** : Les vrais torrents non caches peuvent prendre du temps (le debrid doit telecharger depuis les seeders). Le timeout par defaut est de 24 heures.

### Flux de téléchargement (Option A)

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│ Radarr/     │────>│ ddl-torznab  │────>│ Site DDL        │
│ Sonarr      │     │ (recherche)  │     │ (wawacity, etc) │
└─────────────┘     └──────────────┘     └─────────────────┘
       │
       │ envoie .torrent via API qBittorrent
       ▼
┌─────────────────┐     ┌───────────────────┐
│ ddl-qbittorrent │────>│ dlprotect-resolver│
│ (télécharge)    │     │ (si lien protégé) │
└─────────────────┘     └───────────────────┘
       │
       │ télécharge via debrid (AllDebrid/RealDebrid)
       ▼
┌─────────────────┐
│ Downloads       │ ← Radarr/Sonarr importe automatiquement
│ folder          │
└─────────────────┘
```

---

## Configuration avec Blackhole (Option B)

### Lancer les services

```bash
docker compose --profile blackhole up -d
```

> Cette commande démarre uniquement : `ddl-torznab`, `dlprotect-resolver` et `ddl-downloader`

### Configuration de Radarr

#### Étape 1 : Ajouter l'indexeur Torznab

1. Aller dans **Settings > Indexers > Add**
2. Choisir **Torznab**
3. Configurer :
   - **Name** : DDL Wawacity (ou ZoneTelecharger)
   - **URL** : `http://<IP>:9117/api/wawacity/` (ou `zonetelecharger`)
   - **API Key** : `ddl-torznab` (n'importe quelle valeur)
   - **Categories** : 2000, 2040, 2045
4. Cliquer sur **Test** puis **Save**

> Remplacer `<IP>` par l'adresse du serveur (ex: `192.168.1.100`, `localhost`, ou votre domaine)

### Étape 2 : Configurer le Download Client Blackhole

1. Aller dans **Settings > Download Clients > Add**
2. Choisir **Torrent Blackhole**
3. Configurer :
   - **Name** : DDL Blackhole
   - **Torrent Folder** : `/chemin/vers/blackhole` (même que `BLACKHOLE_PATH`)
   - **Watch Folder** : `/chemin/vers/downloads` (où vos fichiers seront téléchargés par JDownloader/aria2)
   - **Save Magnet Files** : Non (désactivé)
4. Cliquer sur **Test** puis **Save**

## Configuration de Sonarr

### Étape 1 : Ajouter l'indexeur Torznab

1. Aller dans **Settings > Indexers > Add**
2. Choisir **Torznab**
3. Configurer :
   - **Name** : DDL Wawacity (ou ZoneTelecharger)
   - **URL** : `http://<IP>:9117/api/wawacity/` (ou `zonetelecharger`)
   - **API Key** : `ddl-torznab` (n'importe quelle valeur)
   - **Categories** : 5000, 5040, 5045
   - **Anime Categories** : 5070 (optionnel)
4. Cliquer sur **Test** puis **Save**

> Remplacer `<IP>` par l'adresse du serveur (ex: `192.168.1.100`, `localhost`, ou votre domaine)

### Étape 2 : Configurer le Download Client Blackhole

1. Aller dans **Settings > Download Clients > Add**
2. Choisir **Torrent Blackhole**
3. Configurer :
   - **Name** : DDL Blackhole
   - **Torrent Folder** : `/chemin/vers/blackhole` (même que `BLACKHOLE_PATH`)
   - **Watch Folder** : `/chemin/vers/downloads` (où vos fichiers seront téléchargés par JDownloader/aria2)
   - **Save Magnet Files** : Non (désactivé)
4. Cliquer sur **Test** puis **Save**

## URLs Torznab disponibles

| Site | URL |
|------|-----|
| Wawacity | `http://<IP>:9117/api/wawacity/` |
| ZoneTelecharger | `http://<IP>:9117/api/zonetelecharger/` |

> Remplacer `<IP>` par l'adresse du serveur (ex: `192.168.1.100`, `localhost`, ou votre domaine)

### Filtrage par hébergeur

Vous pouvez filtrer les résultats pour n'afficher que les liens d'un ou plusieurs hébergeurs spécifiques. Cela permet de ne garder que les hébergeurs supportés par votre service debrid.

**Via le chemin URL :**
```
http://<IP>:9117/api/wawacity/1fichier/
http://<IP>:9117/api/wawacity/1fichier,rapidgator/
http://<IP>:9117/api/zonetelecharger/turbobit/
```

**Via le paramètre query :**
```
http://<IP>:9117/api/wawacity/?hoster=1fichier
http://<IP>:9117/api/wawacity/?hoster=1fichier,rapidgator
```

**Hébergeurs courants :**
- `1fichier`
- `turbobit`
- `rapidgator`
- `uptobox`
- `nitroflare`

> **Astuce** : Dans Radarr/Sonarr, créez plusieurs indexeurs avec différents hébergeurs pour prioriser certains services. Par exemple, un indexeur `DDL Wawacity - 1fichier` et un autre `DDL Wawacity - turbobit`.

### Fonctionnement du flux complet

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────┐
│ Radarr/     │────>│ ddl-torznab  │────>│ Site DDL        │
│ Sonarr      │     │ (recherche)  │     │ (wawacity, etc) │
└─────────────┘     └──────────────┘     └─────────────────┘
       │
       │ télécharge .torrent
       ▼
┌─────────────┐     ┌───────────────┐     ┌─────────────────┐
│ Blackhole   │────>│ ddl-downloader│────>│ JDownloader/    │
│ folder      │     │ (supprime le  │     │ aria2/DS        │
└─────────────┘     │  .torrent)    │     └─────────────────┘
                    └───────────────┘             │
                                                  │ télécharge
                                                  ▼
                                         ┌─────────────────┐
                                         │ Downloads       │
                                         │ folder          │
                                         └─────────────────┘
```

1. **Radarr/Sonarr** recherche un film/série via l'indexeur Torznab
2. L'indexeur retourne des résultats avec des liens `.torrent` (contenant des liens DDL)
3. Radarr/Sonarr télécharge le `.torrent` dans le **dossier blackhole**
4. Le service **ddl-downloader** détecte le nouveau fichier
5. Il extrait le lien DDL et l'envoie au **client de téléchargement** configuré
6. Le fichier `.torrent` est **supprimé** (ou déplacé vers `processed/` si `DEBUG=true`)
7. Le client télécharge le fichier dans le **dossier downloads** surveillé par Radarr/Sonarr

## Configuration des clients de téléchargement

### JDownloader

Accédez à http://localhost:9118 pour configurer.

**Via l'API locale (recommandé si sur le même réseau) :**
- **API Mode** : Local API only
- **Host** : IP de la machine JDownloader (ex: 192.168.1.100)
- **Port** : 3128 (par défaut)

**Via MyJDownloader (accès distant) :**
- **API Mode** : MyJDownloader only
- **Email** : votre email MyJDownloader
- **Password** : votre mot de passe
- **Device Name** : nom exact de votre appareil JDownloader

### aria2

- **Host** : localhost (ou IP du serveur aria2)
- **Port** : 6800
- **Secret** : votre token RPC (optionnel)
- **Download Directory** : chemin de téléchargement

### Synology Download Station

- **Host** : IP du NAS
- **Port** : 5000 (ou 5001 pour HTTPS)
- **Username/Password** : identifiants DSM
- **Use SSL** : cocher si port 5001

## AllDebrid

AllDebrid permet de débrider les liens des hébergeurs premium (1fichier, Uptobox, etc.) pour des téléchargements plus rapides.

1. Créer un compte sur [AllDebrid](https://alldebrid.com/)
2. Générer une clé API : https://alldebrid.com/apikeys/
3. Ajouter la clé dans `.env` : `ALLDEBRID_API_KEY=votre_cle`
4. Ou via l'interface web du downloader (http://localhost:9118)

## Variables d'environnement

Voir `.env.example` pour la liste complète.

| Variable | Description | Défaut |
|----------|-------------|--------|
| `INDEXER_PORT` | Port de l'indexeur Torznab | 9117 |
| `DOWNLOADER_PORT` | Port du downloader | 9118 |
| `DLPROTECT_RESOLVER_PORT` | Port du résolveur dl-protect | 5000 |
| `WAWACITY_URL` | URL de WawaCity (auto-détection si vide) | auto |
| `ZONETELECHARGER_URL` | URL de Zone-Téléchargement (auto-détection si vide) | auto |
| `WAWACITY_TELEGRAM` | Canal Telegram WawaCity pour auto-détection | https://t.me/s/Wawacityofficiel |
| `ZONETELECHARGER_TELEGRAM` | Canal Telegram ZT pour auto-détection | https://t.me/s/ztofficiel |
| `BLACKHOLE_PATH` | Dossier blackhole | - |
| `ALLDEBRID_API_KEY` | Clé API AllDebrid | - |
| `DLPROTECT_RESOLVE_AT` | Où résoudre les liens dl-protect (voir ci-dessous) | indexer |
| `SEARCH_MAX_PAGES` | Nombre max de pages à crawler par recherche | 5 |
| `DISABLE_REMOTE_DL_PROTECT_CACHE` | Désactiver le cache distant pour dl-protect | false |
| `DEBUG` | Mode debug (voir ci-dessous) | false |
| `DS_ENABLED` | Activer Download Station | false |
| `JD_ENABLED` | Activer JDownloader | false |
| `ARIA2_ENABLED` | Activer aria2 | false |

> Les URLs des sites sont auto-détectées depuis Telegram au démarrage si non configurées. Vous pouvez forcer une URL en la définissant explicitement.

### Résolution des liens dl-protect

La variable `DLPROTECT_RESOLVE_AT` contrôle à quel moment les liens dl-protect sont résolus :

| Valeur | Description |
|--------|-------------|
| `indexer` | Les liens sont résolus lors de la recherche. Navigation plus rapide dans Radarr/Sonarr car les liens sont déjà prêts. |
| `downloader` | Les liens sont résolus uniquement au moment du téléchargement. Moins de charge sur le service de résolution. |

```bash
# Dans .env
DLPROTECT_RESOLVE_AT=downloader
```

### Mode Debug

Par défaut (`DEBUG=false`), les fichiers `.torrent` sont **supprimés** après traitement.

En mode debug (`DEBUG=true`), les fichiers sont **déplacés** vers le dossier `processed/` pour inspection.

```bash
# Dans .env
DEBUG=true
```

### Recherche intelligente via IMDB

Quand Radarr/Sonarr fournit un IMDB ID, l'indexeur utilise l'API IMDB (https://imdbapi.dev) pour récupérer :
- Le **titre original** du film/série
- Le **titre français**

Ces titres sont utilisés en plus de la requête originale pour une recherche plus complète, notamment pour les films français avec des accents.

**Exemple :**
```
Radarr envoie: imdbid=0082183
→ API IMDB retourne: originalTitle="La chèvre", frenchTitle="La Chèvre"
→ Recherches effectuées: ["la chèvre"]
```

### Cache distant dl-protect

Le service de résolution dl-protect utilise un cache distant partagé entre utilisateurs. Cela permet d'éviter de résoudre plusieurs fois le même lien.

Pour désactiver le cache distant (par exemple si le serveur est inaccessible) :

```bash
# Dans .env
DISABLE_REMOTE_DL_PROTECT_CACHE=true
```

> Le cache local reste actif même si le cache distant est désactivé.

## Catégories Torznab

| Catégorie | Code | Description |
|-----------|------|-------------|
| Movies | 2000 | Films |
| Movies/HD | 2040 | Films HD (720p, 1080p) |
| Movies/UHD | 2045 | Films 4K |
| TV | 5000 | Séries |
| TV/HD | 5040 | Séries HD |
| TV/UHD | 5045 | Séries 4K |
| Anime | 5070 | Anime |

## Structure du projet

```
ddl_torznab/
├── docker-compose.yml          # Configuration Docker
├── .env.example                # Template variables d'environnement
├── .env                        # Variables d'environnement (à créer)
├── indexer/                    # Service Torznab (port 9117)
│   └── src/
│       ├── scrapers/           # Scrapers pour chaque site
│       ├── routes/             # API Torznab
│       └── utils/              # Utilitaires (XML, HTTP, dl-protect)
├── downloader/                 # Service Blackhole Downloader (port 9118)
│   └── src/
│       ├── clients/            # Clients de téléchargement (JD, aria2, DS)
│       ├── routes/             # API de configuration
│       └── watcher.ts          # Surveillance du blackhole
└── botasaurus-service/         # Service de résolution dl-protect (port 5000)
    └── main.py
```

## Dépannage

### Les recherches ne retournent rien

- Vérifier que les URLs des sites sont correctes et accessibles
- Consulter les logs : `docker-compose logs ddl-torznab`

### Les liens ne sont pas résolus

- Vérifier que le service dlprotect-resolver fonctionne : `docker-compose logs dlprotect-resolver`
- Le premier démarrage peut prendre du temps (téléchargement de Chromium)

### Le downloader ne détecte pas les fichiers

- Vérifier les permissions du dossier blackhole
- Vérifier que le chemin est correct dans docker-compose.yml
- Consulter les logs : `docker-compose logs ddl-downloader`

### JDownloader ne reçoit pas les liens

- Vérifier que l'API locale est activée dans JDownloader (Settings > Advanced > API)
- Ou vérifier vos identifiants MyJDownloader
- Tester la connexion via l'interface web du downloader

## Développement

```bash
# Indexer
cd indexer
npm install
npm run dev

# Downloader
cd downloader
npm install
npm run dev
```

## Licence

MIT
