/**
 * Status of a torrent being processed by a debrid service
 */
export interface DebridTorrentStatus {
  id: string;
  status: 'queued' | 'downloading' | 'ready' | 'error';
  progress: number;  // 0-100
  totalSize?: number;        // Total size in bytes
  downloadLinks?: string[];  // Available when status is 'ready'
  errorMessage?: string;     // Available when status is 'error'
}

/**
 * Base interface for debrid services
 */
export interface DebridService {
  readonly name: string;

  /**
   * Check if the service is configured (has API key)
   */
  isConfigured(): boolean;

  /**
   * Check if the service is enabled
   */
  isEnabled(): boolean;

  /**
   * Test connection to the debrid service
   */
  testConnection(): Promise<boolean>;

  /**
   * Debrid a single link
   * Returns the debrided link or throws an error if debrid fails
   */
  debridLink(link: string): Promise<string>;

  /**
   * Check if the service supports real torrent files
   */
  supportsTorrents(): boolean;

  /**
   * Upload a torrent file to the debrid service
   * Returns the torrent ID for status tracking
   */
  uploadTorrent(torrentBuffer: Buffer, filename?: string): Promise<string>;

  /**
   * Get the status of an uploaded torrent
   */
  getTorrentStatus(torrentId: string): Promise<DebridTorrentStatus>;
}
