import axios from 'axios';
import { getConfig } from '../config.js';
import { DebridService, DebridTorrentStatus } from './base.js';

const REALDEBRID_API_BASE = 'https://api.real-debrid.com/rest/1.0';

interface RealDebridUser {
  id: number;
  username: string;
  email: string;
  premium: number; // Unix timestamp when premium expires, 0 if not premium
  type: string;
}

interface RealDebridUnrestrictLink {
  id: string;
  filename: string;
  mimeType: string;
  filesize: number;
  link: string;
  host: string;
  download: string;
}

interface RealDebridTorrentInfo {
  id: string;
  filename: string;
  original_filename: string;
  hash: string;
  bytes: number;
  original_bytes: number;
  host: string;
  split: number;
  progress: number;
  status: 'magnet_error' | 'magnet_conversion' | 'waiting_files_selection' | 'queued' | 'downloading' | 'downloaded' | 'error' | 'virus' | 'compressing' | 'uploading' | 'dead';
  added: string;
  files: Array<{
    id: number;
    path: string;
    bytes: number;
    selected: number;
  }>;
  links: string[];
  ended: string;
  speed: number;
  seeders: number;
}

/**
 * Real-Debrid client for debriding links
 * Documentation: https://api.real-debrid.com/
 */
export class RealDebridClient implements DebridService {
  readonly name = 'Real-Debrid';

  isConfigured(): boolean {
    const config = getConfig().debrid.realdebrid;
    return !!config.apiKey;
  }

  isEnabled(): boolean {
    const config = getConfig().debrid.realdebrid;
    return config.enabled && this.isConfigured();
  }

  async testConnection(): Promise<boolean> {
    const config = getConfig().debrid.realdebrid;

    if (!config.apiKey) {
      console.log('[Real-Debrid] No API key configured');
      return false;
    }

    try {
      console.log('[Real-Debrid] Testing connection...');

      const response = await axios.get<RealDebridUser>(
        `${REALDEBRID_API_BASE}/user`,
        {
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
          },
          timeout: 10000,
        }
      );

      const isPremium = response.data.premium > 0 && response.data.premium > Date.now() / 1000;
      console.log(`[Real-Debrid] Connected as ${response.data.username}, premium: ${isPremium}`);
      return true;
    } catch (error: any) {
      if (error.response?.status === 401) {
        console.error('[Real-Debrid] Invalid API key');
      } else {
        console.error('[Real-Debrid] Connection test failed:', error.message || error);
      }
      return false;
    }
  }

  async debridLink(link: string): Promise<string> {
    const config = getConfig().debrid.realdebrid;

    if (!config.apiKey) {
      throw new Error('Real-Debrid not configured');
    }

    console.log(`[Real-Debrid] Debriding: ${link}`);

    const response = await axios.post<RealDebridUnrestrictLink>(
      `${REALDEBRID_API_BASE}/unrestrict/link`,
      `link=${encodeURIComponent(link)}`,
      {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 30000,
      }
    );

    if (response.data.download) {
      console.log(`[Real-Debrid] Success: ${response.data.download}`);
      return response.data.download;
    }

    throw new Error('No download link returned');
  }

  supportsTorrents(): boolean {
    return true;
  }

  async uploadTorrent(torrentBuffer: Buffer, filename: string = 'file.torrent'): Promise<string> {
    const config = getConfig().debrid.realdebrid;

    if (!config.apiKey) {
      throw new Error('Real-Debrid not configured');
    }

    console.log(`[Real-Debrid] Uploading torrent: ${filename}`);

    // Real-Debrid expects the torrent file as binary PUT request
    const response = await axios.put<{ id: string; uri: string }>(
      `${REALDEBRID_API_BASE}/torrents/addTorrent`,
      torrentBuffer,
      {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/x-bittorrent',
        },
        timeout: 60000,
      }
    );

    if (response.data.id) {
      console.log(`[Real-Debrid] Torrent uploaded, id: ${response.data.id}`);

      // Real-Debrid requires selecting files after upload
      await this.selectAllFiles(response.data.id);

      return response.data.id;
    }

    throw new Error('Failed to upload torrent');
  }

  private async selectAllFiles(torrentId: string): Promise<void> {
    const config = getConfig().debrid.realdebrid;

    // Select all files
    await axios.post(
      `${REALDEBRID_API_BASE}/torrents/selectFiles/${torrentId}`,
      'files=all',
      {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 30000,
      }
    );

    console.log(`[Real-Debrid] Selected all files for torrent ${torrentId}`);
  }

  async getTorrentStatus(torrentId: string): Promise<DebridTorrentStatus> {
    const config = getConfig().debrid.realdebrid;

    if (!config.apiKey) {
      throw new Error('Real-Debrid not configured');
    }

    const response = await axios.get<RealDebridTorrentInfo>(
      `${REALDEBRID_API_BASE}/torrents/info/${torrentId}`,
      {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
        },
        timeout: 30000,
      }
    );

    const torrent = response.data;

    let status: DebridTorrentStatus['status'];

    switch (torrent.status) {
      case 'magnet_conversion':
      case 'waiting_files_selection':
      case 'queued':
        status = 'queued';
        break;
      case 'downloading':
      case 'compressing':
      case 'uploading':
        status = 'downloading';
        break;
      case 'downloaded':
        status = 'ready';
        break;
      case 'magnet_error':
      case 'error':
      case 'virus':
      case 'dead':
        status = 'error';
        break;
      default:
        status = 'queued';
    }

    const result: DebridTorrentStatus = {
      id: torrentId,
      status,
      progress: Math.round(torrent.progress),
    };

    if (status === 'ready' && torrent.links?.length > 0) {
      result.downloadLinks = torrent.links;
    }

    if (status === 'error') {
      result.errorMessage = torrent.status;
    }

    return result;
  }
}
