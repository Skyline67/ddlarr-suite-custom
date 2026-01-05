"""
Configuration module for Darkiworld Scraper
Centralizes all environment variables, constants, and logging setup.

For development: uses local darkiworld/.env
For Docker: uses parent .env file
"""

import os
import logging
import requests
import time
from typing import Optional
from dotenv import load_dotenv

# Try to load local .env first (for development)
local_env = os.path.join(os.path.dirname(__file__), '.env')
if os.path.exists(local_env):
    load_dotenv(local_env)
else:
    # Fallback to parent .env (for Docker)
    parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dotenv_path = os.path.join(parent_dir, '.env')
    load_dotenv(dotenv_path)

# Load DEBUG mode first (needed for logging configuration)
DEBUG = os.getenv('DEBUG', 'false').lower() == 'true'

# Configure logging based on DEBUG mode
logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def get_url_after_redirect(url: str, timeout: int = 5) -> Optional[str]:
    """
    Get final URL after following HTTP redirects.
    Similar to indexer's getUrlAfterRedirect() in TypeScript.

    Args:
        url: Initial URL to follow
        timeout: Request timeout in seconds

    Returns:
        Final URL after redirects, or None if error
    """
    try:
        response = requests.get(
            url,
            timeout=timeout,
            allow_redirects=True,  # Follow redirects (default)
            headers={
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            }
        )
        # response.url contains the final URL after all redirects
        return response.url
    except Exception as e:
        logger.error(f"Error getting URL after redirect for {url}: {e}")
        return None


# URL resolution cache with TTL (refreshed every hour like indexer)
_resolved_url_cache: Optional[str] = None
_cache_timestamp: Optional[float] = None
CACHE_TTL = 60 * 60  # 1 hour in seconds


def get_darkiworld_url() -> str:
    """
    Get Darkiworld URL with lazy resolution and TTL caching.

    Priority:
    1. DARKIWORLD_URL env var (if set and not empty)
    2. Cached resolved URL (if not expired)
    3. Resolve via redirect from https://darkiworld.com/
    4. Fallback to default URL

    The resolved URL is cached for 1 hour, then re-resolved.
    """
    global _resolved_url_cache, _cache_timestamp

    # Priority 1: Environment variable (if not empty)
    env_url = os.getenv('DARKIWORLD_URL', '').strip()
    if env_url:
        logger.debug(f"Using Darkiworld URL from environment: {env_url}")
        return env_url

    # Priority 2: Cached resolved URL (if not expired)
    if _resolved_url_cache and _cache_timestamp:
        age = time.time() - _cache_timestamp
        if age < CACHE_TTL:
            logger.debug(f"Using cached Darkiworld URL (age: {int(age)}s): {_resolved_url_cache}")
            return _resolved_url_cache
        else:
            logger.info(f"Cache expired (age: {int(age)}s), re-resolving URL...")

    # Priority 3: Resolve via redirect
    logger.info("Resolving Darkiworld URL via redirect from https://darkiworld.com/...")
    resolved = get_url_after_redirect('https://darkiworld.com/')

    if resolved:
        # Cache the resolved URL with timestamp
        _resolved_url_cache = resolved
        _cache_timestamp = time.time()
        logger.info(f"✓ Darkiworld URL resolved and cached: {resolved}")
        return resolved

    # Fallback
    default_url = 'https://darkiworld15.com/'
    logger.warning(f"Could not resolve URL, using default: {default_url}")
    _resolved_url_cache = default_url
    _cache_timestamp = time.time()
    return default_url


# Static config from env (no lazy loading for these)
DARKIWORLD_URL = get_darkiworld_url()

# AllDebrid API configuration
ALLDEBRID_API_KEY = os.getenv('DARKIWORLD_ALLDEBRID_KEY', '')
ALLDEBRID_API_URL = 'https://api.alldebrid.com/v4/link/unlock'

# Server configuration
PORT = int(os.getenv('DARKIWORLD_PORT', 5002))

# Runtime configuration (can be updated via API)
# This allows dynamic configuration from the indexer UI
# Darkiworld is disabled by default - must pass login test to enable
# Credentials are configured via the web UI, not environment variables
runtime_config = {
    'enabled': False,
    'email': '',
    'password': '',
    'authenticated': False,
}


def update_runtime_config(new_config: dict) -> dict:
    """
    Update runtime configuration with new values.
    Only updates provided keys, preserves others.
    
    Args:
        new_config: Dict with keys to update (enabled, email, password)
        
    Returns:
        Current config (without password)
    """
    global runtime_config
    
    if 'enabled' in new_config:
        runtime_config['enabled'] = bool(new_config['enabled'])
        logger.info(f"Runtime config: enabled = {runtime_config['enabled']}")
        
    if 'email' in new_config:
        runtime_config['email'] = new_config['email']
        logger.info(f"Runtime config: email updated")
        
    if 'password' in new_config and new_config['password']:
        runtime_config['password'] = new_config['password']
        runtime_config['authenticated'] = False  # Need to re-login with new password
        logger.info("Runtime config: password updated, will re-authenticate")
    
    return get_runtime_config()


def get_runtime_config(include_sensitive: bool = False) -> dict:
    """
    Get current runtime configuration.
    
    Args:
        include_sensitive: If True, includes the password (for internal use).
                           If False, returns safe version for API (default).
    
    Returns:
        Dict with config values
    """
    config = {
        'enabled': runtime_config['enabled'],
        'email': runtime_config['email'],
        'authenticated': runtime_config['authenticated'],
    }
    
    if include_sensitive:
        config['password'] = runtime_config['password']
    else:
        config['has_password'] = bool(runtime_config['password'])
        
    return config


def set_authenticated(value: bool) -> None:
    """Set the authenticated status."""
    global runtime_config
    runtime_config['authenticated'] = value
    logger.info(f"Runtime config: authenticated = {value}")

