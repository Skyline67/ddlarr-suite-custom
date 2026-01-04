"""
TTL-based cache module for Darkiworld Scraper
Prevents redundant API calls from Sonarr's double-request behavior.
Includes query normalization to handle Sonarr's variations in search terms.
"""

import re
import time
import threading
import logging
from typing import Any, Optional, Callable

logger = logging.getLogger(__name__)


def normalize_query(query: str, season: Optional[int] = None) -> str:
    """
    Normalize a search query by removing common suffixes and variations.
    This ensures that queries like "Jujutsu Kaisen TV" and "Jujutsu Kaisen" 
    produce the same cache key when season is specified.
    
    Args:
        query: The search query to normalize
        season: If season is already specified as parameter, remove season references from query
        
    Returns:
        Normalized query string (lowercase, trimmed)
    """
    if not query:
        return ""
    
    # Start with lowercase and trimmed
    normalized = query.strip().lower()
    
    # Patterns to remove (order matters - more specific first)
    # These are common suffixes added by Sonarr/media managers
    patterns_to_remove = [
        # Season patterns (only remove if season param is already provided)
        r'\s+saison\s*\d+',          # "Saison 1", "Saison 2"
        r'\s+season\s*\d+',          # "Season 1", "Season 2"
        r'\s+s\d+',                  # "S1", "S2", "S01"
        r'\s+\d+(st|nd|rd|th)\s+season',  # "1st Season", "2nd Season"
        
        # Common media type suffixes
        r'\s+tv$',                   # "TV" at end
        r'\s+\(tv\)$',               # "(TV)" at end
        r'\s+\[tv\]$',               # "[TV]" at end
        r'\s+serie$',                # "Serie" at end
        r'\s+series$',               # "Series" at end
        r'\s+the\s+series$',         # "The Series" at end
        r'\s+anime$',                # "Anime" at end
        r'\s+vostfr$',               # "VOSTFR" at end
        r'\s+vf$',                   # "VF" at end
        r'\s+french$',               # "French" at end
        r'\s+multi$',                # "Multi" at end
        
        # Year patterns (often appended by Sonarr)
        r'\s+\(\d{4}\)$',            # "(2023)" at end
        r'\s+\[\d{4}\]$',            # "[2023]" at end
        r'\s+\d{4}$',                # "2023" at end (be careful with this one)
    ]
    
    # Apply all patterns
    for pattern in patterns_to_remove:
        normalized = re.sub(pattern, '', normalized, flags=re.IGNORECASE)
    
    # Clean up multiple spaces and trim again
    normalized = re.sub(r'\s+', ' ', normalized).strip()
    
    return normalized


def generate_cache_key(query: str, media_type: str, season: Optional[int] = None, 
                       episode: Optional[int] = None) -> str:
    """
    Generate a normalized cache key for search requests.
    
    Args:
        query: Search query
        media_type: Type of media (animes, films, series)
        season: Optional season number
        episode: Optional episode number
        
    Returns:
        Normalized cache key string
    """
    normalized = normalize_query(query, season)
    parts = [normalized, media_type]
    
    if season is not None:
        parts.append(str(season))
    if episode is not None:
        parts.append(str(episode))
    
    key = "|".join(parts)
    logger.debug(f"[CacheKey] '{query}' -> '{normalized}' -> key: {key}")
    return key


class TTLCache:
    """Thread-safe TTL cache for storing search results and link checks"""
    
    def __init__(self, name: str, default_ttl: int = 60):
        """
        Initialize cache with a default TTL.
        
        Args:
            name: Name of this cache (for logging)
            default_ttl: Default time-to-live in seconds
        """
        self._cache = {}
        self._lock = threading.Lock()
        self.name = name
        self.default_ttl = default_ttl
    
    def get(self, key: str) -> Optional[Any]:
        """
        Get cached value if not expired.
        
        Args:
            key: Cache key
            
        Returns:
            Cached value or None if not found/expired
        """
        with self._lock:
            if key in self._cache:
                value, expires_at = self._cache[key]
                if time.time() < expires_at:
                    logger.debug(f"[{self.name}] Cache hit: {key[:50]}...")
                    return value
                else:
                    # Expired, remove it
                    del self._cache[key]
                    logger.debug(f"[{self.name}] Cache expired: {key[:50]}...")
            return None
    
    def set(self, key: str, value: Any, ttl: int = None):
        """
        Set value with TTL in seconds.
        
        Args:
            key: Cache key
            value: Value to cache
            ttl: Time-to-live in seconds (uses default if not specified)
        """
        if ttl is None:
            ttl = self.default_ttl
        
        expires_at = time.time() + ttl
        
        with self._lock:
            self._cache[key] = (value, expires_at)
            logger.debug(f"[{self.name}] Cached: {key[:50]}... (TTL: {ttl}s)")
    
    def clear_expired(self):
        """Remove all expired entries"""
        now = time.time()
        with self._lock:
            expired_keys = [k for k, (_, exp) in self._cache.items() if now >= exp]
            for key in expired_keys:
                del self._cache[key]
            if expired_keys:
                logger.debug(f"[{self.name}] Cleared {len(expired_keys)} expired entries")
    
    def clear_all(self):
        """Clear all cache entries"""
        with self._lock:
            count = len(self._cache)
            self._cache.clear()
            logger.info(f"[{self.name}] Cleared all {count} entries")
    
    def size(self) -> int:
        """Return number of entries in cache"""
        with self._lock:
            return len(self._cache)


class RequestGuard:
    """
    Request guard: rejects duplicate in-flight requests.
    When a request is in progress, subsequent requests for the same key are rejected immediately.
    """
    
    def __init__(self, name: str):
        self.name = name
        self._active_requests = set()  # Set of active request keys
        self._lock = threading.Lock()
    
    def is_locked(self, key: str) -> bool:
        """Check if a request with this key is already in progress"""
        with self._lock:
            return key in self._active_requests
    
    def acquire(self, key: str) -> bool:
        """
        Try to acquire lock for this key.
        Returns True if acquired (first request), False if already locked (duplicate).
        """
        with self._lock:
            if key in self._active_requests:
                logger.info(f"[{self.name}] 🚫 Rejecting duplicate request: {key[:50]}...")
                return False
            self._active_requests.add(key)
            logger.debug(f"[{self.name}] 🔒 Acquired lock: {key[:50]}...")
            return True
    
    def release(self, key: str):
        """Release the lock for this key"""
        with self._lock:
            if key in self._active_requests:
                self._active_requests.discard(key)
                logger.debug(f"[{self.name}] 🔓 Released lock: {key[:50]}...")


# Global cache instances
# Search cache: 60s TTL - covers Sonarr's double-request pattern
search_cache = TTLCache(name="SearchCache", default_ttl=60)

# Debrid cache: 5 min TTL - link availability doesn't change often
debrid_cache = TTLCache(name="DebridCache", default_ttl=300)

# Request guard for search requests - rejects duplicate in-flight searches
search_guard = RequestGuard(name="SearchGuard")

