"""
AllDebrid integration module for Darkiworld Scraper
Handles link debriding via AllDebrid API.
"""

import logging
from typing import Optional
import requests
from config import ALLDEBRID_API_KEY, ALLDEBRID_API_URL

logger = logging.getLogger(__name__)

# AllDebrid API endpoints
ALLDEBRID_INFOS_URL = 'https://api.alldebrid.com/v4/link/infos'


def debrid_link(link: str) -> Optional[str]:
    """
    Debrid a single link using AllDebrid API
    
    Args:
        link: The original download link to debrid
        
    Returns:
        Debrided link URL or None if failed/link is down
    """
    if not ALLDEBRID_API_KEY:
        logger.warning("⚠️ ALLDEBRID_KEY not configured in .env")
        return None
    
    if not link:
        return None
    
    try:
        logger.info(f"Debriding link: {link[:50]}...")
        
        response = requests.get(
            ALLDEBRID_API_URL,
            params={'link': link, 'agent': 'darkiworld-scraper'},
            headers={
                'Authorization': f'Bearer {ALLDEBRID_API_KEY}',
                'Accept': 'application/json'
            },
            timeout=30
        )
        
        data = response.json()
        
        # Check for API errors
        if data.get('status') != 'success':
            error = data.get('error', {})
            error_code = error.get('code', 'UNKNOWN')
            error_message = error.get('message', 'Unknown error')
            
            # LINK_DOWN means the file is no longer available
            if error_code == 'LINK_DOWN':
                logger.warning(f"⚠️ Link is down (unavailable): {link[:50]}...")
                return None
            
            logger.error(f"❌ AllDebrid API error: {error_code} - {error_message}")
            return None
        
        # Extract debrided link
        debrided_data = data.get('data', {})
        debrided_link = debrided_data.get('link')
        
        if debrided_link:
            logger.info(f"✓ Successfully debrided link")
            return debrided_link
        else:
            logger.warning(f"⚠️ No debrided link in response")
            return None
            
    except requests.exceptions.Timeout:
        logger.error(f"❌ AllDebrid API timeout for link: {link[:50]}...")
        return None
    except requests.exceptions.RequestException as e:
        logger.error(f"❌ AllDebrid API request error: {e}")
        return None
    except Exception as e:
        logger.error(f"❌ Error debriding link: {e}")
        return None


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


def check_links_availability(links: dict) -> dict:
    """
    Check availability of multiple links via HTTP GET

    Args:
        links: Dictionary mapping release_id -> download link

    Returns:
        Dictionary mapping release_id -> download link (only available ones)
    """
    available = {}

    logger.info(f"🔍 Checking availability of {len(links)} links...")

    for release_id, link in links.items():
        if not link:
            continue

        if check_link_availability(link):
            available[release_id] = link
        # Links that are dead (404) or error are not included in result

    logger.info(f"✅ {len(available)}/{len(links)} links are available")
    return available


def check_links_and_get_filenames(links: dict) -> tuple[dict, dict]:
    """
    Combined function: Check availability AND get exact filenames in ONE batch AllDebrid API call
    This is more efficient than calling check_links_availability() and get_exact_filenames_from_alldebrid_batch() separately
    
    Args:
        links: Dictionary mapping release_id -> download link
        
    Returns:
        Tuple of (available_links, exact_filenames):
        - available_links: Dictionary mapping release_id -> download link (only available ones)
        - exact_filenames: Dictionary mapping download_link -> exact filename (without extension)
    """
    if not links:
        return {}, {}

    # Try using AllDebrid batch API first (much more efficient)
    if ALLDEBRID_API_KEY:
        logger.info(f"🔍 Checking availability AND getting filenames for {len(links)} links in ONE AllDebrid batch call...")
        
        try:
            # Prepare form data with all links
            links_list = list(links.values())
            form_data = [('link[]', link) for link in links_list]
            
            # Create reverse mapping: link -> release_id
            link_to_id = {link: release_id for release_id, link in links.items()}
            
            # Call AllDebrid API ONCE for both availability and filenames
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
            
            # Check for success
            if data.get('status') == 'success':
                available_links = {}
                exact_filenames = {}
                infos = data.get('data', {}).get('infos', [])
                
                for info in infos:
                    link = info.get('link')
                    filename = info.get('filename')
                    error = info.get('error')
                    
                    # Check if link is dead or has error
                    if error:
                        error_code = error.get('code')
                        if error_code == 'LINK_DOWN':
                            logger.debug(f"Link is dead: {link[:30]}...")
                            continue
                        logger.warning(f"Link error {error_code}: {link[:30]}...")
                        # We skip available_links assignment for errors
                        continue

                    # If no error and we have the link, it is available
                    if link and link in link_to_id:
                        release_id = link_to_id[link]
                        available_links[release_id] = link
                        
                        # Also extract filename if available
                        if filename:
                            name_without_ext = filename.rsplit('.', 1)[0] if '.' in filename else filename
                            exact_filenames[link] = name_without_ext
                
                logger.info(f"✅ {len(available_links)}/{len(links)} links available, {len(exact_filenames)} filenames retrieved (ONE batch call)")
                return available_links, exact_filenames
            else:
                logger.warning(f"AllDebrid batch check failed, falling back to individual checks")
                
        except Exception as e:
            logger.warning(f"AllDebrid batch check error: {e}, falling back to individual checks")
    
    # Fallback: individual HTTP checks (slower, no exact filenames)
    logger.info(f"🔍 Checking availability of {len(links)} links individually (no AllDebrid)...")
    
    available_links = {}
    for release_id, link in links.items():
        if not link:
            continue
        if check_link_availability(link):
            available_links[release_id] = link
    
    logger.info(f"✅ {len(available_links)}/{len(links)} links are available (individual checks)")
    return available_links, {}  # No filenames without AllDebrid


def debrid_links(links: dict) -> dict:
    """
    Debrid multiple links using AllDebrid API

    Args:
        links: Dictionary mapping release_id -> download link

    Returns:
        Dictionary mapping release_id -> debrided link (only successful ones)
    """
    debrided = {}

    if not ALLDEBRID_API_KEY:
        logger.warning("⚠️ ALLDEBRID_KEY not configured - skipping debrid")
        return links  # Return original links if no API key

    logger.info(f"🔓 Debriding {len(links)} links with AllDebrid...")

    for release_id, link in links.items():
        if not link:
            continue

        debrided_result = debrid_link(link)

        if debrided_result:
            debrided[release_id] = debrided_result
        # Links that fail (including LINK_DOWN) are not included in result

    logger.info(f"✅ Successfully debrided {len(debrided)}/{len(links)} links")
    return debrided
