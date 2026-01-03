"""
Scraping module for Darkiworld Scraper
Contains main scraping and search functionality.
"""

import os
import time
import re
import logging
import threading
from datetime import datetime
from urllib.parse import urlparse, quote, unquote
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

from config import DARKIWORLD_URL, ALLOWED_HOSTER, DARKIWORLD_EMAIL, DARKIWORLD_PASSWORD
from driver_sb import get_driver, close_driver
from auth_sb import ensure_authenticated
from utils import parse_relative_date, build_release_name
from debrid import check_links_availability

logger = logging.getLogger(__name__)


def parse_releases_table(driver) -> list:
    """
    Parse the releases table from the download page
    Returns a list of release dictionaries with details
    """
    releases = []

    try:
        # Find the table
        table = driver.find_element(By.CSS_SELECTOR, 'table[role="grid"]')

        # Find all rows in tbody (skip header)
        rows = table.find_elements(By.CSS_SELECTOR, 'tbody > tr[role="row"]')

        logger.info(f"Found {len(rows)} rows in releases table")

        for idx, row in enumerate(rows):
            try:
                release = {}

                # Extract data from each column
                cells = row.find_elements(By.CSS_SELECTOR, 'td[role="gridcell"]')

                if len(cells) < 7:
                    logger.warning(f"Row {idx} has {len(cells)} cells, expected 7")
                    continue

                # Column 0: Taille (Size)
                size_text = cells[0].text.strip()
                release['size'] = size_text if size_text and size_text != '-' else None

                # Column 1: Qualité (Quality)
                quality_elem = cells[1].find_elements(By.CSS_SELECTOR, 'div.flex-auto')
                release['quality'] = quality_elem[0].text.strip() if quality_elem else None

                # Column 2: Langues (Languages)
                lang_elems = cells[2].find_elements(By.CSS_SELECTOR, 'div.flex-auto')
                languages = [elem.text.strip() for elem in lang_elems]

                # Check for "+X plus" button
                plus_btn = cells[2].find_elements(By.CSS_SELECTOR, 'button')
                if plus_btn:
                    plus_text = plus_btn[0].text.strip()
                    languages.append(plus_text)

                release['languages'] = languages if languages else []

                # Column 3: Sous-titres (Subtitles)
                sub_elems = cells[3].find_elements(By.CSS_SELECTOR, 'div.flex-auto')
                subtitles = [elem.text.strip() for elem in sub_elems]
                release['subtitles'] = subtitles if subtitles else []

                # Column 5: Ajouté (Added date)
                release['added'] = cells[5].text.strip()

                # Column 6: Actions (Download host)
                host_img = cells[6].find_elements(By.CSS_SELECTOR, 'button img')
                if host_img:
                    host_alt = host_img[0].get_attribute('alt')
                    release['host'] = host_alt
                else:
                    release['host'] = None

                releases.append(release)
                logger.debug(f"Parsed release {idx + 1}: {release['quality']} - {release['host']}")

            except Exception as e:
                logger.warning(f"Error parsing row {idx}: {e}")
                continue

    except Exception as e:
        logger.error(f"Error parsing releases table: {e}")

    return releases


def filter_and_sort_releases(releases: list, allowed_hosters: list, limit: int = 10) -> list:
    """
    Filter releases by allowed hosters and return top N most recent

    Args:
        releases: List of release dictionaries
        allowed_hosters: List of allowed hoster names (lowercase)
        limit: Maximum number of releases to return

    Returns:
        Filtered and sorted list of releases
    """
    if not allowed_hosters:
        logger.warning("⚠️ No allowed hosters configured - returning all releases")
        filtered = releases
    else:
        # Filter by host
        filtered = []
        for release in releases:
            host = release.get('host', '')
            if not host:
                logger.debug(f"Skipping release with no host")
                continue

            # Normalize host for comparison
            host_normalized = host.lower().strip()

            # Check if host matches any allowed hoster
            is_allowed = any(
                allowed in host_normalized
                for allowed in allowed_hosters
            )

            if is_allowed:
                filtered.append(release)
            else:
                logger.debug(f"Filtered out release with host: {host}")

        logger.info(f"Filtered {len(releases)} releases -> {len(filtered)} matching allowed hosters")

    # Sort by date (most recent first)
    try:
        filtered_sorted = sorted(
            filtered,
            key=lambda r: parse_relative_date(r.get('added', '')),
            reverse=True  # Highest timestamp first (most recent)
        )
        logger.info(f"Sorted releases by date (most recent first)")
    except Exception as e:
        logger.warning(f"Error sorting releases by date: {e}")
        filtered_sorted = filtered

    # Limit to top N
    result = filtered_sorted[:limit]
    logger.info(f"Returning top {len(result)} most recent releases (limit: {limit})")

    return result


