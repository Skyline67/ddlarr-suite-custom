import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../config.js';
import { generateDownloadHash } from '../utils/hash.js';
import {
  analyzeTorrent,
  extractNameFromTorrentBuffer,
  extractSizeFromTorrentBuffer,
} from '../utils/torrent.js';
import { isDlProtectLink, resolveDlProtectLink } from '../utils/dlprotect.js';
import { debridLink, debridTorrent, isAnyDebridEnabled, getTorrentEnabledServices } from '../debrid/index.js';
import { startDownload, stopDownload, pauseDownload, getDownloadProgress, isDownloadActive, isDownloadPaused, getPausedDownloadInfo } from './downloader.js';
import * as repository from '../db/repository.js';
import type { Download, DownloadState, DownloadType } from '../types/download.js';

/**
 * Format bytes per second to human readable speed
 */
function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec === 0) return '0 B/s';
  const k = 1024;
  const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(k));
  return parseFloat((bytesPerSec / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Get the real filename from a URL by checking Content-Disposition header
 */
// Known error URL patterns that indicate the file is not available
const ERROR_URL_PATTERNS = [
  '/article/premium',      // Rapidgator
  '/error',                // Generic
  '/404',                  // Generic
  '/not-found',            // Generic
  '/file-not-found',       // Generic
  '/deleted',              // Generic
  '/removed',              // Generic
  '/unavailable',          // Generic
];

/**
 * Check if a URL is an error/redirect page
 */
function isErrorUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname.toLowerCase();
    return ERROR_URL_PATTERNS.some(pattern => path.includes(pattern));
  } catch {
    return false;
  }
}

