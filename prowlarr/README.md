# DDL Torznab - Prowlarr Custom Indexer

Cette définition Cardigann permet d'ajouter DDL Torznab comme indexeur natif dans Prowlarr.

> **Note** : Cette définition n'a pas été testée. Si vous rencontrez des problèmes, utilisez l'Option 2 (Generic Torznab) qui fonctionne de manière fiable.

## Installation

### Option 1 : Définition Custom (recommandé)

1. Copier le fichier `ddl-torznab.yml` dans le dossier des définitions custom de Prowlarr :
   - **Linux** : `~/.config/Prowlarr/Definitions/Custom/`
   - **Docker** : `/config/Definitions/Custom/`
   - **Windows** : `%AppData%\Prowlarr\Definitions\Custom\`

2. Redémarrer Prowlarr

3. Ajouter l'indexeur :
   - Aller dans **Settings > Indexers > Add Indexer**
   - Chercher "DDL Torznab"
   - Configurer l'URL (par défaut : `http://ddl-torznab:3000`)
   - Sélectionner le site source (Darkiworld, ZoneTelecharger, WawaCity)

### Option 2 : Generic Torznab

Si la définition custom ne fonctionne pas, utiliser l'indexeur Torznab générique :

1. Dans Prowlarr : **Settings > Indexers > Add Indexer**
2. Sélectionner **Generic Torznab**
3. Configurer :
   - **Name** : DDL Torznab - Darkiworld (ou autre site)
   - **URL** : `http://ddl-torznab:3000/api/darkiworld`
   - **API Key** : laisser vide
   - **Categories** : Movies, TV

## Configuration

| Paramètre | Description | Exemple |
|-----------|-------------|---------|
| DDL Torznab URL | URL du service DDL Torznab | `http://ddl-torznab:3000` |
| Source Site | Site DDL à utiliser | `darkiworld` |

## Sites disponibles

- **Darkiworld** : Films et séries FR
- **ZoneTelecharger** : Films et séries FR
- **WawaCity** : Films, séries et ebooks FR

## Filtrer par hébergeur

Pour filtrer par hébergeur spécifique, utiliser l'URL avec le chemin :
```
http://ddl-torznab:3000/api/darkiworld/1fichier
http://ddl-torznab:3000/api/darkiworld/uptobox,1fichier
```

## Docker Compose

Si vous utilisez Docker Compose avec Prowlarr :

```yaml
services:
  prowlarr:
    image: linuxserver/prowlarr
    volumes:
      - ./prowlarr:/config
      - ./prowlarr/ddl-torznab.yml:/config/Definitions/Custom/ddl-torznab.yml:ro
```

## Dépannage

- **Indexeur non visible** : Redémarrer Prowlarr après avoir copié le fichier
- **Erreur de connexion** : Vérifier que DDL Torznab est accessible depuis Prowlarr (même réseau Docker)
- **Pas de résultats** : Tester avec l'interface web de DDL Torznab directement
