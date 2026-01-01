# TODO

## Améliorations futures

### Scrapers
- [ ] Finaliser l'intégration de Darkiworld
  - Scraper partiellement implémenté dans `indexer/src/scrapers/darkiworld.ts`
  - Nécessite une clé API (`DARKIWORLD_API_KEY`)
  - Décommenter dans `config.ts`, `scrapers/index.ts` et `docker-compose.yml`

### Download Station Client
- [ ] Remplacer l'implémentation custom par [synology-http-client](https://github.com/dvcol/synology-http-client)
  - Support complet de l'API Synology
  - Meilleure gestion des erreurs
  - Authentification plus robuste
  - Support de toutes les versions de l'API

### Developper un downloader complet qui impletement les meme protocoles que qBittorent pour améliorer l'integration 


### Indiquer en debut de log si le container démarre bien avec le code à jour
 - commit courant le plus recent.
 - Mettre un gros warning si ce n'est pas le cas.
