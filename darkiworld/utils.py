"""
Utility functions for Darkiworld Scraper
Contains reusable helper functions.
"""

import re
import logging
import requests
from datetime import datetime, timedelta
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)


def parse_relative_date(date_str: str) -> int:
    """
    Convert date strings to timestamp for sorting
    Supports both ISO format (from API) and French relative dates
    Returns timestamp (higher = more recent)

    Examples:
    - "2025-07-02T10:06:28.000000Z" -> ISO timestamp
    - "l'année dernière" -> ~365 days ago
    - "il y a 3 mois" -> ~90 days ago
    - "il y a 5 jours" -> 5 days ago
    """
    if not date_str:
        return 0

    date_str_lower = date_str.lower().strip()

    # Try to parse ISO format first (from API)
    # Format: "2025-07-02T10:06:28.000000Z"
    try:
        # Handle both with and without microseconds
        if 'T' in date_str:
            # Remove Z and parse
            iso_str = date_str.replace('Z', '').split('.')[0]
            dt = datetime.strptime(iso_str, '%Y-%m-%dT%H:%M:%S')
            return int(dt.timestamp())
    except:
        pass

    # Parse French relative dates
    now = datetime.now()

    # "l'année dernière" or "l'an dernier"
    if "année" in date_str_lower or "l'an" in date_str_lower:
        return int((now - timedelta(days=365)).timestamp())

    # "il y a X mois"
    match = re.search(r'(\d+)\s*mois', date_str_lower)
    if match:
        months = int(match.group(1))
        return int((now - timedelta(days=months * 30)).timestamp())

    # "il y a X jours" or "il y a X jour"
    match = re.search(r'(\d+)\s*jours?', date_str_lower)
    if match:
        days = int(match.group(1))
        return int((now - timedelta(days=days)).timestamp())

    # "il y a X heures" or "il y a X heure"
    match = re.search(r'(\d+)\s*heures?', date_str_lower)
    if match:
        hours = int(match.group(1))
        return int((now - timedelta(hours=hours)).timestamp())

    # "il y a X minutes" or "il y a X minute"
    match = re.search(r'(\d+)\s*minutes?', date_str_lower)
    if match:
        minutes = int(match.group(1))
        return int((now - timedelta(minutes=minutes)).timestamp())

    # "aujourd'hui"
    if "aujourd'hui" in date_str_lower:
        return int(now.timestamp())

    # "hier"
    if "hier" in date_str_lower:
        return int((now - timedelta(days=1)).timestamp())

    # Default: very old (unknown format)
    return 0


def build_release_name(media_title: str, quality: str = None, languages: list = None, exact_filename: str = None) -> str:
    """
    Build a proper release name from media title, quality and languages
    If exact_filename is provided (from AllDebrid batch call), uses it directly.

    Format: {Media Title} {Quality} {Language}
    Example: Avatar 2009 REMUX BLURAY MULTI

    Args:
        media_title: The media title (e.g., "Avatar")
        quality: The quality string (e.g., "REMUX BLURAY", "1080p")
        languages: List of language names (e.g., ["English", "TrueFrench"])
        exact_filename: Optional exact filename (already fetched from AllDebrid batch call)

    Returns:
        Formatted release name (exact filename if provided, otherwise constructed name)
    """
    # Use exact filename if provided (from batch AllDebrid call)
    if exact_filename:
        return exact_filename
    
    # Fallback to constructed name
    parts = []

    # Add media title (clean it up)
    if media_title:
        # Remove "Poster for " prefix if present
        clean_title = media_title.replace('Poster for ', '')
        parts.append(clean_title.strip())

    # Add quality
    if quality:
        parts.append(quality.strip())

    # Add language tag
    if languages and len(languages) > 0:
        lang_tag = format_language_tag(languages)
        if lang_tag:
            parts.append(lang_tag)

    return ' '.join(parts) if parts else 'Unknown'


def format_language_tag(languages: list) -> str:
    """
    Format language list into a proper release tag

    Rules:
    - Multiple languages (2+) -> MULTI
    - TrueFrench or VFF -> VFF
    - French only -> FRENCH
    - English only -> ENGLISH
    - Other single language -> uppercase language name

    Args:
        languages: List of language names

    Returns:
        Formatted language tag
    """
    if not languages:
        return ''

    # Normalize language names
    normalized = [lang.strip().lower() for lang in languages]

    # Multiple languages -> MULTI
    if len(normalized) >= 2:
        # Check if it's French + English (common case)
        if 'french' in normalized or 'truefrench' in normalized:
            return 'MULTI VFF'
        return 'MULTI'

    # Single language
    single_lang = normalized[0]

    # TrueFrench or similar
    if 'truefrench' in single_lang or 'vff' in single_lang:
        return 'VFF'

    # French
    if 'french' in single_lang or 'français' in single_lang:
        return 'FRENCH'

    # English
    if 'english' in single_lang or 'anglais' in single_lang:
        return 'ENGLISH'

    # Other language - return uppercase
    return single_lang.upper()
