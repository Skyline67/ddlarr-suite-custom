"""
Flask routes module for Darkiworld Scraper
Defines all API endpoints.
"""

import logging
from flask import Blueprint, request, jsonify
from scraper import scrape_darkiworld, search_darkiworld

logger = logging.getLogger(__name__)

# Create Blueprint for API routes
api = Blueprint('api', __name__)


@api.route('/health', methods=['GET'])
def health():
    """Health check endpoint"""
    return jsonify({'status': 'ok'}), 200

@api.route('/search', methods=['GET'])
def search():
    """
    Search endpoint - searches DarkiWorld and clicks first result

    Parameters:
    - name or query (required): Search query

    Example:
    GET /search?name=Avatar
    """
    try:
        data = request.args.to_dict()

        query = data.get('name', data.get('query', ''))

        if not query:
            return jsonify({
                'success': False,
                'error': 'Parameter "name" or "query" is required'
            }), 400

        logger.info(f"Search endpoint called with query: '{query}'")
        result = search_darkiworld({'name': query})

        logger.info(f"Search result success: {result.get('success')}, releases: {len(result.get('releases', []))}")
        status_code = 200 if result.get('success') else 400
        logger.info(f"Returning response with status {status_code}")
        return jsonify(result), status_code

    except Exception as e:
        logger.error(f"Error in search endpoint: {e}", exc_info=True)
        return jsonify({'success': False, 'error': str(e)}), 500


@api.route('/cookies', methods=['GET'])
def get_cookies_route():
    """Get current cookies from browser"""
    try:
        result = scrape_darkiworld({})
        if result['success']:
            return jsonify({
                'success': True,
                'cookies': result.get('cookies', [])
            }), 200
        else:
            return jsonify(result), 500
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500
