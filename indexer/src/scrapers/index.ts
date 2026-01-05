import type { BaseScraper } from './base.js';
import { contentTypeToCategory } from './base.js';
import { WawacityScraper } from './wawacity.js';
import { ZoneTelechargerScraper } from './zonetelecharger.js';
import { DarkiworldPremiumScraper } from './darkiworld.js';
import { SiteType, isSiteConfigured, getSiteUrl } from '../config.js';

export type { BaseScraper } from './base.js';
export { contentTypeToCategory } from './base.js';

const scraperCache = new Map<SiteType, BaseScraper>();

export function getScraper(site: SiteType): BaseScraper | null {
  if (!isSiteConfigured(site)) {
    return null;
  }

  if (scraperCache.has(site)) {
    return scraperCache.get(site)!;
  }

  const url = getSiteUrl(site);
  let scraper: BaseScraper;

  switch (site) {
    case 'wawacity':
      scraper = new WawacityScraper(url);
      break;
    case 'zonetelecharger':
      scraper = new ZoneTelechargerScraper(url);
      break;
    case 'darkiworld-premium':
      scraper = new DarkiworldPremiumScraper(url);
      break;
    default:
      return null;
  }

  scraperCache.set(site, scraper);
  return scraper;
}

export function getAvailableSites(): SiteType[] {
  const sites: SiteType[] = ['wawacity', 'zonetelecharger', 'darkiworld-premium'];
  return sites.filter((site) => isSiteConfigured(site));
}

export function isValidSite(site: string): site is SiteType {
  return ['wawacity', 'zonetelecharger', 'darkiworld-premium'].includes(site);
}