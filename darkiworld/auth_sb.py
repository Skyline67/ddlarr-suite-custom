"""
Authentication module using SeleniumBase for Darkiworld Scraper
Handles automatic login with Cloudflare Turnstile support
"""

import os
import json
import time
import logging
import shutil

logger = logging.getLogger(__name__)

COOKIES_FILE = os.path.join(os.path.dirname(__file__), 'cookies.json')


def save_cookies(sb, filepath: str = COOKIES_FILE) -> None:
    """Save ALL cookies from SeleniumBase driver to JSON file"""
    try:
        # If filepath is a directory (Docker volume issue), remove it
        if os.path.exists(filepath) and os.path.isdir(filepath):
            logger.warning(f"⚠️ {filepath} is a directory, removing it...")
            shutil.rmtree(filepath)

        all_cookies = sb.driver.get_cookies()

        with open(filepath, 'w') as f:
            json.dump(all_cookies, f, indent=2)
        logger.info(f"✓ Saved {len(all_cookies)} cookies to {filepath}")

        # Log which cookies were saved
        saved_names = [c['name'] for c in all_cookies]
        logger.debug(f"Saved cookies: {', '.join(saved_names)}")

    except Exception as e:
        logger.error(f"Failed to save cookies: {e}")


def load_cookies(sb, url: str, filepath: str = COOKIES_FILE) -> bool:
    """Load cookies from JSON file into SeleniumBase driver"""
    if not os.path.exists(filepath):
        logger.info("No saved cookies file found")
        return False

    try:
        with open(filepath, 'r') as f:
            cookies = json.load(f)

        if not cookies:
            logger.warning("Cookies file is empty")
            return False

        # Navigate to the domain first
        sb.open(url)

        loaded_count = 0
        for cookie in cookies:
            try:
                sb.driver.add_cookie(cookie)
                loaded_count += 1
            except Exception as e:
                logger.debug(f"Could not set cookie {cookie.get('name')}: {e}")

        logger.info(f"✓ Loaded {loaded_count}/{len(cookies)} cookies from file")
        return loaded_count > 0

    except Exception as e:
        logger.error(f"Failed to load cookies: {e}")
        return False


def is_authenticated(sb) -> bool:
    """Check if user is authenticated by looking for 'Connexion' text"""
    try:
        body_text = sb.get_text("body").lower()
        has_login_button = 'connexion' in body_text
        has_login_text = 'Connectez-vous à votre compte' in body_text

        if has_login_button:
            logger.info("❌ Not authenticated - 'Connexion' button found")
            return False
        elif has_login_text:
            logger.info("❌ Not authenticated - 'Connectez-vous à votre compte' text found")
            return False
        else:
            logger.info("✓ Authenticated - no 'Connexion' or 'Connectez-vous à votre compte' text found")
            return True

    except Exception as e:
        logger.error(f"Error checking authentication status: {e}")
        return False


