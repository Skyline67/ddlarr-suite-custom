"""
AllDebrid integration module for Darkiworld Scraper
Handles link debriding via AllDebrid API.
"""

import logging
from typing import Optional
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests
from config import ALLDEBRID_API_KEY, ALLDEBRID_API_URL
from cache import debrid_cache

logger = logging.getLogger(__name__)

# AllDebrid API endpoints
ALLDEBRID_INFOS_URL = 'https://api.alldebrid.com/v4/link/infos'

def check_link_availability(link: str) -> bool:
    """
    Check if a link is available (not 404) via HTTP GET

    Args:
        link: The download link to check

    Returns:
        True if link is available (status < 400), False otherwise
    """
    if not link:
        return False

    try:
        logger.info(f"Checking availability: {link[:50]}...")

        response = requests.head(
            link,
            allow_redirects=True,
            timeout=10
        )

        # Check status code
        if response.status_code == 405:
            # HEAD not allowed, try GET with range header
            response = requests.get(
                link,
                headers={'Range': 'bytes=0-0'},
                allow_redirects=True,
                timeout=10,
                stream=True
            )

        if response.status_code == 404:
            logger.warning(f"⚠️ Link is dead (404): {link[:50]}...")
            return False
        elif response.status_code >= 400:
            logger.warning(f"⚠️ Link returned error {response.status_code}: {link[:50]}...")
            return False

        logger.info(f"✓ Link is available (status {response.status_code})")
        return True

    except requests.exceptions.Timeout:
        logger.error(f"❌ Timeout checking link: {link[:50]}...")
        return False
    except requests.exceptions.RequestException as e:
        logger.error(f"❌ Error checking link: {e}")
        return False
    except Exception as e:
        logger.error(f"❌ Unexpected error checking link: {e}")
        return False