def get_download_links(sb, release_ids: list) -> dict:
    """
    Get download links for releases by calling the API

    Args:
        sb: SeleniumBase instance with cookies
        release_ids: List of release IDs to get links for

    Returns:
        Dictionary mapping release_id -> download link
    """
    links = {}

    for release_id in release_ids:
        try:
            logger.info(f"Getting download link for release {release_id}...")

            # Use JavaScript fetch to call the API with existing cookies (using sb instead of driver)
            # IMPORTANT: Manually extract XSRF-TOKEN from cookies and add to headers
            # This is often required for Laravel implementations where fetch doesn't auto-add the header
            result = sb.execute_script(f"""
                function getCookie(name) {{
                    const value = `; ${{document.cookie}}`;
                    const parts = value.split(`; ${{name}}=`);
                    if (parts.length === 2) return decodeURIComponent(parts.pop().split(';').shift());
                }}
                
                const xsrfToken = getCookie('XSRF-TOKEN');
                
                return fetch('/api/v1/liens/{release_id}/download', {{
                    method: 'POST',
                    headers: {{
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'X-XSRF-TOKEN': xsrfToken || ''
                    }},
                    body: JSON.stringify({{ token: "" }})
                }})
                .then(response => response.json())
                .then(data => data)
                .catch(error => ({{ error: error.toString() }}));
            """)

            # Log full response for debugging
            logger.info(f"API Response for release {release_id}: {result}")
            
            if result and 'lien' in result:
                download_link = result['lien'].get('lien')
                if download_link:
                    links[release_id] = download_link
                    logger.info(f"✓ Got download link for release {release_id}")
                else:
                    logger.warning(f"⚠️ No download link in response for release {release_id}")
            else:
                logger.warning(f"⚠️ Failed to get download link for release {release_id}: {result}")

        except Exception as e:
            logger.error(f"Error getting download link for release {release_id}: {e}")

    return links


