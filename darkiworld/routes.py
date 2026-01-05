"""
Flask routes module for Darkiworld Scraper
Defines all API endpoints.
"""

import logging
from flask import Blueprint, request, jsonify
from scraper import scrape_darkiworld, search_darkiworld
from cache import search_cache, search_guard, generate_cache_key, normalize_query
from driver_sb import get_driver, close_driver
from auth_sb import login

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
        # Check if service is enabled
        from config import runtime_config
        if not runtime_config.get('enabled', True):
            logger.info("🚫 Search rejected: DarkiWorld service is disabled")
            return jsonify({
                'success': False,
                'error': 'DarkiWorld service is disabled',
                'releases': []
            }), 503

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
            
            # Parse hosters from request (comma-separated list)
            hosters_str = data.get('hosters', '')
            allowed_hosters = [h.strip().lower() for h in hosters_str.split(',') if h.strip()] if hosters_str else []
            
            logger.info(f"Hosters filter: {allowed_hosters if allowed_hosters else 'ALL (no filter)'}")
            
            result = search_darkiworld({
                'name': normalized_query,
                'type': media_type,
                'season': season,
                'ep': ep,
                'allowed_hosters': allowed_hosters
            })

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


@api.route('/config', methods=['GET'])
def get_config_route():
    """
    Get current configuration (without sensitive data).
    Used by the indexer UI to display current settings.
    
    Returns:
        {
            "enabled": bool,
            "email": str,
            "has_password": bool,
            "authenticated": bool
        }
    """
    from config import get_runtime_config
    return jsonify(get_runtime_config()), 200


@api.route('/config', methods=['POST'])
def set_config_route():
    """
    Update configuration.
    Used by the indexer UI to save settings.
    
    Request body (all fields optional):
        {
            "enabled": bool,
            "email": str,
            "password": str  (only sent if changed)
        }
    
    Returns:
        {
            "success": bool,
            \"enabled\": bool,
            \"email\": str,
            \"has_password\": bool,
            \"authenticated\": bool
        }
    """
    from config import update_runtime_config
    
    try:
        data = request.get_json() or {}
        updated_config = update_runtime_config(data)
        return jsonify({'success': True, **updated_config}), 200
    except Exception as e:
        logger.error(f"Error updating config: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@api.route('/test-login', methods=['POST'])
def test_login_route():
    """
    Test login with current or provided credentials.
    This performs a real login attempt against Darkiworld.
    
    Request body (optional - uses runtime config if not provided):
        {
            "email": str,
            "password": str
        }
    
    Returns:
        {
            "success": bool,
            "authenticated": bool,
            "message": str
        }
    """
    from config import runtime_config, set_authenticated, get_darkiworld_url
    
    try:
        data = request.get_json() or {}
        
        # Use provided credentials or fall back to runtime config
        email = data.get('email') or runtime_config.get('email', '')
        password = data.get('password') or runtime_config.get('password', '')
        
        if not email or not password:
            return jsonify({
                'success': False,
                'authenticated': False,
                'message': 'Email et mot de passe requis'
            }), 400
        
        # Update config with new credentials if provided
        if data.get('email'):
            runtime_config['email'] = data['email']
        if data.get('password'):
            runtime_config['password'] = data['password']
        
        logger.info(f"🔐 Testing login for: {email}")
                
        url = get_darkiworld_url()
        
        try:
            sb = get_driver()
            success = login(sb, url, email, password)
        except Exception as login_error:
            logger.error(f"Login error: {login_error}", exc_info=True)
            success = False
        
        # Close driver in background thread to not block response
        import threading
        threading.Thread(target=close_driver, daemon=True).start()
        
        if success:
            set_authenticated(True)
            logger.info("✅ Login test successful")
            return jsonify({
                'success': True,
                'authenticated': True,
                'message': 'Connexion réussie'
            }), 200
        else:
            set_authenticated(False)
            logger.warning("❌ Login test failed")
            return jsonify({
                'success': False,
                'authenticated': False,
                'message': 'Échec de la connexion - vérifiez vos identifiants'
            }), 401
    
    except Exception as e:
        logger.error(f"Error testing login: {e}", exc_info=True)
        set_authenticated(False)
        return jsonify({
            'success': False,
            'authenticated': False,
            'message': f'Erreur: {str(e)}'
        }), 500