async function getRealFilename(url: string, fallbackName: string): Promise<string> {
  try {
    const response = await fetch(url, { method: 'HEAD', redirect: 'follow' });

    // Check for HTTP errors (404, etc.) - throw to be caught by caller
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Check if we were redirected to an error page (e.g., rapidgator premium page)
    const finalUrl = response.url;
    if (isErrorUrl(finalUrl)) {
      throw new Error(`HTTP redirect to error page: ${finalUrl}`);
    }

    // Check Content-Type - if it's HTML when we expect a file, it's probably an error page
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
      // Some hosters return HTML error pages with 200 status
      throw new Error(`HTTP invalid content-type: ${contentType} (expected file, got HTML)`);
    }

    // Check Content-Disposition header for filename
    const contentDisposition = response.headers.get('content-disposition');
    if (contentDisposition) {
      // Try filename*= (RFC 5987 - UTF-8 encoded)
      const utf8Match = contentDisposition.match(/filename\*=(?:UTF-8''|utf-8'')([^;]+)/i);
      if (utf8Match) {
        const filename = decodeURIComponent(utf8Match[1].replace(/['"]/g, ''));
        console.log(`[DownloadManager] Got filename from Content-Disposition (UTF-8): ${filename}`);
        return filename;
      }

      // Try regular filename=
      const match = contentDisposition.match(/filename=["']?([^"';\n]+)["']?/i);
      if (match) {
        const filename = match[1].trim();
        console.log(`[DownloadManager] Got filename from Content-Disposition: ${filename}`);
        return filename;
      }
    }

    // Try to get filename from final URL (after redirects)
    const urlPath = new URL(finalUrl).pathname;
    const urlFilename = decodeURIComponent(urlPath.split('/').pop() || '');
    if (urlFilename && urlFilename.includes('.')) {
      console.log(`[DownloadManager] Got filename from URL: ${urlFilename}`);
      return urlFilename;
    }
  } catch (error: any) {
    // Re-throw HTTP errors so they can be handled by the caller
    if (error.message.startsWith('HTTP ')) {
      throw error;
    }
    console.log(`[DownloadManager] Could not get real filename: ${error.message}`);
  }

  // Check if fallback already has an extension
  if (fallbackName.includes('.')) {
    return fallbackName;
  }

  // Try to extract extension from URL
  try {
    const urlPath = new URL(url).pathname;
    const ext = urlPath.match(/\.([a-z0-9]{2,5})(?:[?#]|$)/i);
    if (ext) {
      return `${fallbackName}.${ext[1]}`;
    }
  } catch {}

  return fallbackName;
}

class DownloadManager {
  private processing = false;
  // Track active debrid operations for cancellation
  private activeDebridOperations = new Map<string, { cancelled: boolean }>();

  /**
   * Get the path where torrent files are stored
   */
  private getTorrentStoragePath(): string {
    const config = getConfig();
    const torrentDir = path.join(config.dataPath, 'torrents');
    if (!fs.existsSync(torrentDir)) {
      fs.mkdirSync(torrentDir, { recursive: true });
    }
    return torrentDir;
  }

  /**
   * Save torrent file for later use
   */
  private saveTorrentFile(hash: string, torrentData: Buffer): void {
    const torrentPath = path.join(this.getTorrentStoragePath(), `${hash}.torrent`);
    fs.writeFileSync(torrentPath, torrentData);
    console.log(`[DownloadManager] Saved torrent file: ${torrentPath}`);
  }

  /**
   * Load torrent file
   */
  private loadTorrentFile(hash: string): Buffer | null {
    const torrentPath = path.join(this.getTorrentStoragePath(), `${hash}.torrent`);
    if (fs.existsSync(torrentPath)) {
      return fs.readFileSync(torrentPath);
    }
    return null;
  }

  /**
   * Delete torrent file
   */
  private deleteTorrentFile(hash: string): void {
    const torrentPath = path.join(this.getTorrentStoragePath(), `${hash}.torrent`);
    if (fs.existsSync(torrentPath)) {
      fs.unlinkSync(torrentPath);
      console.log(`[DownloadManager] Deleted torrent file: ${torrentPath}`);
    }
  }

  /**
   * Add a torrent from file data
   */
  async addTorrent(
    torrentData: Buffer,
    options: { savePath?: string; category?: string; paused?: boolean } = {}
  ): Promise<string> {
    // Analyze torrent to determine type
    const analysis = analyzeTorrent(torrentData);
    if (!analysis) {
      throw new Error('Invalid torrent file');
    }

    const config = getConfig();

    // Build save path with category subfolder if specified
    let savePath = options.savePath || config.downloadPath;
    if (options.category && !options.savePath) {
      savePath = `${config.downloadPath}/${options.category}`;
    }

    if (analysis.type === 'ddl') {
      // DDL fake torrent - use original flow
      const hash = generateDownloadHash(analysis.ddlLink!);

      const download: Omit<Download, 'downloadSpeed'> = {
        hash,
        name: analysis.name,
        type: 'ddl',
        originalLink: analysis.ddlLink!,
        debridedLink: null,
        debridTorrentId: null,
        savePath,
        totalSize: analysis.size,
        downloadedSize: 0,
        state: options.paused ? 'paused' : 'queued',
        statusMessage: null,
        errorMessage: null,
        addedAt: Date.now(),
        startedAt: null,
        completedAt: null,
        category: options.category || null,
        priority: 0,
      };

      repository.createDownload(download);
      console.log(`[DownloadManager] Added DDL download: ${analysis.name} (${hash})`);

      if (!options.paused) {
        this.processQueue();
      }

      return hash;
    } else {
      // Real torrent - check if debrid service supports it
      const torrentServices = getTorrentEnabledServices();
      if (torrentServices.length === 0) {
        throw new Error('No debrid service with torrent support is enabled');
      }

      const hash = analysis.infoHash!;

      // Save torrent file for later processing
      this.saveTorrentFile(hash, torrentData);

      const download: Omit<Download, 'downloadSpeed'> = {
        hash,
        name: analysis.name,
        type: 'real',
        originalLink: hash,  // Store info hash as original link for real torrents
        debridedLink: null,
        debridTorrentId: null,
        savePath,
        totalSize: analysis.size,
        downloadedSize: 0,
        state: options.paused ? 'paused' : 'queued',
        statusMessage: null,
        errorMessage: null,
        addedAt: Date.now(),
        startedAt: null,
        completedAt: null,
        category: options.category || null,
        priority: 0,
      };

      repository.createDownload(download);
      console.log(`[DownloadManager] Added real torrent: ${analysis.name} (${hash})`);

      if (!options.paused) {
        this.processQueue();
      }

      return hash;
    }
  }

  /**
   * Add a download from URL
   */
  async addUrl(
    url: string,
    options: { savePath?: string; category?: string; paused?: boolean; name?: string } = {}
  ): Promise<string> {
    const hash = generateDownloadHash(url);
    const config = getConfig();

    let name = options.name;
    if (!name) {
      try {
        const urlObj = new URL(url);
        name = decodeURIComponent(urlObj.pathname.split('/').pop() || '') || `download_${Date.now()}`;
      } catch {
        name = `download_${Date.now()}`;
      }
    }

    // Build save path with category subfolder if specified
    let savePath = options.savePath || config.downloadPath;
    if (options.category && !options.savePath) {
      savePath = `${config.downloadPath}/${options.category}`;
    }

    const download: Omit<Download, 'downloadSpeed'> = {
      hash,
      name,
      type: 'ddl',  // URL downloads are always treated as DDL
      originalLink: url,
      debridedLink: null,
      debridTorrentId: null,
      savePath,
      totalSize: 0,
      downloadedSize: 0,
      state: options.paused ? 'paused' : 'queued',
      statusMessage: null,
      errorMessage: null,
      addedAt: Date.now(),
      startedAt: null,
      completedAt: null,
      category: options.category || null,
      priority: 0,
    };

    repository.createDownload(download);
    console.log(`[DownloadManager] Added URL download: ${name} (${hash})`);

    if (!options.paused) {
      this.processQueue();
    }

    return hash;
  }

  /**
   * Pause downloads
   */
  pause(hashes: string[]): void {
    for (const hash of hashes) {
      const download = repository.getDownloadByHash(hash);
      if (!download) continue;

      if (download.state === 'downloading') {
        // Save current progress to database before pausing
        const progress = getDownloadProgress(hash);
        if (progress) {
          repository.updateDownloadProgress(
            hash,
            progress.downloadedBytes,
            progress.totalBytes,
            0  // Speed is 0 when paused
          );
          console.log(`[DownloadManager] Saved progress before pause: ${progress.downloadedBytes}/${progress.totalBytes}`);
        }
        // Use pauseDownload to keep temp file for resume
        pauseDownload(hash);
      }

      if (download.state === 'queued' || download.state === 'downloading' || download.state === 'checking') {
        repository.updateDownloadState(hash, 'paused');
        console.log(`[DownloadManager] Paused: ${hash}`);
      }
    }
  }

  /**
   * Resume downloads
   */
  resume(hashes: string[]): void {
    for (const hash of hashes) {
      const download = repository.getDownloadByHash(hash);
      if (!download) continue;

      if (download.state === 'paused') {
        repository.updateDownloadState(hash, 'queued');
        console.log(`[DownloadManager] Resumed: ${hash}`);
      }
    }
    this.processQueue();
  }

  /**
   * Delete downloads
   */
  async delete(hashes: string[], deleteFiles: boolean): Promise<void> {
    for (const hash of hashes) {
      const download = repository.getDownloadByHash(hash);
      if (!download) continue;

      // Cancel any active debrid operation (for real torrents in checking state)
      if (this.activeDebridOperations.has(hash)) {
        console.log(`[DownloadManager] Cancelling debrid operation for: ${hash}`);
        this.activeDebridOperations.get(hash)!.cancelled = true;
        this.activeDebridOperations.delete(hash);
      }

      // Stop if downloading
      if (download.state === 'downloading') {
        stopDownload(hash);
      }

      // Delete file if requested
      if (deleteFiles && download.state === 'completed') {
        const filePath = path.join(download.savePath, download.name);
        try {
          if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[DownloadManager] Deleted file: ${filePath}`);
          }
        } catch (error: any) {
          console.error(`[DownloadManager] Error deleting file: ${error.message}`);
        }
      }

      // Delete stored torrent file if real torrent
      if (download.type === 'real') {
        this.deleteTorrentFile(hash);
      }

      repository.deleteDownload(hash);
      console.log(`[DownloadManager] Deleted download: ${hash}`);
    }

    // Trigger queue processing since a slot may have freed up
    this.processQueue();
  }

  /**
   * Get all downloads
   */
  getAll(filter?: DownloadState): Download[] {
    const downloads = filter
      ? repository.getDownloadsByState(filter)
      : repository.getAllDownloads();

    // Update progress for active and paused downloads
    return downloads.map(download => {
      if (download.state === 'downloading' && isDownloadActive(download.hash)) {
        const progress = getDownloadProgress(download.hash);
        if (progress) {
          return {
            ...download,
            downloadedSize: progress.downloadedBytes,
            totalSize: progress.totalBytes || download.totalSize,
            downloadSpeed: progress.downloadSpeed,
          };
        }
      }
      // For paused downloads, get saved progress info
      if (download.state === 'paused' && isDownloadPaused(download.hash)) {
        const pausedInfo = getPausedDownloadInfo(download.hash);
        if (pausedInfo) {
          return {
            ...download,
            downloadedSize: pausedInfo.downloadedBytes,
            totalSize: pausedInfo.totalBytes || download.totalSize,
            downloadSpeed: 0,
          };
        }
      }
      return download;
    });
  }

  /**
   * Get download by hash
   */
  getByHash(hash: string): Download | null {
    const download = repository.getDownloadByHash(hash);
    if (!download) return null;

    // Update progress for active download
    if (download.state === 'downloading' && isDownloadActive(hash)) {
      const progress = getDownloadProgress(hash);
      if (progress) {
        return {
          ...download,
          downloadedSize: progress.downloadedBytes,
          totalSize: progress.totalBytes || download.totalSize,
          downloadSpeed: progress.downloadSpeed,
        };
      }
    }

    // For paused downloads, get saved progress info
    if (download.state === 'paused' && isDownloadPaused(hash)) {
      const pausedInfo = getPausedDownloadInfo(hash);
      if (pausedInfo) {
        return {
          ...download,
          downloadedSize: pausedInfo.downloadedBytes,
          totalSize: pausedInfo.totalBytes || download.totalSize,
          downloadSpeed: 0,
        };
      }
    }

    return download;
  }

  /**
   * Process the download queue
   */
  async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      const config = getConfig();
      const downloading = repository.getDownloadsByState('downloading');
      const checking = repository.getDownloadsByState('checking');
      const activeCount = downloading.length + checking.length;

      if (activeCount >= config.maxConcurrentDownloads) {
        return;
      }

      const queued = repository.getDownloadsByState('queued');
      const slotsAvailable = config.maxConcurrentDownloads - activeCount;

      for (let i = 0; i < Math.min(slotsAvailable, queued.length); i++) {
        const download = queued[i];
        await this.startProcessing(download);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Start processing a download (resolve links, debrid, start download)
   */
  private async startProcessing(download: Download): Promise<void> {
    // Route to appropriate handler based on type
    if (download.type === 'real') {
      await this.startProcessingRealTorrent(download);
    } else {
      await this.startProcessingDdl(download);
    }
  }

  /**
   * Process a real torrent (upload to debrid, wait for completion, download files)
   */
  private async startProcessingRealTorrent(download: Download): Promise<void> {
    const { hash, name, savePath } = download;

    // Track this debrid operation for cancellation
    const operation = { cancelled: false };
    this.activeDebridOperations.set(hash, operation);

    try {
      repository.updateDownloadState(hash, 'checking');

      // Load torrent file
      const torrentBuffer = this.loadTorrentFile(hash);
      if (!torrentBuffer) {
        throw new Error('Torrent file not found');
      }

      // Upload to debrid service
      repository.updateDownloadStatusMessage(hash, 'Uploading torrent to debrid...');
      console.log(`[DownloadManager] Uploading real torrent: ${name}`);

      const config = getConfig();
      const timeoutMs = config.debridTorrentTimeoutHours * 60 * 60 * 1000;

      const result = await debridTorrent(
        torrentBuffer,
        `${name}.torrent`,
        (status, serviceName) => {
          // Check if cancelled during polling
          if (operation.cancelled) {
            throw new Error('Download cancelled');
          }
          // Update status message based on debrid status
          if (status.status === 'queued') {
            repository.updateDownloadStatusMessage(hash, `Queued on ${serviceName}...`);
          } else if (status.status === 'downloading') {
            repository.updateDownloadStatusMessage(hash, `Downloading on debrid: ${status.progress}%`);
          }
        },
        timeoutMs
      );

      // Check if cancelled after debrid completed
      if (operation.cancelled) {
        console.log(`[DownloadManager] Real torrent cancelled after debrid: ${name}`);
        return;
      }

      console.log(`[DownloadManager] Torrent ready on ${result.service}, ${result.downloadLinks.length} file(s)`);

      // Clean up torrent file after successful debrid
      this.deleteTorrentFile(hash);

      // If single file, download it directly
      // If multiple files, download each sequentially
      if (result.downloadLinks.length === 1) {
        const debridedUrl = result.downloadLinks[0];
        repository.updateDownloadLink(hash, debridedUrl);

        // Get real filename
        repository.updateDownloadStatusMessage(hash, 'Getting file info...');
        let actualName = name;
        try {
          actualName = await getRealFilename(debridedUrl, name);
          if (actualName !== name) {
            repository.updateDownloadName(hash, actualName);
          }
        } catch (error: any) {
          console.log(`[DownloadManager] Could not get real filename: ${error.message}`);
        }

        // Start download
        repository.updateDownloadStatusMessage(hash, null);
        repository.updateDownloadState(hash, 'downloading');

        startDownload(hash, debridedUrl, actualName, {
          onProgress: (progress) => {
            repository.updateDownloadProgress(hash, progress.downloadedBytes, progress.totalBytes, progress.downloadSpeed);
          },
          onMoving: (finalPath) => {
            const dl = repository.getDownloadByHash(hash);
            if (dl && dl.totalSize > 0) {
              repository.updateDownloadProgress(hash, dl.totalSize, dl.totalSize, 0);
            }
            repository.updateDownloadStatusMessage(hash, `Moving to ${finalPath}...`);
          },
          onMoveProgress: (copiedBytes, totalBytes, speed) => {
            const percent = Math.round((copiedBytes / totalBytes) * 100);
            repository.updateDownloadStatusMessage(hash, `Copying... ${percent}% - ${formatSpeed(speed)}`);
          },
          onExtracting: () => {
            repository.updateDownloadStatusMessage(hash, 'Extracting...');
          },
          onComplete: () => {
            repository.updateDownloadState(hash, 'completed');
            console.log(`[DownloadManager] Completed: ${name}`);
            this.processQueue();
          },
          onError: (error) => {
            repository.updateDownloadState(hash, 'error', error.message);
            console.error(`[DownloadManager] Error: ${name} - ${error.message}`);
            this.processQueue();
          },
          onPaused: () => {
            console.log(`[DownloadManager] Download paused: ${name}`);
          },
        }, result.totalSize, savePath);
      } else {
        // Multiple files - download them sequentially
        // For now, download the first one (TODO: handle multi-file torrents properly)
        console.log(`[DownloadManager] Multi-file torrent with ${result.downloadLinks.length} files, downloading first`);
        const debridedUrl = result.downloadLinks[0];
        repository.updateDownloadLink(hash, debridedUrl);

        repository.updateDownloadStatusMessage(hash, null);
        repository.updateDownloadState(hash, 'downloading');

        startDownload(hash, debridedUrl, name, {
          onProgress: (progress) => {
            repository.updateDownloadProgress(hash, progress.downloadedBytes, progress.totalBytes, progress.downloadSpeed);
          },
          onMoving: (finalPath) => {
            repository.updateDownloadStatusMessage(hash, `Moving to ${finalPath}...`);
          },
          onMoveProgress: (copiedBytes, totalBytes, speed) => {
            const percent = Math.round((copiedBytes / totalBytes) * 100);
            repository.updateDownloadStatusMessage(hash, `Copying... ${percent}% - ${formatSpeed(speed)}`);
          },
          onExtracting: () => {
            repository.updateDownloadStatusMessage(hash, 'Extracting...');
          },
          onComplete: () => {
            repository.updateDownloadState(hash, 'completed');
            this.processQueue();
          },
          onError: (error) => {
            repository.updateDownloadState(hash, 'error', error.message);
            this.processQueue();
          },
          onPaused: () => {},
        }, result.totalSize, savePath);
      }
    } catch (error: any) {
      // Clean up operation tracking
      this.activeDebridOperations.delete(hash);

      // Don't set error state if cancelled (download was deleted)
      if (operation.cancelled || error.message === 'Download cancelled') {
        console.log(`[DownloadManager] Real torrent cancelled: ${name}`);
      } else {
        // Only update state if download still exists
        const dl = repository.getDownloadByHash(hash);
        if (dl) {
          repository.updateDownloadState(hash, 'error', error.message);
          console.error(`[DownloadManager] Real torrent error: ${name} - ${error.message}`);
        }
      }
      this.processQueue();
    } finally {
      // Always clean up operation tracking
      this.activeDebridOperations.delete(hash);
    }
  }

  /**
   * Process a DDL download (original flow)
   */
  private async startProcessingDdl(download: Download): Promise<void> {
    const { hash, originalLink, debridedLink, name, savePath } = download;

    try {
      // Check if this is a resume:
      // 1. Has debrided link (already processed) AND
      // 2. Either in pausedDownloads OR has partial download in database
      const hasDebridedLink = !!debridedLink;
      const isPausedInMemory = isDownloadPaused(hash);
      const hasPartialDownload = download.downloadedSize > 0 && download.state === 'queued';
      const isResume = hasDebridedLink && (isPausedInMemory || hasPartialDownload);

      console.log(`[DownloadManager] Processing ${name}: hasDebridedLink=${hasDebridedLink}, isPausedInMemory=${isPausedInMemory}, hasPartialDownload=${hasPartialDownload}, isResume=${isResume}`);

      if (isResume) {
        console.log(`[DownloadManager] Resuming: ${name}`);
        repository.updateDownloadState(hash, 'downloading');

        startDownload(hash, debridedLink, name, {
          onProgress: (progress) => {
            repository.updateDownloadProgress(
              hash,
              progress.downloadedBytes,
              progress.totalBytes,
              progress.downloadSpeed
            );
          },
          onMoving: (finalPath) => {
            // Set progress to 100% and speed to 0 when moving starts
            const dl = repository.getDownloadByHash(hash);
            if (dl && dl.totalSize > 0) {
              repository.updateDownloadProgress(hash, dl.totalSize, dl.totalSize, 0);
            }
            repository.updateDownloadStatusMessage(hash, `Moving to ${finalPath}...`);
            console.log(`[DownloadManager] Moving: ${name} -> ${finalPath}`);
          },
          onMoveProgress: (copiedBytes, totalBytes, speed) => {
            const percent = Math.round((copiedBytes / totalBytes) * 100);
            const speedStr = formatSpeed(speed);
            console.log(`[DownloadManager] Copy progress: ${name} - ${percent}% @ ${speedStr}`);
            repository.updateDownloadStatusMessage(hash, `Copying... ${percent}% - ${speedStr}`);
          },
          onExtracting: (finalPath) => {
            repository.updateDownloadStatusMessage(hash, 'Extracting...');
            console.log(`[DownloadManager] Extracting: ${name}`);
          },
          onComplete: (finalPath) => {
            repository.updateDownloadState(hash, 'completed');
            console.log(`[DownloadManager] Completed: ${name} -> ${finalPath}`);
            this.processQueue();
          },
          onError: (error) => {
            repository.updateDownloadState(hash, 'error', error.message);
            console.error(`[DownloadManager] Error: ${name} - ${error.message}`);
            this.processQueue();
          },
          onPaused: () => {
            // State is already set to paused by the pause() method
            console.log(`[DownloadManager] Download paused callback: ${name}`);
          },
        }, download.totalSize, download.savePath);  // Pass known total size and save path from database
        return;
      }

      repository.updateDownloadState(hash, 'checking');
      console.log(`[DownloadManager] Processing: ${name}`);

      let link = originalLink;

      // Resolve dl-protect if needed
      if (isDlProtectLink(link)) {
        repository.updateDownloadStatusMessage(hash, 'Resolving dl-protect...');
        console.log(`[DownloadManager] Resolving dl-protect link...`);
        try {
          link = await resolveDlProtectLink(link);
          if (!link || link === originalLink) {
            throw new Error('Failed to resolve dl-protect link');
          }
        } catch (error: any) {
          repository.updateDownloadState(hash, 'error', `dl-protect failed: ${error.message}`);
          console.error(`[DownloadManager] dl-protect resolution failed: ${error.message}`);
          this.processQueue();
          return;
        }
      }

      // Check if the hoster link is valid (before debridding)
      repository.updateDownloadStatusMessage(hash, 'Verifying link...');
      try {
        const response = await fetch(link, { method: 'HEAD', redirect: 'follow' });
        if (response.status === 404) {
          repository.updateDownloadState(hash, 'error', 'Hoster link not found (404)');
          console.error(`[DownloadManager] Hoster link returned 404: ${link}`);
          this.processQueue();
          return;
        }
        // Check if redirected to an error page (e.g., rapidgator premium page)
        if (isErrorUrl(response.url)) {
          repository.updateDownloadState(hash, 'error', `Invalid hoster link (redirect to ${response.url})`);
          console.error(`[DownloadManager] Hoster link redirected to error page: ${response.url}`);
          this.processQueue();
          return;
        }
      } catch (error: any) {
        // HEAD request might fail for some hosts, continue anyway
        console.log(`[DownloadManager] HEAD request failed, continuing: ${error.message}`);
      }

      // Debrid if enabled
      if (isAnyDebridEnabled()) {
        repository.updateDownloadStatusMessage(hash, 'Debriding...');
        console.log(`[DownloadManager] Debriding link...`);
        try {
          const debridedUrl = await debridLink(link);
          if (!debridedUrl) {
            throw new Error('Debrid service did not return a link');
          }
          if (debridedUrl !== link) {
            repository.updateDownloadLink(hash, debridedUrl);
            link = debridedUrl;
          }
        } catch (error: any) {
          repository.updateDownloadState(hash, 'error', `Debrid failed: ${error.message}`);
          console.error(`[DownloadManager] Debrid failed: ${error.message}`);
          this.processQueue();
          return;
        }
      }

      // Get real filename from debrid link (with proper extension)
      // This also validates the debrid link (checks for 404, etc.)
      repository.updateDownloadStatusMessage(hash, 'Verifying debrided link...');
      let actualName = name;
      try {
        actualName = await getRealFilename(link, name);
        if (actualName !== name) {
          repository.updateDownloadName(hash, actualName);
          console.log(`[DownloadManager] Updated filename: ${name} -> ${actualName}`);
        }
      } catch (error: any) {
        // Check if it's an HTTP error (like 404)
        if (error.message.startsWith('HTTP ')) {
          repository.updateDownloadState(hash, 'error', `Link not found: ${error.message}`);
          console.error(`[DownloadManager] Debrid link error: ${error.message}`);
          this.processQueue();
          return;
        }
        // Other errors (like network issues or hosts not supporting HEAD) - continue anyway
        console.log(`[DownloadManager] Could not get real filename, using original: ${error.message}`);
      }

      // Start download
      repository.updateDownloadStatusMessage(hash, null);  // Clear status message
      repository.updateDownloadState(hash, 'downloading');

      startDownload(hash, link, actualName, {
        onProgress: (progress) => {
          repository.updateDownloadProgress(
            hash,
            progress.downloadedBytes,
            progress.totalBytes,
            progress.downloadSpeed
          );
        },
        onMoving: (finalPath) => {
          // Set progress to 100% and speed to 0 when moving starts
          const dl = repository.getDownloadByHash(hash);
          if (dl && dl.totalSize > 0) {
            repository.updateDownloadProgress(hash, dl.totalSize, dl.totalSize, 0);
          }
          repository.updateDownloadStatusMessage(hash, `Moving to ${finalPath}...`);
          console.log(`[DownloadManager] Moving: ${name} -> ${finalPath}`);
        },
        onMoveProgress: (copiedBytes, totalBytes, speed) => {
          const percent = Math.round((copiedBytes / totalBytes) * 100);
          const speedStr = formatSpeed(speed);
          console.log(`[DownloadManager] Copy progress: ${name} - ${percent}% @ ${speedStr}`);
          repository.updateDownloadStatusMessage(hash, `Copying... ${percent}% - ${speedStr}`);
        },
        onExtracting: (finalPath) => {
          repository.updateDownloadStatusMessage(hash, 'Extracting...');
          console.log(`[DownloadManager] Extracting: ${name}`);
        },
        onComplete: (finalPath) => {
          repository.updateDownloadState(hash, 'completed');
          console.log(`[DownloadManager] Completed: ${name} -> ${finalPath}`);
          this.processQueue();
        },
        onError: (error) => {
          repository.updateDownloadState(hash, 'error', error.message);
          console.error(`[DownloadManager] Error: ${name} - ${error.message}`);
          this.processQueue();
        },
        onPaused: () => {
          // State is already set to paused by the pause() method
          console.log(`[DownloadManager] Download paused callback: ${name}`);
        },
      }, undefined, savePath);  // Pass save path for category subfolder
    } catch (error: any) {
      repository.updateDownloadState(hash, 'error', error.message);
      console.error(`[DownloadManager] Processing error: ${name} - ${error.message}`);
      this.processQueue();
    }
  }

  /**
   * Resume downloads on startup
   */
  resumeOnStartup(): void {
    // Reset any stuck "checking" or "downloading" states to queued
    const checking = repository.getDownloadsByState('checking');
    const downloading = repository.getDownloadsByState('downloading');

    for (const download of [...checking, ...downloading]) {
      repository.updateDownloadState(download.hash, 'queued');
      console.log(`[DownloadManager] Reset stuck download: ${download.name}`);
    }

    // Start processing queue
    this.processQueue();
  }

  /**
   * Start auto-cleanup timer for completed downloads
   */
  startAutoCleanup(): void {
    const config = getConfig();
    if (config.autoRemoveCompletedAfter <= 0) {
      console.log('[DownloadManager] Auto-cleanup disabled (AUTO_REMOVE_COMPLETED_AFTER=0)');
      return;
    }

    console.log(`[DownloadManager] Auto-cleanup enabled: removing completed downloads after ${config.autoRemoveCompletedAfter} minutes`);

    // Check every minute
    setInterval(() => {
      this.cleanupCompletedDownloads();
    }, 60 * 1000);
  }

  /**
   * Remove completed downloads older than configured time
   */
  private async cleanupCompletedDownloads(): Promise<void> {
    const config = getConfig();
    if (config.autoRemoveCompletedAfter <= 0) return;

    const maxAgeMs = config.autoRemoveCompletedAfter * 60 * 1000;
    const now = Date.now();
    const completedDownloads = repository.getDownloadsByState('completed');

    for (const download of completedDownloads) {
      if (download.completedAt && (now - download.completedAt) > maxAgeMs) {
        console.log(`[DownloadManager] Auto-removing completed download: ${download.name} (completed ${Math.round((now - download.completedAt) / 60000)} minutes ago)`);
        repository.deleteDownload(download.hash);
      }
    }
  }
}

// Singleton instance
export const downloadManager = new DownloadManager();

// Start auto-cleanup on module load
downloadManager.startAutoCleanup();