def scrape_darkiworld(data: dict = None) -> dict:
    """
    Main scraping function with Cloudflare bypass and cookie management
    """
    if data is None:
        data = {}

    try:
        sb = get_driver()
        driver = sb.driver  # Get underlying Selenium driver for compatibility
        logger.info(f"Opening {DARKIWORLD_URL}")

        # Ensure authentication (load cookies or login if necessary)
        logger.info("Authenticating...")
        authenticated = ensure_authenticated(sb, DARKIWORLD_URL, DARKIWORLD_EMAIL, DARKIWORLD_PASSWORD)

        if not authenticated:
            logger.error("❌ Authentication failed - cannot proceed")
            return {
                'success': False,
                'error': 'Authentication failed',
                'authenticated': False
            }

        logger.info("✅ Authentication successful")

        # Human-like behavior: random mouse movements
        try:
            driver.execute_script("""
                function randomMouseMove() {
                    const event = new MouseEvent('mousemove', {
                        view: window,
                        bubbles: true,
                        cancelable: true,
                        clientX: Math.random() * window.innerWidth,
                        clientY: Math.random() * window.innerHeight
                    });
                    document.dispatchEvent(event);
                }
                for (let i = 0; i < 5; i++) {
                    setTimeout(randomMouseMove, i * 100);
                }
            """)
            logger.debug("Simulated mouse movements")
        except Exception as e:
            logger.debug(f"Could not simulate mouse: {e}")

        # Wait for page to be ready
        WebDriverWait(driver, 10).until(
            lambda d: d.execute_script("return document.readyState") == "complete"
        )

        # Check authentication status by looking for username element
        logger.info("Checking authentication status...")
        username = None

        try:
            # Wait a bit for the username element to appear if logged in
            time.sleep(1)

            # Check for login/register buttons (indicates NOT logged in)
            has_login_buttons = driver.execute_script("""
                const bodyText = document.body.innerText.toLowerCase();
                return bodyText.includes("s'inscrire") && bodyText.includes("connexion");
            """)

            if has_login_buttons:
                logger.error("❌ NOT AUTHENTICATED - Login/Register buttons detected")
                logger.error("The page shows 'S'inscrire' and 'Connexion' - cookies are invalid/expired")
            else:
                logger.info("✓ No login buttons detected - checking for username...")

                # Try to find username element using various methods
                username = driver.execute_script("""
                    // Method 1: Look for buttons with specific patterns that might contain username
                    let found = null;

                    // Try buttons that might be user menus
                    const buttons = document.querySelectorAll('button');
                    for (const btn of buttons) {
                        const text = btn.innerText.trim();
                        // Skip empty, "S'inscrire", "Connexion" buttons
                        if (text &&
                            text.length > 2 &&
                            !text.toLowerCase().includes('inscrire') &&
                            !text.toLowerCase().includes('connexion') &&
                            !text.toLowerCase().includes('recherch') &&
                            btn.querySelector('span')) {

                            // Check if button has nested spans (common for user menus)
                            const spans = btn.querySelectorAll('span');
                            if (spans.length > 0) {
                                found = spans[0].innerText.trim();
                                if (found && found.length > 2) {
                                    return found;
                                }
                            }
                        }
                    }

                    // Method 2: Look for common auth patterns
                    const authSelectors = [
                        '[data-testid="username"]',
                        '[data-testid="user-menu"]',
                        '.user-name',
                        '.username',
                        'a[href*="/profile"]',
                        'a[href*="/user"]',
                        '[aria-label*="user" i]'
                    ];

                    for (const selector of authSelectors) {
                        const el = document.querySelector(selector);
                        if (el && el.innerText && el.innerText.trim().length > 2) {
                            return el.innerText.trim();
                        }
                    }

                    return null;
                """)

                if username:
                    logger.info(f"✅ AUTHENTICATED as: '{username}'")
                else:
                    logger.warning("⚠️ Could not find username element")

        except Exception as e:
            logger.error(f"Error checking authentication: {e}")
            username = None

        # Human-like behavior: scroll randomly
        try:
            driver.execute_script("window.scrollTo(0, 100);")
            time.sleep(0.5)
            driver.execute_script("window.scrollTo(0, 0);")
            logger.debug("Simulated scrolling behavior")
        except Exception as e:
            logger.debug(f"Could not simulate scroll: {e}")

        # Wait for NoScript element to disappear (sign that JS has taken over)
        logger.info("Waiting for JavaScript to fully render page content...")

        max_wait = 30
        for i in range(max_wait):
            try:
                # Check if noscript message is still visible
                noscript_visible = driver.execute_script("""
                    const text = document.body.innerText.toLowerCase();
                    return text.includes('you need to have javascript enabled');
                """)

                if not noscript_visible:
                    logger.info(f"✓ NoScript content replaced after {i+1} seconds")
                    break

                if i % 5 == 0:
                    logger.info(f"Still waiting for content to load... ({i+1}s)")
            except Exception as e:
                logger.debug(f"Error checking noscript: {e}")
                break

        time.sleep(1)

        # Check if page content has loaded beyond noscript
        try:
            body_content = driver.execute_script("return document.body.innerText.length")
            logger.info(f"Page content length: {body_content} characters")
            if body_content < 500:
                logger.warning("⚠️ Very little content detected - possible blocking")
        except Exception as e:
            logger.debug(f"Could not check content length: {e}")

        # Diagnostic logs for JavaScript detection
        try:
            js_checks = driver.execute_script("""
                return {
                    webdriver: navigator.webdriver,
                    plugins: navigator.plugins.length,
                    languages: navigator.languages,
                    platform: navigator.platform,
                    userAgent: navigator.userAgent,
                    hasChrome: typeof window.chrome !== 'undefined',
                    documentReady: document.readyState,
                    vendor: navigator.vendor,
                    hardwareConcurrency: navigator.hardwareConcurrency,
                    deviceMemory: navigator.deviceMemory,
                    connection: navigator.connection ? navigator.connection.effectiveType : 'N/A',
                    // Check for automation detection properties
                    hasAutomationProperty: typeof navigator.webdriver !== 'undefined',
                    hasCDC: typeof window.cdc_adoQpoasnfa76pfcZLmcfl_Array !== 'undefined',
                    hasCallPhantom: typeof window.callPhantom !== 'undefined',
                    hasPhantom: typeof window._phantom !== 'undefined'
                };
            """)
            logger.info(f"JavaScript environment check: {js_checks}")

            if js_checks.get('webdriver'):
                logger.warning("⚠️ navigator.webdriver is TRUE - bot detected!")
            else:
                logger.info("✓ navigator.webdriver is hidden")

            if js_checks.get('hasCDC'):
                logger.warning("⚠️ CDC properties detected!")
            else:
                logger.info("✓ No CDC automation markers")

        except Exception as e:
            logger.error(f"Failed to run JavaScript checks: {e}")

        page_title = driver.title
        current_url = driver.current_url

        logger.info(f"Page loaded - Title: {page_title}, URL: {current_url}")

        # Get page HTML AFTER waiting for content to load
        page_html = driver.page_source

        # Check if Cloudflare challenge is present
        is_cloudflare_challenge = (
            'Checking your browser' in page_html or
            'Just a moment' in page_html or
            'cf-browser-verification' in page_html or
            'ray id' in page_html.lower()
        )

        # Check for JavaScript requirement using execute_script (more reliable than page_source)
        try:
            is_noscript_block = driver.execute_script("""
                const text = document.body.innerText.toLowerCase();
                return text.includes('you need to have javascript enabled');
            """)
            logger.info(f"NoScript check via JavaScript: {is_noscript_block}")
        except:
            # Fallback to checking page source
            is_noscript_block = 'You need to have javascript enabled' in page_html
            logger.info(f"NoScript check via page_source: {is_noscript_block}")

        if is_cloudflare_challenge:
            logger.warning("⚠️ Cloudflare challenge detected - waiting longer...")
            time.sleep(10)
            page_html = driver.page_source
            is_cloudflare_challenge = 'Checking your browser' in page_html

            if is_cloudflare_challenge:
                logger.error("❌ Still blocked by Cloudflare after waiting")
            else:
                logger.info("✓ Cloudflare challenge resolved!")
        else:
            logger.info("✓ Successfully bypassed Cloudflare!")

        if is_noscript_block:
            logger.error("❌ NoScript block detected - JavaScript may not be executing properly")
            logger.error("This could indicate bot detection or JS not running before page load")

            # Try to verify if JS is actually running
            try:
                test_js = driver.execute_script("return document.body !== null")
                if test_js:
                    logger.info("✓ JavaScript IS running - this is a bot detection issue")
                    logger.warning("🔴 The site is actively blocking automated access despite ALL stealth measures")

                    # Check what the actual body content is
                    try:
                        body_text = driver.execute_script("return document.body.innerText")
                        logger.info(f"Body content preview: {body_text[:500]}")

                        # Check for specific anti-bot messages
                        if 'javascript enabled' in body_text.lower():
                            logger.error("Site requires JavaScript but is detecting automation")
                        if 'cloudflare' in body_text.lower():
                            logger.error("Cloudflare challenge still present")
                    except:
                        pass
                else:
                    logger.error("❌ JavaScript NOT running properly")
            except:
                logger.error("❌ Cannot execute JavaScript at all")
        else:
            logger.info("✓ No NoScript block detected - JavaScript appears to be working")

            # Log first bit of actual content to verify success
            try:
                content_preview = driver.execute_script("return document.body.innerText.substring(0, 200)")
                logger.info(f"Content preview: {content_preview}")
            except:
                pass

        # Save complete HTML to file (both source and rendered)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_dir = os.path.join(os.getcwd(), 'output')
        os.makedirs(output_dir, exist_ok=True)

        # Save page source (initial HTML)
        html_filename = f"darkiworld_page_source_{timestamp}.html"
        html_filepath = os.path.join(output_dir, html_filename)
        with open(html_filepath, 'w', encoding='utf-8') as f:
            f.write(page_html)
        logger.info(f"Saved page source to: {html_filepath}")

        # Save rendered HTML (after JavaScript execution)
        try:
            rendered_html = driver.execute_script("return document.documentElement.outerHTML")
            rendered_filename = f"darkiworld_page_rendered_{timestamp}.html"
            rendered_filepath = os.path.join(output_dir, rendered_filename)
            with open(rendered_filepath, 'w', encoding='utf-8') as f:
                f.write(rendered_html)
            logger.info(f"✓ Saved RENDERED HTML (after JS) to: {rendered_filepath}")
        except Exception as e:
            logger.warning(f"Could not save rendered HTML: {e}")
            rendered_filepath = html_filepath

        # Get cookies
        cookies = driver.get_cookies()

        # Use rendered HTML for preview (the real content after JS)
        try:
            html_preview = driver.execute_script("return document.body.innerText.substring(0, 1000)")
        except:
            html_preview = page_html[:1000]

        return {
            'success': True,
            'url': current_url,
            'title': page_title,
            'authenticated': username is not None,
            'username': username,
            'cookies': cookies,
            'html_file_source': html_filepath,
            'html_file_rendered': rendered_filepath,
            'html_preview': html_preview,
            'cloudflare_detected': is_cloudflare_challenge,
            'noscript_detected': is_noscript_block
        }

    except Exception as e:
        logger.error(f"Error scraping darkiworld: {str(e)}", exc_info=True)
        return {
            'success': False,
            'error': str(e)
        }


