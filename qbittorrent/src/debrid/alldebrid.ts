import axios from 'axios';
import { getConfig } from '../config.js';
import { DebridService, DebridTorrentStatus } from './base.js';

const ALLDEBRID_API_BASE = 'https://api.alldebrid.com/v4';

interface AllDebridResponse<T> {
  status: 'success' | 'error';
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

interface DebridLink {
  link: string;
  filename?: string;
  host?: string;
  filesize?: number;
}

interface MagnetUploadResponse {
  magnets: Array<{
    id: number;
    name: string;
    hash: string;
    ready: boolean;
  }>;
}

interface MagnetStatusResponse {
  magnets: {
    id: number;
    filename: string;
    size: number;
    status: string;
    statusCode: number;
    downloaded: number;
    uploaded: number;
    seeders: number;
    downloadSpeed: number;
    uploadSpeed: number;
    uploadDate: number;
    completionDate: number;
    links: Array<{
      link: string;
      filename: string;
      size: number;
    }>;
  };
}

/**
 * AllDebrid client for debriding links
 * Documentation: https://docs.alldebrid.com/
 */
export class AllDebridClient implements DebridService {
  readonly name = 'AllDebrid';

  isConfigured(): boolean {
    const config = getConfig().debrid.alldebrid;
    return !!config.apiKey;
  }

  isEnabled(): boolean {
    const config = getConfig().debrid.alldebrid;
    return config.enabled && this.isConfigured();
  }

  async testConnection(): Promise<boolean> {
    const config = getConfig().debrid.alldebrid;

    if (!config.apiKey) {
      console.log('[AllDebrid] No API key configured');
      return false;
    }

    try {
      console.log('[AllDebrid] Testing connection...');

      const response = await axios.get<AllDebridResponse<{ user: { username: string; isPremium: boolean } }>>(
        `${ALLDEBRID_API_BASE}/user`,
        {
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
          },
          timeout: 10000,
        }
      );

      if (response.data.status === 'success' && response.data.data?.user) {
        const user = response.data.data.user;
        console.log(`[AllDebrid] Connected as ${user.username}, premium: ${user.isPremium}`);
        return true;
      }

      if (response.data.error) {
        console.error(`[AllDebrid] Error: ${response.data.error.message}`);
      }

      return false;
    } catch (error: any) {
      console.error('[AllDebrid] Connection test failed:', error.message || error);
      return false;
    }
  }

  async debridLink(link: string): Promise<string> {
    const config = getConfig().debrid.alldebrid;

    if (!config.apiKey) {
      throw new Error('AllDebrid not configured');
    }

    console.log(`[AllDebrid] Debriding: ${link}`);

    const formData = new FormData();
    formData.append('link', link);

    const response = await axios.post<AllDebridResponse<DebridLink>>(
      `${ALLDEBRID_API_BASE}/link/unlock`,
      formData,
      {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
        },
        timeout: 30000,
      }
    );

    if (response.data.status === 'success' && response.data.data?.link) {
      console.log(`[AllDebrid] Success: ${response.data.data.link}`);
      return response.data.data.link;
    }

    if (response.data.error) {
      throw new Error(`${response.data.error.message} (${response.data.error.code})`);
    }

    throw new Error('Unknown error');
  }

  supportsTorrents(): boolean {
    return true;
  }

  async uploadTorrent(torrentBuffer: Buffer, filename: string = 'file.torrent'): Promise<string> {
    const config = getConfig().debrid.alldebrid;

    if (!config.apiKey) {
      throw new Error('AllDebrid not configured');
    }

    console.log(`[AllDebrid] Uploading torrent file: ${filename}`);

    const formData = new FormData();
    // Convert Buffer to Uint8Array for Blob compatibility
    const blob = new Blob([new Uint8Array(torrentBuffer)], { type: 'application/x-bittorrent' });
    formData.append('files[]', blob, filename);

    // Use /magnet/upload/file for torrent files (not /magnet/upload which is for magnet URIs)
    const response = await axios.post<AllDebridResponse<MagnetUploadResponse>>(
      `${ALLDEBRID_API_BASE}/magnet/upload/file`,
      formData,
      {
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
        },
        timeout: 60000,
      }
    );

    if (response.data.status === 'success' && response.data.data?.magnets?.[0]) {
      const magnet = response.data.data.magnets[0];
      console.log(`[AllDebrid] Torrent uploaded, id: ${magnet.id}, ready: ${magnet.ready}`);
      return String(magnet.id);
    }

    if (response.data.error) {
      throw new Error(`${response.data.error.message} (${response.data.error.code})`);
    }

    throw new Error('Failed to upload torrent');
  }

  async getTorrentStatus(torrentId: string): Promise<DebridTorrentStatus> {
    const config = getConfig().debrid.alldebrid;

    if (!config.apiKey) {
      throw new Error('AllDebrid not configured');
    }

    const response = await axios.get<AllDebridResponse<MagnetStatusResponse>>(
      `${ALLDEBRID_API_BASE}/magnet/status`,
      {
        params: { id: torrentId },
        headers: {
          'Authorization': `Bearer ${config.apiKey}`,
        },
        timeout: 30000,
      }
    );

    if (response.data.status === 'success' && response.data.data?.magnets) {
      const magnet = response.data.data.magnets;

      // AllDebrid statusCode:
      // 0: Processing
      // 1: Queued
      // 2: Downloading
      // 3: Downloaded (compressing)
      // 4: Ready
      // 5+: Error

      let status: DebridTorrentStatus['status'];
      let progress = 0;

      if (magnet.statusCode === 0 || magnet.statusCode === 1) {
        status = 'queued';
      } else if (magnet.statusCode === 2 || magnet.statusCode === 3) {
        status = 'downloading';
        if (magnet.size > 0) {
          progress = Math.round((magnet.downloaded / magnet.size) * 100);
        }
      } else if (magnet.statusCode === 4) {
        status = 'ready';
        progress = 100;
      } else {
        status = 'error';
      }

      const result: DebridTorrentStatus = {
        id: torrentId,
        status,
        progress,
      };

      if (status === 'ready' && magnet.links?.length > 0) {
        result.downloadLinks = magnet.links.map(l => l.link);
      }

      if (status === 'error') {
        result.errorMessage = magnet.status || 'Unknown error';
      }

      return result;
    }

    if (response.data.error) {
      return {
        id: torrentId,
        status: 'error',
        progress: 0,
        errorMessage: response.data.error.message,
      };
    }

    throw new Error('Failed to get torrent status');
  }
}
