import { BaseScraper, parseQuality, parseLanguage } from './base.js';
import { ScraperResult, SearchParams, ContentType } from '../models/torznab.js';
import { fetchJson } from '../utils/http.js';
import { getSearchQueriesFromImdb } from '../utils/imdb.js';

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
    const results: ScraperResult[] = [];

    const [movies, series, anime] = await Promise.allSettled([
      this.searchMovies(params),
      this.searchSeries(params),
      this.searchAnime(params),
    ]);

    if (movies.status === 'fulfilled') results.push(...movies.value);
    if (series.status === 'fulfilled') results.push(...series.value);
    if (anime.status === 'fulfilled') results.push(...anime.value);

    return results;
  }

  async searchMovies(params: SearchParams): Promise<ScraperResult[]> {
    return this.searchByType(params, 'movie');
  }

  async searchSeries(params: SearchParams): Promise<ScraperResult[]> {
    return this.searchByType(params, 'series');
  }

  async searchAnime(params: SearchParams): Promise<ScraperResult[]> {
    return this.searchByType(params, 'anime');
  }

  private async searchByType(params: SearchParams, contentType: ContentType): Promise<ScraperResult[]> {
    if (!params.q && !params.imdbid) return [];

    let searchQueries: string[] = [];
    if (params.imdbid) {
      console.log(`[DarkiworldPremium] IMDB ID provided for ${contentType}: ${params.imdbid}`);
      searchQueries = await getSearchQueriesFromImdb(params.imdbid, params.q);
    } else if (params.q) {
      searchQueries = [params.q];
    }

    if (searchQueries.length === 0) return [];

    const allResults: ScraperResult[] = [];
    const seenLinks = new Set<string>();

    for (const query of searchQueries) {
      // Determine API parameters based on content type
      let typeParam: 'movie' | 'series' | undefined;
      let seasonParam: string | undefined;
      let epParam: string | undefined;

      if (contentType === 'movie') {
        typeParam = 'movie';
      } else if (contentType === 'series') {
        typeParam = 'series';
        seasonParam = params.season;
        epParam = params.ep;
      }
      // For anime, typeParam stays undefined (generic search)

      const response = await this.searchDarkiworld(query, typeParam, seasonParam, epParam, params.hoster);
      
      if (!response.success || !response.releases || response.releases.length === 0) {
        continue;
      }

      const mediaTitle = response.media_title || query;

      for (const release of response.releases) {
        if (!seenLinks.has(release.download_link)) {
          seenLinks.add(release.download_link);
          allResults.push(this.mapToScraperResult(release, mediaTitle, contentType));
        }
      }
    }

    return allResults;
  }
}