def search_darkiworld(data: dict) -> dict:
    """
    Search function for darkiworld - uses direct search URL and API
    """
    query = data.get('name', data.get('query', ''))

    if not query:
        return {
            'success': False,
            'error': 'Query/name parameter is required'
        }

    try:
        sb = get_driver()
        driver = sb.driver  # Keep reference for compatibility with existing code
        logger.info(f"🔍 Searching for: '{query}'")

        # Ensure authentication (load cookies or login if necessary)
        logger.info("Authenticating...")
        authenticated = ensure_authenticated(sb, DARKIWORLD_URL, DARKIWORLD_EMAIL, DARKIWORLD_PASSWORD)

        if not authenticated:
            logger.error("❌ Authentication failed - cannot perform search")
            return {
                'success': False,
                'error': 'Authentication failed - login required to search',
                'authenticated': False
            }

        logger.info("✅ Authenticated - proceeding with search")

        # Build search URL with encoded query
        encoded_query = quote(query)
        search_url = f"{DARKIWORLD_URL}search/{encoded_query}"
        logger.info(f"Navigating to search page: {search_url}")

        # Use SeleniumBase's open method instead of driver.get()
        sb.open(search_url)

        # Wait for page to load (using sb instead of driver)
        sb.wait_for_ready_state_complete()

        # Find the grid and first result
        logger.info("Looking for search results grid...")
        try:
            # Use sb.wait_for_element instead of WebDriverWait
            sb.wait_for_element('div.grid.gap-24.content-grid-portrait', timeout=10)
            grid = sb.find_element('div.grid.gap-24.content-grid-portrait')
            logger.info("✓ Found search results grid")
        except Exception as e:
            logger.error(f"❌ Search results grid not found: {e}")
            return {
                'success': False,
                'error': 'No search results found',
                'query': query,
                'authenticated': True
            }

        # Get first result
        try:
            first_result = grid.find_element(By.CSS_SELECTOR, 'div > div')

            # Extract title ID from href
            link_elem = first_result.find_element(By.CSS_SELECTOR, 'a[href*="/titles/"]')
            href = link_elem.get_attribute('href')

            # Parse ID from href like "/titles/161640/wake-up-dead-man-..."
            match = re.search(r'/titles/(\d+)/', href)
            if not match:
                raise Exception(f"Could not extract ID from href: {href}")

            media_id = match.group(1)

            # Try to get title from alt attribute or other sources
            try:
                img = first_result.find_element(By.TAG_NAME, 'img')
                media_title = img.get_attribute('alt').replace('Poster for ', '')
            except:
                media_title = query  # Fallback to query

            logger.info(f"✓ First result: '{media_title}' (ID: {media_id})")

        except Exception as e:
            logger.error(f"❌ Error extracting first result: {e}")
            return {
                'success': False,
                'error': f'Could not extract first result: {str(e)}',
                'query': query,
                'authenticated': True
            }

        # Call API to get releases
        logger.info(f"Fetching releases from API for title {media_id}...")
        try:
            api_url = f"/api/v1/liens?perPage=60&title_id={media_id}&loader=linksdl&season=1&filters=&paginate=preferLengthAware"

            # Use JavaScript fetch to call API with existing cookies (using sb instead of driver)
            api_response = sb.execute_script(f"""
                return fetch('{api_url}', {{
                    method: 'GET',
                    headers: {{
                        'Accept': 'application/json'
                    }}
                }})
                .then(response => response.json())
                .then(data => data)
                .catch(error => ({{ error: error.toString() }}));
            """)

            if 'error' in api_response:
                raise Exception(f"API error: {api_response['error']}")

            if 'pagination' not in api_response or 'data' not in api_response['pagination']:
                raise Exception(f"Unexpected API response format: {api_response}")

            raw_releases = api_response['pagination']['data']
            logger.info(f"✓ Got {len(raw_releases)} releases from API")

        except Exception as e:
            logger.error(f"❌ Error calling API: {e}")
            return {
                'success': False,
                'error': f'Failed to fetch releases: {str(e)}',
                'query': query,
                'media_id': media_id,
                'authenticated': True
            }

        # Parse releases from API response
        releases = []
        for item in raw_releases:
            try:
                release = {
                    'id': item['id'],
                    'size': item['taille'] if item['taille'] else None,  # Size in bytes
                    'quality': item['qual']['qual'] if item.get('qual') else None,
                    'languages': [lang['name'] for lang in item.get('langues_compact', [])],
                    'subtitles': [sub['name'] for sub in item.get('subs_compact', [])],
                    'uploader': item.get('id_user'),
                    'added': item.get('created_at', ''),
                    'host': item['host']['name'] if item.get('host') else None,
                    'views': item.get('view', 0)
                }

                releases.append(release)

            except Exception as e:
                logger.warning(f"Error parsing release: {e}")
                continue

        logger.info(f"✅ Parsed {len(releases)} total releases")

        # Filter and sort releases
        # Fetch more candidates (50) than needed (25) to account for dead links
        target_limit = 25
        buffer_limit = 50
        
        logger.info(f"Filtering by allowed hosters: {ALLOWED_HOSTER}")
        filtered_releases = filter_and_sort_releases(
            releases,
            allowed_hosters=ALLOWED_HOSTER,
            limit=buffer_limit
        )

        # Get download links for filtered releases
        release_ids = [r['id'] for r in filtered_releases]
        logger.info(f"Getting download links for {len(release_ids)} releases (buffer for dead links)...")
        release_ids = [r['id'] for r in filtered_releases]
        logger.info(f"Getting download links for {len(release_ids)} releases (buffer for dead links)...")
        
        # Add a small delay before starting download loop to avoid rate limits
        time.sleep(2)
        
        download_links = get_download_links(sb, release_ids)

        # Check availability AND get exact filenames in ONE batch AllDebrid call
        # This is much more efficient than separate calls
        from debrid import check_links_and_get_filenames
        available_links, exact_filenames_by_link = check_links_and_get_filenames(download_links)

        # Add available links to releases and filter out dead ones
        valid_releases = []
        for release in filtered_releases:
            download_link = available_links.get(release['id'])
            if download_link:
                # Get exact filename from batch result, or build name from metadata
                exact_filename = exact_filenames_by_link.get(download_link)
                
                name = build_release_name(
                    media_title=media_title,
                    quality=release.get('quality'),
                    languages=release.get('languages', []),
                    exact_filename=exact_filename  # Use pre-fetched filename from batch call
                )

                # Create clean DTO with only required fields
                release_dto = {
                    'name': name,
                    'added': release.get('added'),
                    'download_link': download_link,
                    'languages': release.get('languages', []),
                    'size': release.get('size'),
                    'subtitles': release.get('subtitles', [])
                }

                valid_releases.append(release_dto)
                
                # Stop once we have enough valid releases
                if len(valid_releases) >= target_limit:
                    break
            else:
                logger.debug(f"Excluding release {release['id']} - link is dead or unavailable")

        logger.info(f"✅ {len(valid_releases)} releases with available links (from {len(filtered_releases)} candidates)")
        
        result = {
            'success': True,
            'query': query,
            'media_id': media_id,
            'media_title': media_title,
            'search_url': search_url,
            'total_releases': len(releases),
            'filtered_count': len(filtered_releases),
            'valid_count': len(valid_releases),
            'allowed_hosters': ALLOWED_HOSTER,
            'releases': valid_releases,
            'authenticated': True
        }

        # Close driver in background thread so Flask can return response immediately
        def close_driver_async():
            try:
                close_driver()
                logger.info("✓ Driver closed in background")
            except Exception as e:
                logger.warning(f"Error closing driver: {e}")

        thread = threading.Thread(target=close_driver_async, daemon=True)
        thread.start()

        logger.info(f"Returning {len(valid_releases)} releases")
        return result

    except Exception as e:
        logger.error(f"Error in search_darkiworld: {str(e)}", exc_info=True)

        # Close driver in background thread on error too
        def close_driver_async():
            try:
                close_driver()
                logger.info("✓ Driver closed after error")
            except Exception as e2:
                logger.warning(f"Error closing driver: {e2}")

        thread = threading.Thread(target=close_driver_async, daemon=True)
        thread.start()

        return {
            'success': False,
            'error': str(e),
            'query': query
        }
