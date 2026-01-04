"""
Flask routes module for Darkiworld Scraper
Defines all API endpoints.
"""

import logging
from flask import Blueprint, request, jsonify
from scraper import scrape_darkiworld, search_darkiworld
from cache import search_cache, search_guard, generate_cache_key, normalize_query

logger = logging.getLogger(__name__)

# Create Blueprint for API routes
api = Blueprint('api', __name__)


@api.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({'status': 'ok'}), 200

@api.route('/search', methods=['GET'])
def search():
    """
    Search endpoint - searches DarkiWorld

    Parameters:
    - name or query (required): Search query
    - type (optional): Media type (movie, series)
    - season (optional): Season number for series
    - ep (optional): Episode number for series

    Example:
    GET /search?name=Avatar
    GET /search?name=Stranger Things&type=series&season=1&ep=1
    """
    try:
        data = request.args.to_dict()

        query = data.get('name', data.get('query', ''))

        if not query:
            return jsonify({
                'success': False,
                'error': 'Parameter "name" or "query" is required'
            }), 400

        media_type = data.get('type', 'movie')  # Default to movie, can be 'series'
        season = data.get('season')  # Optional: season number for series
        ep = data.get('ep')  # Optional: episode number for series
        
        # VALIDATION: Reject series/animes searches without season parameter
        # Sonarr sends many useless queries like "01", "02" for anime episode searches
        # These are not useful for our scraper - we need proper title + season
        if media_type in ('series', 'animes') and not season:
            logger.warning(f"🚫 Rejecting {media_type} search without season parameter: '{query}'")
            return jsonify({
                'success': False,
                'error': f'Season parameter is required for {media_type} searches',
                'releases': []
            }), 400
        
        # Convert season/ep to int for cache key generation (if provided)
        season_int = int(season) if season else None
        ep_int = int(ep) if ep else None
        
        # Normalize query to remove redundant season/episode/suffix indicators
        # e.g. "Jujutsu Kaisen TV" -> "jujutsu kaisen" (when season=1)
        #      "Jujutsu Kaisen 2nd Season" -> "jujutsu kaisen" (when season=2)
        normalized_query = normalize_query(query, season_int)
        
        # Generate cache key from NORMALIZED query params
        cache_key = generate_cache_key(query, media_type, season_int, ep_int)
        
        # Check cache first
        cached_result = search_cache.get(cache_key)
        if cached_result:
            logger.info(f"✅ Cache hit for: '{normalized_query}' (type: {media_type}, season: {season}, ep: {ep})")
            return jsonify(cached_result), 200
        
        # Try to acquire lock - reject if another search with same key is in progress
        if not search_guard.acquire(cache_key):
            logger.info(f"🚫 Duplicate request rejected: '{normalized_query}' (type: {media_type}, season: {season})")
            return jsonify({
                'success': False,
                'error': 'Search already in progress for this query'
            }), 429  # Too Many Requests
        
        try:
            logger.info(f"Search endpoint called with query: '{normalized_query}', type: '{media_type}', season: {season}, ep: {ep}")
            
            result = search_darkiworld({'name': normalized_query, 'type': media_type, 'season': season, 'ep': ep})

            logger.info(f"Search result success: {result.get('success')}, releases: {len(result.get('releases', []))}")
            status_code = 200 if result.get('success') else 400
            
            # Cache successful results
            if result.get('success'):
                search_cache.set(cache_key, result)
                logger.info(f"✅ Cached search result for: '{normalized_query}' (TTL: 60s)")
            
            logger.info(f"Returning response with status {status_code}")
            return jsonify(result), status_code
        
        finally:
            # Always release the lock
            search_guard.release(cache_key)

    except Exception as e:
        logger.error(f"Error in search endpoint: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500



@api.route('/cookies', methods=['GET'])
def get_cookies_route():
    """Get current cookies from browser"""
    try:
        result = scrape_darkiworld({})
        if result['success']:
            return jsonify({
                'success': True,
                'cookies': result.get('cookies', [])
            }), 200
        else:
            return jsonify(result), 500
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
