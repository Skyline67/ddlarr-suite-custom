"""
Darkiworld Scraper - Main Entry Point

A Flask-based scraper for Darkiworld with Cloudflare bypass,
authentication via cookies, and AllDebrid integration.
"""

import logging
import signal
import sys
import os
import threading
from flask import Flask
from config import DARKIWORLD_URL, ALLOWED_HOSTER, PORT, DEBUG, DARKIWORLD_EMAIL, DARKIWORLD_PASSWORD, get_darkiworld_url
from driver_sb import close_driver, get_driver
from auth_sb import ensure_authenticated
from routes import api

# Logger instance (logging already configured in config.py)
logger = logging.getLogger(__name__)

# Create Flask app
app = Flask(__name__)

# Register API routes
app.register_blueprint(api)


def force_exit():
    """Force exit if cleanup takes too long"""
    logger.warning("⚠️ Cleanup timeout - forcing exit...")
    os._exit(0)


def signal_handler(sig, frame):
    """Handle shutdown signals to cleanup driver"""
    logger.info("\n🛑 Shutdown signal received - cleaning up...")

    # Set a timeout of 3 seconds for cleanup
    timer = threading.Timer(3.0, force_exit)
    timer.daemon = True
    timer.start()

    try:
        close_driver()
        logger.info("✓ Driver closed")
    except Exception as e:
        logger.warning(f"Error closing driver: {e}")
    finally:
        timer.cancel()  # Cancel timeout if we finish in time
        logger.info("✓ Shutdown complete")
        sys.exit(0)


# Register signal handlers for clean shutdown
signal.signal(signal.SIGINT, signal_handler)   # Ctrl+C
signal.signal(signal.SIGTERM, signal_handler)  # kill command


def startup_warmup():
    """
    Automatic login at startup if EMAIL and PASSWORD are configured.
    This allows pre-retrieving cookies to speed up future requests.
    """
    if DARKIWORLD_EMAIL and DARKIWORLD_PASSWORD:
        logger.info("🚀 Automatic login enabled - authentication at startup...")
        try:
            sb = get_driver()
            darkiworld_url = get_darkiworld_url()
            authenticated = ensure_authenticated(sb, darkiworld_url, DARKIWORLD_EMAIL, DARKIWORLD_PASSWORD)

            if authenticated:
                logger.info("✅ Automatic login successful - cookies saved for future requests")
            else:
                logger.warning("⚠️ Automatic login failed - requests will attempt to connect on the fly")
        except Exception as e:
            logger.error(f"❌ Error during automatic login : {e}")
            logger.warning("⚠️ Requests will attempt to connect on the fly")
    else:
        logger.info("ℹ️ Automatic login disabled (DARKIWORLD_EMAIL/PASSWORD not configured)")
        logger.info("   Requests will attempt to connect on the fly if necessary")


if __name__ == '__main__':
    logger.info(f"Starting Darkiworld Scraper on port {PORT}")
    logger.info(f"Target URL: {DARKIWORLD_URL}")
    logger.info(f"Allowed hosters: {ALLOWED_HOSTER if ALLOWED_HOSTER else 'ALL (no filter)'}")

    # Automatic login at startup if EMAIL/PASSWORD configured
    startup_warmup()

    try:
        app.run(host='0.0.0.0', port=PORT, debug=DEBUG, use_reloader=False, threaded=False)
    except KeyboardInterrupt:
        logger.info("\n🛑 Keyboard interrupt - shutting down...")
    finally:
        # Cleanup driver on exit
        logger.info("Cleaning up driver...")
        close_driver()
        logger.info("✓ Server stopped")
