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
from config import DARKIWORLD_URL, ALLOWED_HOSTER, PORT, DEBUG
from driver_sb import close_driver
from routes import api

# Configure logging
logging.basicConfig(level=logging.INFO)
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


if __name__ == '__main__':
    logger.info(f"Starting Darkiworld Scraper on port {PORT}")
    logger.info(f"Target URL: {DARKIWORLD_URL}")
    logger.info(f"Allowed hosters: {ALLOWED_HOSTER if ALLOWED_HOSTER else 'ALL (no filter)'}")

    try:
        app.run(host='0.0.0.0', port=PORT, debug=DEBUG, use_reloader=False, threaded=False)
    except KeyboardInterrupt:
        logger.info("\n🛑 Keyboard interrupt - shutting down...")
    finally:
        # Cleanup driver on exit
        logger.info("Cleaning up driver...")
        close_driver()
        logger.info("✓ Server stopped")