def login(sb, url: str, email: str, password: str) -> bool:
    """Perform login on Darkiworld using SeleniumBase"""
    try:
        login_url = f"{url}login" if not url.endswith('/') else f"{url}login"
        logger.info(f"Navigating to login page: {login_url}")

        # Use uc_open_with_reconnect for better Cloudflare handling
        sb.uc_open_with_reconnect(login_url, 2)
        logger.info("✓ Page loaded with UC reconnect")

        # Wait for email field
        logger.info("Waiting for login form...")
        sb.wait_for_element("input[name='email']", timeout=15)
        logger.info("✓ Login form visible")

        # Fill email
        logger.info("Filling email field...")
        sb.type("input[name='email']", email)
        logger.info("✓ Email filled")

        # Fill password
        logger.info("Filling password field...")
        sb.type("input[name='password']", password)
        logger.info("✓ Password filled")

        # Check remember me checkbox
        logger.info("Checking 'remember me' checkbox...")
        try:
            checkbox = sb.find_element("input[name='remember']")
            is_checked = checkbox.get_attribute('aria-checked') == 'true'

            if not is_checked:
                sb.click("input[name='remember']")
                logger.info("✓ 'Remember me' checked")
            else:
                logger.info("✓ 'Remember me' already checked")
        except Exception as e:
            logger.warning(f"Could not check 'remember me': {e}")

        # Wait for Cloudflare Turnstile to validate
        logger.info("Waiting for Cloudflare Turnstile validation...")

        turnstile_validated = False

        # First, check if Turnstile iframe is present
        try:
            logger.info("Checking if Turnstile iframe is present on page...")
            iframes = sb.driver.find_elements("tag name", "iframe")
            logger.info(f"Found {len(iframes)} iframes on page")
            for idx, iframe in enumerate(iframes):
                src = iframe.get_attribute('src') or ''
                logger.info(f"  Iframe {idx}: src={src[:100]}...")
        except Exception as e:
            logger.warning(f"Could not check iframes: {e}")

        # Method 1: Try SeleniumBase's built-in captcha handler
        try:
            logger.info("Attempting to auto-click Turnstile using SeleniumBase UC mode...")
            sb.uc_gui_click_captcha()
            time.sleep(2)
            logger.info("✓ Turnstile auto-clicked via UC mode")
            turnstile_validated = True
        except Exception as e:
            logger.debug(f"UC mode auto-click failed: {e}")

        # Method 2: Manual iframe interaction
        if not turnstile_validated:
            try:
                logger.info("Trying manual Turnstile iframe interaction...")

                # Wait for Turnstile iframe to appear (wait longer)
                sb.wait_for_element('iframe[src*="turnstile"]', timeout=15)

                # Switch to Turnstile iframe
                iframe = sb.find_element('iframe[src*="turnstile"]')
                sb.switch_to_frame(iframe)
                logger.info("✓ Switched to Turnstile iframe")

                # Click the Turnstile checkbox
                sb.wait_for_element('input[type="checkbox"]', timeout=5)
                sb.click('input[type="checkbox"]')
                logger.info("✓ Clicked Turnstile checkbox")

                # Switch back to main content
                sb.switch_to_default_content()

                # Wait for validation
                time.sleep(3)
                turnstile_validated = True

            except Exception as e:
                logger.warning(f"Manual iframe interaction failed: {e}")
                sb.switch_to_default_content()

        # Method 3: Fallback - wait for auto-validation
        if not turnstile_validated:
            logger.info("Fallback: Waiting 10 seconds for Turnstile to auto-validate...")
            time.sleep(10)

        logger.info("✓ Proceeding with form submission...")

        # Submit the form
        logger.info("Submitting login form...")
        sb.click("button[type='submit']")
        logger.info("✓ Login form submitted")

        # Wait for navigation and page to fully load
        logger.info("Waiting for login to complete...")
        time.sleep(3)

        # Wait for page to be fully loaded
        try:
            sb.wait_for_ready_state_complete(timeout=10)
            logger.info("✓ Page fully loaded after login")
        except Exception as e:
            logger.warning(f"Could not wait for ready state: {e}")

        # Wait for authentication cookies to be created after login
        logger.info("Waiting for authentication cookies to settle...")
        max_wait = 15
        cookies_ready = False
        cookies = []

        for i in range(max_wait):
            try:
                cookies = sb.driver.get_cookies()
                cookie_names = [c['name'] for c in cookies]

                # Wait for critical authentication cookies
                has_connected = 'connected' in cookie_names
                has_remember = any(name.startswith('remember_web_') for name in cookie_names)
                has_session = 'darkiworld_session' in cookie_names

                if has_connected and has_remember and has_session:
                    logger.info(f"✓ Authentication cookies found after {i+1}s")
                    cookies_ready = True

                    # Log all cookies NOW while driver is still connected
                    try:
                        logger.info(f"📋 Total cookies after login: {len(cookies)}")
                        for cookie in cookies:
                            logger.info(f"  Cookie: {cookie['name']} = {cookie['value'][:50]}... (domain: {cookie.get('domain', 'N/A')})")
                    except Exception as e:
                        logger.warning(f"Could not log cookies: {e}")

                    break

                if i % 2 == 0:
                    cookie_status = f"connected={has_connected}, remember={has_remember}, session={has_session}"
                    logger.debug(f"Waiting for auth cookies... ({i+1}s, total: {len(cookies)}, {cookie_status})")

                time.sleep(1)
            except Exception as e:
                logger.debug(f"Error checking cookies: {e}")
                time.sleep(1)

        if not cookies_ready:
            cookie_names = [c['name'] for c in cookies]
            logger.warning(f"⚠️ Timeout waiting for auth cookies (found {len(cookies)}): {', '.join(cookie_names)}")
            logger.warning("⚠️ Proceeding anyway but authentication may fail...")

        # Save ALL cookies BEFORE reload to avoid driver disconnection
        if cookies_ready:
            logger.info("Saving all cookies before reload...")
            save_cookies(sb)

        # Reload page to ensure cookies are persisted
        logger.info("Reloading page to ensure cookies are persisted...")
        sb.open(url)
        time.sleep(1)

        # Check if login was successful
        if is_authenticated(sb):
            logger.info("✅ Login successful!")
            return True
        else:
            logger.error("❌ Login failed - still seeing 'Connexion' button")
            return False

    except Exception as e:
        logger.error(f"Error during login: {e}", exc_info=True)
        return False


def ensure_authenticated(sb, url: str, email: str, password: str) -> bool:
    """Ensure user is authenticated, login if necessary"""
    logger.info("Ensuring authentication...")

    # Try to load saved cookies first
    cookies_loaded = load_cookies(sb, url)

    if cookies_loaded:
        # Reload page with cookies
        sb.open(url)
        time.sleep(1)

        # Check if cookies are still valid
        if is_authenticated(sb):
            logger.info("✅ Already authenticated with saved cookies")
            return True
        else:
            logger.info("⚠️ Saved cookies are expired/invalid, need to login")
    else:
        logger.info("No saved cookies, need to login")

    # Need to login
    if not email or not password:
        logger.error("❌ Email and password are required for login")
        return False

    logger.info("Attempting to login...")
    success = login(sb, url, email, password)

    if success:
        logger.info("✅ Authentication successful")
    else:
        logger.error("❌ Authentication failed")

    return success
