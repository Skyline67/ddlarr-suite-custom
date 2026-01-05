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
import time
from flask import Flask
from config import DARKIWORLD_URL, PORT, DEBUG, get_darkiworld_url
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

if __name__ == '__main__':
    logger.info(f"Starting Darkiworld Scraper on port {PORT}")
    logger.info(f"Target URL: {DARKIWORLD_URL}")
    logger.info("Hoster filtering: via torznab API URL")

    try:
        app.run(host='0.0.0.0', port=PORT, debug=DEBUG, use_reloader=False, threaded=False)
    except KeyboardInterrupt:
        logger.info("\n🛑 Keyboard interrupt - shutting down...")
    finally:
        # Cleanup driver on exit
        logger.info("Cleaning up driver...")
        close_driver()
        logger.info("✓ Server stopped")