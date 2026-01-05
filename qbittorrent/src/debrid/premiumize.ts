import axios from 'axios';
import { getConfig } from '../config.js';
import { DebridService, DebridTorrentStatus } from './base.js';

const PREMIUMIZE_API_BASE = 'https://www.premiumize.me/api';

interface PremiumizeResponse<T> {
  status: 'success' | 'error';
  message?: string;
  content?: T;
}

interface PremiumizeAccountInfo {
  customer_id: string;
  premium_until: number; // Unix timestamp
  limit_used: number;
  space_used: number;
}

interface PremiumizeDirectDL {
  location: string;
  filename: string;
  filesize: number;
}

interface PremiumizeTransferCreate {
  id: string;
  name: string;
  type: string;
}

interface PremiumizeTransfer {
  id: string;
  name: string;
  message: string;
  status: 'waiting' | 'queued' | 'running' | 'finished' | 'seeding' | 'error' | 'deleted' | 'timeout' | 'banned';
  progress: number;
  folder_id?: string;
  file_id?: string;
}

/**
 * Premiumize client for debriding links
 * Documentation: https://www.premiumize.me/api
 */
export class PremiumizeClient implements DebridService {
  readonly name = 'Premiumize';

  isConfigured(): boolean {
    const config = getConfig().debrid.premiumize;
    return !!config.apiKey;
  }

  isEnabled(): boolean {
    const config = getConfig().debrid.premiumize;
    return config.enabled && this.isConfigured();
  }

  async testConnection(): Promise<boolean> {
    const config = getConfig().debrid.premiumize;

    if (!config.apiKey) {
      console.log('[Premiumize] No API key configured');
      return false;
    }

    try {
      console.log('[Premiumize] Testing connection...');

      const response = await axios.get<PremiumizeResponse<PremiumizeAccountInfo>>(
        `${PREMIUMIZE_API_BASE}/account/info`,
        {
          params: {
            apikey: config.apiKey,
          },
          timeout: 10000,
        }
      );

      if (response.data.status === 'success') {
        const isPremium = response.data.content?.premium_until
          ? response.data.content.premium_until > Date.now() / 1000
          : false;
        console.log(`[Premiumize] Connected, premium: ${isPremium}`);
        return true;
      }

      if (response.data.message) {
        console.error(`[Premiumize] Error: ${response.data.message}`);
      }

      return false;
    } catch (error: any) {
      console.error('[Premiumize] Connection test failed:', error.message || error);
      return false;
    }
  }

  async debridLink(link: string): Promise<string> {
    const config = getConfig().debrid.premiumize;

    if (!config.apiKey) {
      throw new Error('Premiumize not configured');
    }

    console.log(`[Premiumize] Debriding: ${link}`);

    const response = await axios.post<PremiumizeResponse<PremiumizeDirectDL>>(
      `${PREMIUMIZE_API_BASE}/transfer/directdl`,
      `src=${encodeURIComponent(link)}`,
      {
        params: {
          apikey: config.apiKey,
        },
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 30000,
      }
    );

    if (response.data.status === 'success' && response.data.content?.location) {
      console.log(`[Premiumize] Success: ${response.data.content.location}`);
      return response.data.content.location;
    }

    if (response.data.message) {
      throw new Error(response.data.message);
    }

    throw new Error('Unknown error');
  }

  supportsTorrents(): boolean {
    return true;
  }

  async uploadTorrent(torrentBuffer: Buffer, filename: string = 'file.torrent'): Promise<string> {
    const config = getConfig().debrid.premiumize;

    if (!config.apiKey) {
      throw new Error('Premiumize not configured');
    }

    console.log(`[Premiumize] Uploading torrent: ${filename}`);

    const formData = new FormData();
    // Convert Buffer to Uint8Array for Blob compatibility
    const blob = new Blob([new Uint8Array(torrentBuffer)], { type: 'application/x-bittorrent' });
    formData.append('file', blob, filename);

    const response = await axios.post<PremiumizeResponse<PremiumizeTransferCreate>>(
      `${PREMIUMIZE_API_BASE}/transfer/create`,
      formData,
      {
        params: {
          apikey: config.apiKey,
        },
        timeout: 60000,
      }
    );

    if (response.data.status === 'success' && response.data.content?.id) {
      console.log(`[Premiumize] Torrent uploaded, id: ${response.data.content.id}`);
      return response.data.content.id;
    }

    if (response.data.message) {
      throw new Error(response.data.message);
    }

    throw new Error('Failed to upload torrent');
  }

  async getTorrentStatus(torrentId: string): Promise<DebridTorrentStatus> {
    const config = getConfig().debrid.premiumize;

    if (!config.apiKey) {
      throw new Error('Premiumize not configured');
    }

    // Premiumize doesn't have a single transfer endpoint, we need to list all
    const response = await axios.get<PremiumizeResponse<{ transfers: PremiumizeTransfer[] }>>(
      `${PREMIUMIZE_API_BASE}/transfer/list`,
      {
        params: {
          apikey: config.apiKey,
        },
        timeout: 30000,
      }
    );

    if (response.data.status !== 'success' || !response.data.content?.transfers) {
      throw new Error('Failed to get transfer list');
    }

    const transfer = response.data.content.transfers.find(t => t.id === torrentId);
    if (!transfer) {
      return {
        id: torrentId,
        status: 'error',
        progress: 0,
        errorMessage: 'Transfer not found',
      };
    }

    let status: DebridTorrentStatus['status'];

    switch (transfer.status) {
      case 'waiting':
      case 'queued':
        status = 'queued';
        break;
      case 'running':
        status = 'downloading';
        break;
      case 'finished':
      case 'seeding':
        status = 'ready';
        break;
      case 'error':
      case 'deleted':
      case 'timeout':
      case 'banned':
        status = 'error';
        break;
      default:
        status = 'queued';
    }

    const result: DebridTorrentStatus = {
      id: torrentId,
      status,
      progress: Math.round(transfer.progress * 100),
    };

    if (status === 'ready') {
      // Get download links from the folder or file
      if (transfer.folder_id) {
        result.downloadLinks = await this.getFolderLinks(transfer.folder_id);
      } else if (transfer.file_id) {
        const link = await this.getFileLink(transfer.file_id);
        if (link) {
          result.downloadLinks = [link];
        }
      }
    }

    if (status === 'error') {
      result.errorMessage = transfer.message || transfer.status;
    }

    return result;
  }

  private async getFolderLinks(folderId: string): Promise<string[]> {
    const config = getConfig().debrid.premiumize;

    const response = await axios.get<PremiumizeResponse<{ content: Array<{ link?: string }> }>>(
      `${PREMIUMIZE_API_BASE}/folder/list`,
      {
        params: {
          apikey: config.apiKey,
          id: folderId,
        },
        timeout: 30000,
      }
    );

    if (response.data.status === 'success' && response.data.content?.content) {
      return response.data.content.content
        .filter(item => item.link)
        .map(item => item.link!);
    }

    return [];
  }

  private async getFileLink(fileId: string): Promise<string | null> {
    const config = getConfig().debrid.premiumize;

    const response = await axios.get<PremiumizeResponse<{ location: string }>>(
      `${PREMIUMIZE_API_BASE}/item/details`,
      {
        params: {
          apikey: config.apiKey,
          id: fileId,
        },
        timeout: 30000,
      }
    );

    if (response.data.status === 'success' && response.data.content?.location) {
      return response.data.content.location;
    }

    return null;
  }
}