def check_links_and_get_filenames(links: dict, chunk_size: int = 10) -> tuple[dict, dict]:
    """
    Combined function: Check availability AND get exact filenames via AllDebrid API
    Uses chunked batch calls to avoid timeouts on large requests
    
    Args:
        links: Dictionary mapping release_id -> download link
        chunk_size: Number of links per AllDebrid batch call (default 10)
        
    Returns:
        Tuple of (available_links, exact_filenames):
        - available_links: Dictionary mapping release_id -> download link (only available ones)
        - exact_filenames: Dictionary mapping download_link -> exact filename (without extension)
    """
    if not links:
        return {}, {}

    # Check cache first for each link
    cached_available = {}
    cached_filenames = {}
    uncached_links = {}
    
    for release_id, link in links.items():
        cached = debrid_cache.get(link)
        if cached is not None:
            # cached is tuple: (is_available, filename_or_none)
            is_available, filename = cached
            if is_available:
                cached_available[release_id] = link
                if filename:
                    cached_filenames[link] = filename
        else:
            uncached_links[release_id] = link
    
    if cached_available:
        logger.info(f"✅ Cache hit for {len(cached_available)}/{len(links)} links")
    
    # If all links are cached, return immediately
    if not uncached_links:
        logger.info(f"✅ All {len(links)} links were cached, skipping AllDebrid API")
        return cached_available, cached_filenames
    
    logger.info(f"🔍 Checking {len(uncached_links)} uncached links via AllDebrid...")

    # Try using AllDebrid batch API first (much more efficient)
    if ALLDEBRID_API_KEY:
        # Create reverse mapping: link -> release_id
        link_to_id = {link: release_id for release_id, link in uncached_links.items()}
        links_list = list(uncached_links.values())
        
        # Split into chunks
        chunks = [links_list[i:i + chunk_size] for i in range(0, len(links_list), chunk_size)]
        logger.info(f"🔍 Checking {len(uncached_links)} links via AllDebrid in {len(chunks)} chunk(s) of max {chunk_size}...")

        
        all_available_links = {}
        all_exact_filenames = {}
        failed_links = []  # Links that failed in AllDebrid (for fallback)
        
        def process_chunk(chunk_links: list) -> tuple[dict, dict, list]:
            """Process a single chunk of links via AllDebrid API"""
            chunk_available = {}
            chunk_filenames = {}
            chunk_failed = []
            
            try:
                form_data = [('link[]', link) for link in chunk_links]
                
                response = requests.post(
                    ALLDEBRID_INFOS_URL,
                    headers={
                        'Authorization': f'Bearer {ALLDEBRID_API_KEY}',
                        'Accept': 'application/json'
                    },
                    data=form_data,
                    timeout=30
                )
                
                data = response.json()
                
                if data.get('status') == 'success':
                    infos = data.get('data', {}).get('infos', [])
                    
                    for info in infos:
                        link = info.get('link')
                        filename = info.get('filename')
                        error = info.get('error')
                        
                        if error:
                            error_code = error.get('code')
                            if error_code == 'LINK_DOWN':
                                logger.debug(f"Link is dead: {link[:30]}...")
                                # Cache dead link as unavailable
                                debrid_cache.set(link, (False, None))
                            else:
                                logger.warning(f"Link error {error_code}: {link[:30]}...")
                            continue

                        if link and link in link_to_id:
                            release_id = link_to_id[link]
                            chunk_available[release_id] = link
                            
                            name_without_ext = None
                            if filename:
                                name_without_ext = filename.rsplit('.', 1)[0] if '.' in filename else filename
                                chunk_filenames[link] = name_without_ext
                            
                            # Cache available link with filename
                            debrid_cache.set(link, (True, name_without_ext))
                else:
                    # Batch failed, add all links to failed list for fallback
                    chunk_failed = chunk_links
                    
            except Exception as e:
                logger.warning(f"AllDebrid chunk error: {e}")
                chunk_failed = chunk_links
            
            return chunk_available, chunk_filenames, chunk_failed
        
        # Process chunks in parallel (max 3 concurrent to avoid rate limiting)
        with ThreadPoolExecutor(max_workers=3) as executor:
            futures = {executor.submit(process_chunk, chunk): chunk for chunk in chunks}
            
            for future in as_completed(futures):
                try:
                    chunk_available, chunk_filenames, chunk_failed = future.result()
                    all_available_links.update(chunk_available)
                    all_exact_filenames.update(chunk_filenames)
                    failed_links.extend(chunk_failed)
                except Exception as e:
                    logger.error(f"Error processing chunk: {e}")
                    failed_links.extend(futures[future])
        
        # If some chunks failed, do fallback for those links only
        if failed_links:
            logger.info(f"⚠️ {len(failed_links)} links need fallback check...")
            fallback_links = {link_to_id[link]: link for link in failed_links if link in link_to_id}
            fallback_available, _ = _check_links_parallel(fallback_links)
            all_available_links.update(fallback_available)
        
        # Merge with cached results
        all_available_links.update(cached_available)
        all_exact_filenames.update(cached_filenames)
        
        logger.info(f"✅ {len(all_available_links)}/{len(links)} links available, {len(all_exact_filenames)} filenames retrieved")
        return all_available_links, all_exact_filenames
    
    # No AllDebrid API key: use parallel HTTP fallback
    fallback_available, _ = _check_links_parallel(uncached_links)
    
    # Cache fallback results (no filenames available)
    for release_id, link in uncached_links.items():
        is_available = release_id in fallback_available
        debrid_cache.set(link, (is_available, None))
    
    # Merge with cached
    fallback_available.update(cached_available)
    return fallback_available, cached_filenames


def _check_links_parallel(links: dict) -> tuple[dict, dict]:
    """
    Fallback: Check links availability in parallel via HTTP
    
    Args:
        links: Dictionary mapping release_id -> download link
        
    Returns:
        Tuple of (available_links, empty dict for filenames)
    """
    logger.info(f"🔍 Checking availability of {len(links)} links in parallel...")
    
    available_links = {}
    
    def check_single_link(item):
        """Check a single link and return (release_id, link, is_available)"""
        release_id, link = item
        if not link:
            return (release_id, link, False)
        return (release_id, link, check_link_availability(link))
    
    # Use ThreadPoolExecutor for parallel checks (max 5 concurrent to avoid rate limiting)
    with ThreadPoolExecutor(max_workers=5) as executor:
        futures = {executor.submit(check_single_link, (rid, lnk)): rid for rid, lnk in links.items()}
        
        for future in as_completed(futures):
            try:
                release_id, link, is_available = future.result()
                if is_available:
                    available_links[release_id] = link
            except Exception as e:
                logger.error(f"Error in parallel check: {e}")
    
    logger.info(f"✅ {len(available_links)}/{len(links)} links are available (parallel checks)")
    return available_links, {}  # No filenames without AllDebrid

