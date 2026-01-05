/**
 * DarkiworldPremium Scraper
 * Connects to the Darkiworld Python Flask service for premium content scraping
 */
import { BaseScraper, parseQuality, parseLanguage } from './base.js';
import { ScraperResult, SearchParams, ContentType } from '../models/torznab.js';
import { fetchJson } from '../utils/http.js';
import { config } from '../config.js';

interface DarkiworldRelease {
  name?: string;
  added?: string;
  download_link: string;
  languages?: string[];
  size?: number;
  subtitles?: string[];
}

interface DarkiworldSearchResponse {
  success: boolean;
  query?: string;
  media_id?: string;
  media_title?: string;
  search_url?: string;
  total_releases?: number;
  filtered_count?: number;
  valid_count?: number;
  allowed_hosters?: string[];
  releases?: DarkiworldRelease[];
  authenticated?: boolean;
  error?: string;
}

export class DarkiworldPremiumScraper implements BaseScraper {
  readonly name = 'DarkiWorld Premium';

  constructor(public readonly baseUrl: string) {}

  /**
   * Makes an HTTP GET request to the Darkiworld Python service
   */
  private async searchDarkiworld(
    query: string,
    type?: 'movie' | 'series',
    season?: string,
    ep?: string,
    hosters?: string
  ): Promise<DarkiworldSearchResponse> {
    try {
      const typeParam = type ? `&type=${type}` : '';
      const seasonParam = season ? `&season=${encodeURIComponent(season)}` : '';
      const epParam = ep ? `&ep=${encodeURIComponent(ep)}` : '';
      const hostersParam = hosters ? `&hosters=${encodeURIComponent(hosters)}` : '';
      const url = `${this.baseUrl}/search?name=${encodeURIComponent(query)}${typeParam}${seasonParam}${epParam}${hostersParam}`;
      console.log(`[DarkiworldPremium] Calling service: ${url}`);
      
      const response = await fetchJson<DarkiworldSearchResponse>(url, { timeout: 60000 });
      
      if (!response.success) {
        console.error(`[DarkiworldPremium] Service returned error: ${response.error || 'Unknown error'}`);
        return response;
      }

      console.log(`[DarkiworldPremium] Found ${response.valid_count || 0} valid releases`);
      return response;
    } catch (error) {
      console.error(`[DarkiworldPremium] HTTP request failed:`, error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Maps a Darkiworld release to a ScraperResult
   */
  private mapToScraperResult(
    release: DarkiworldRelease,
    mediaTitle: string,
    contentType: ContentType
  ): ScraperResult {
    // Extract quality from filename if not provided
    const quality = release.name ? parseQuality(release.name) : undefined;

    // Extract language from filename or languages array
    let language: string | undefined;
    if (release.languages && release.languages.length > 0) {
      language = release.languages.join(', ');
    } else if (release.name) {
      language = parseLanguage(release.name);
    }

    // Title: use filename or media title
    const title = release.name || mediaTitle;

    // Parse date
    const pubDate = release.added ? new Date(release.added) : new Date();

    return {
      title,
      link: release.download_link, // Direct download link
      size: release.size,
      quality,
      language,
      contentType,
      pubDate,
    };
  }

  async search(params: SearchParams): Promise<ScraperResult[]> {
    if (!params.q) return [];

    const response = await this.searchDarkiworld(params.q, undefined, undefined, undefined, params.hoster);
    
    if (!response.success || !response.releases || response.releases.length === 0) {
      return [];
    }

    const mediaTitle = response.media_title || params.q;

    // Map all releases - no filtering by type since this is generic search
    return response.releases.map((release) =>
      this.mapToScraperResult(release, mediaTitle, 'movie') // Default to movie for generic search
    );
  }

  async searchMovies(params: SearchParams): Promise<ScraperResult[]> {
    if (!params.q) return [];

    const response = await this.searchDarkiworld(params.q, 'movie', undefined, undefined, params.hoster);
    
    if (!response.success || !response.releases || response.releases.length === 0) {
      return [];
    }

    const mediaTitle = response.media_title || params.q;

    // Map all releases as movies
    return response.releases.map((release) =>
      this.mapToScraperResult(release, mediaTitle, 'movie')
    );
  }

  async searchSeries(params: SearchParams): Promise<ScraperResult[]> {
    if (!params.q) return [];

    // Pass season, episode, and hosters to filter results on the Python service
    const response = await this.searchDarkiworld(params.q, 'series', params.season, params.ep, params.hoster);
    
    if (!response.success || !response.releases || response.releases.length === 0) {
      return [];
    }

    const mediaTitle = response.media_title || params.q;

    // Map all releases as series (already filtered by season/ep on the service)
    return response.releases.map((release) =>
      this.mapToScraperResult(release, mediaTitle, 'series')
    );
  }

  async searchAnime(params: SearchParams): Promise<ScraperResult[]> {
    if (!params.q) return [];

    const response = await this.searchDarkiworld(params.q, undefined, undefined, undefined, params.hoster);
    
    if (!response.success || !response.releases || response.releases.length === 0) {
      return [];
    }

    const mediaTitle = response.media_title || params.q;

    // Map all releases as anime
    return response.releases.map((release) =>
      this.mapToScraperResult(release, mediaTitle, 'anime')
    );
  }
}
