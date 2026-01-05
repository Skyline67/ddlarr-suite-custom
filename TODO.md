# TODO

## Améliorations futures

### Scrapers
- [ ] Finaliser l'intégration de Darkiworld
  - Scraper partiellement implémenté dans `indexer/src/scrapers/darkiworld.ts`
  - Nécessite une clé API (`DARKIWORLD_API_KEY`)
  - Décommenter dans `config.ts`, `scrapers/index.ts` et `docker-compose.yml`

  
### Indiquer en debut de log si le container démarre bien avec le code à jour
 - commit courant le plus recent.
 - Mettre un gros warning si ce n'est pas le cas.


### Utiliser le cache des dl-link pour resoudre les liens en cache au niveau de l'indexeur
- Permettra de ne pas lister des liens en 404 que l'on peut déjà tester. 