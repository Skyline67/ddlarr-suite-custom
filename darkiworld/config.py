"""
Configuration module for Darkiworld Scraper
Centralizes all environment variables, constants, and logging setup.

For development: uses local darkiworld/.env
For Docker: uses parent .env file
"""

import os
import logging
import requests
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
    import time
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

# Authentication credentials
DARKIWORLD_EMAIL = os.getenv('DARKIWORLD_EMAIL', '')
DARKIWORLD_PASSWORD = os.getenv('DARKIWORLD_PASSWORD', '')

# Allowed hosters for filtering releases
ALLOWED_HOSTER = os.getenv('DARKIWORLD_ALLOWED_HOSTER', '').split(',')
ALLOWED_HOSTER = [h.strip().lower() for h in ALLOWED_HOSTER if h.strip()]

# AllDebrid API configuration
ALLDEBRID_API_KEY = os.getenv('DARKIWORLD_ALLDEBRID_KEY', '')
ALLDEBRID_API_URL = 'https://api.alldebrid.com/v4/link/unlock'

# Server configuration
PORT = int(os.getenv('DARKIWORLD_PORT', 5002))
