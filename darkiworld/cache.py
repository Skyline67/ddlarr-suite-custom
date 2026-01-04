"""
TTL-based cache module for Darkiworld Scraper
Prevents redundant API calls from Sonarr's double-request behavior.
"""

import time
import threading
import logging
from typing import Any, Optional, Callable

logger = logging.getLogger(__name__)


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

