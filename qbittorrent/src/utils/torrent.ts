import * as fs from 'fs';
import * as crypto from 'crypto';

export interface TorrentAnalysis {
  type: 'ddl' | 'real';
  name: string;
  size: number;
  ddlLink?: string;      // Only for DDL fake torrents
  infoHash?: string;     // Only for real torrents
}

const DDL_TORZNAB_MARKER = 'DDL-Torznab';

/**
 * Analyze a torrent to determine if it's a DDL fake torrent or a real one
 */
export function analyzeTorrent(data: Buffer): TorrentAnalysis | null {
  try {
    const name = extractNameFromTorrentBuffer(data);
    const size = extractSizeFromTorrentBuffer(data);
    const createdBy = extractCreatedByFromTorrentBuffer(data);

    if (!name || !size) {
      console.error('[Torrent] Cannot analyze: missing name or size');
      return null;
    }

    // If created by DDL-Torznab, it's a fake torrent with DDL link
    if (createdBy === DDL_TORZNAB_MARKER) {
      const ddlLink = extractLinkFromTorrentBuffer(data);
      if (!ddlLink) {
        console.error('[Torrent] DDL torrent without link in comment');
        return null;
      }
      return {
        type: 'ddl',
        name,
        size,
        ddlLink,
      };
    }

    // Otherwise it's a real torrent - compute info hash
    const infoHash = computeInfoHash(data);
    if (!infoHash) {
      console.error('[Torrent] Cannot compute info hash');
      return null;
    }

    return {
      type: 'real',
      name,
      size,
      infoHash,
    };
  } catch (error) {
    console.error('[Torrent] Error analyzing torrent:', error);
    return null;
  }
}

/**
 * Extract the "created by" field from torrent
 */
export function extractCreatedByFromTorrentBuffer(data: Buffer): string | null {
  try {
    const content = data.toString('latin1');

    // Parse "created by" field: 10:created by<length>:<value>
    const match = content.match(/10:created by(\d+):/);
    if (match) {
      const len = parseInt(match[1], 10);
      const start = content.indexOf(match[0]) + match[0].length;
      const createdBy = content.slice(start, start + len);
      return createdBy;
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Compute the info hash of a torrent (SHA1 of the bencoded info dict)
 */
export function computeInfoHash(data: Buffer): string | null {
  try {
    const content = data.toString('latin1');

    // Find the info dict start: "4:info"
    const infoStart = content.indexOf('4:infod');
    if (infoStart === -1) {
      return null;
    }

    // Start of the info dict value (after "4:info")
    const dictStart = infoStart + 6;

    // Find the matching end of the dict by counting depth
    let depth = 0;
    let i = dictStart;

    while (i < content.length) {
      const char = content[i];

      if (char === 'd' || char === 'l') {
        // Dictionary or list start
        depth++;
        i++;
      } else if (char === 'e') {
        // End of dict or list
        depth--;
        if (depth === 0) {
          // Found the end of the info dict
          const infoDictBytes = data.subarray(dictStart, i + 1);
          const hash = crypto.createHash('sha1').update(infoDictBytes).digest('hex');
          return hash;
        }
        i++;
      } else if (char === 'i') {
        // Integer: i<number>e
        const end = content.indexOf('e', i);
        if (end === -1) return null;
        i = end + 1;
      } else if (char >= '0' && char <= '9') {
        // String: <length>:<data>
        const colonPos = content.indexOf(':', i);
        if (colonPos === -1) return null;
        const len = parseInt(content.slice(i, colonPos), 10);
        i = colonPos + 1 + len;
      } else {
        i++;
      }
    }

    return null;
  } catch (error) {
    console.error('[Torrent] Error computing info hash:', error);
    return null;
  }
}

/**
 * Extrait le lien DDL du champ comment d'un fichier torrent
 */
export function extractLinkFromTorrent(filePath: string): string | null {
  try {
    const data = fs.readFileSync(filePath);
    return extractLinkFromTorrentBuffer(data);
  } catch (error) {
    console.error(`[Torrent] Error reading ${filePath}:`, error);
    return null;
  }
}

/**
 * Extrait le lien DDL du champ comment d'un buffer torrent
 */
export function extractLinkFromTorrentBuffer(data: Buffer): string | null {
  try {
    const content = data.toString('latin1'); // Bencode uses latin1

    // Parse comment field: 7:comment<length>:<value>
    const commentMatch = content.match(/7:comment(\d+):/);
    if (commentMatch) {
      const len = parseInt(commentMatch[1], 10);
      const start = content.indexOf(commentMatch[0]) + commentMatch[0].length;
      const link = content.slice(start, start + len);
      console.log(`[Torrent] Extracted link from comment: ${link}`);
      return link;
    }

    // Fallback: try url-list field: 8:url-list<length>:<value>
    const urlListMatch = content.match(/8:url-list(\d+):/);
    if (urlListMatch) {
      const len = parseInt(urlListMatch[1], 10);
      const start = content.indexOf(urlListMatch[0]) + urlListMatch[0].length;
      const link = content.slice(start, start + len);
      console.log(`[Torrent] Extracted link from url-list: ${link}`);
      return link;
    }

    console.warn(`[Torrent] No link found in torrent data`);
    return null;
  } catch (error) {
    console.error(`[Torrent] Error parsing torrent data:`, error);
    return null;
  }
}

/**
 * Extrait le nom du fichier du torrent
 */
export function extractNameFromTorrent(filePath: string): string | null {
  try {
    const data = fs.readFileSync(filePath);
    return extractNameFromTorrentBuffer(data);
  } catch (error) {
    console.error(`[Torrent] Error extracting name from ${filePath}:`, error);
    return null;
  }
}

/**
 * Extrait le nom du fichier d'un buffer torrent
 */
export function extractNameFromTorrentBuffer(data: Buffer): string | null {
  try {
    // Use latin1 for bencode structure parsing (to get correct byte positions)
    const content = data.toString('latin1');

    // Parse name field in info dict: 4:name<length>:<value>
    const nameMatch = content.match(/4:name(\d+):/);
    if (nameMatch) {
      const len = parseInt(nameMatch[1], 10);
      const start = content.indexOf(nameMatch[0]) + nameMatch[0].length;
      // Extract raw bytes and decode as UTF-8
      const nameBytes = data.subarray(start, start + len);
      return nameBytes.toString('utf8');
    }

    return null;
  } catch (error) {
    console.error(`[Torrent] Error extracting name from torrent data:`, error);
    return null;
  }
}

/**
 * Extrait la taille du fichier d'un buffer torrent
 */
export function extractSizeFromTorrentBuffer(data: Buffer): number | null {
  try {
    const content = data.toString('latin1');

    // Parse length field in info dict: 6:lengthi<number>e
    const lengthMatch = content.match(/6:lengthi(\d+)e/);
    if (lengthMatch) {
      return parseInt(lengthMatch[1], 10);
    }

    return null;
  } catch (error) {
    console.error(`[Torrent] Error extracting size from torrent data:`, error);
    return null;
  }
}
