import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from '../config.js';
import { downloadManager } from './download-manager.js';

const POLL_INTERVAL = 60 * 1000;  // 1 minute
const STABLE_FILE_CHECK_INTERVAL = 500;  // ms between size checks
const STABLE_FILE_TIMEOUT = 5000;        // max time to wait for stable file

/**
 * Wait for a file to have a stable size (not being written to)
 */
async function waitForStableFile(filePath: string): Promise<boolean> {
  let lastSize = -1;
  const startTime = Date.now();

  while (Date.now() - startTime < STABLE_FILE_TIMEOUT) {
    try {
      const stats = await fs.promises.stat(filePath);
      if (stats.size === lastSize && lastSize > 0) {
        return true;
      }
      lastSize = stats.size;
    } catch {
      return false;  // File no longer exists
    }
    await new Promise(resolve => setTimeout(resolve, STABLE_FILE_CHECK_INTERVAL));
  }

  // Timeout - file might still be valid if it has size
  return lastSize > 0;
}

class BlackholeWatcher {
  private pollInterval: NodeJS.Timeout | null = null;
  private processing: Set<string> = new Set();
  private failedPath: string = '';
  private watchPath: string = '';

  /**
   * Start watching the blackhole folder with polling
   */
  async start(): Promise<void> {
    const config = getConfig();

    if (!config.blackhole.enabled) {
      console.log('[Blackhole] Disabled');
      return;
    }

    this.watchPath = config.blackhole.path;
    this.failedPath = path.join(this.watchPath, 'failed');

    // Ensure directories exist
    try {
      await fs.promises.mkdir(this.watchPath, { recursive: true });
      await fs.promises.mkdir(this.failedPath, { recursive: true });
      console.log(`[Blackhole] Watching folder: ${this.watchPath}`);
    } catch (error) {
      console.error(`[Blackhole] Error creating directories:`, error);
      return;
    }

    // Scan existing files immediately
    await this.scanFolder();

    // Start polling
    this.pollInterval = setInterval(() => {
      this.scanFolder();
    }, POLL_INTERVAL);

    console.log(`[Blackhole] Watcher started (polling every ${POLL_INTERVAL / 1000}s)`);
  }

  /**
   * Stop watching
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
      console.log('[Blackhole] Watcher stopped');
    }
  }

  /**
   * Scan folder for .torrent files and process them
   */
  private async scanFolder(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.watchPath);

      for (const file of files) {
        if (this.isValidTorrent(file)) {
          const filePath = path.join(this.watchPath, file);
          await this.processFile(filePath);
        }
      }
    } catch (error) {
      console.error('[Blackhole] Error scanning folder:', error);
    }
  }

  /**
   * Check if a file is a valid torrent file
   */
  private isValidTorrent(filename: string): boolean {
    const ext = path.extname(filename).toLowerCase();
    return ext === '.torrent';
  }

  /**
   * Process a torrent file
   */
  private async processFile(filePath: string): Promise<void> {
    // Prevent duplicate processing
    if (this.processing.has(filePath)) {
      return;
    }
    this.processing.add(filePath);

    const filename = path.basename(filePath);
    console.log(`[Blackhole] Processing: ${filename}`);

    try {
      // Wait for file to be fully written
      const isStable = await waitForStableFile(filePath);
      if (!isStable) {
        console.warn(`[Blackhole] File not stable or disappeared: ${filename}`);
        this.processing.delete(filePath);
        return;
      }

      // Read torrent data
      const torrentData = await fs.promises.readFile(filePath);

      // Add to download manager
      const config = getConfig();
      const hash = await downloadManager.addTorrent(torrentData, {
        category: config.blackhole.category || undefined,
        paused: false,
      });

      console.log(`[Blackhole] Added torrent: ${filename} (hash: ${hash})`);

      // Delete the torrent file
      await fs.promises.unlink(filePath);
      console.log(`[Blackhole] Deleted: ${filename}`);

    } catch (error) {
      console.error(`[Blackhole] Error processing ${filename}:`, error);

      // Move to failed folder
      try {
        const failedFilePath = path.join(this.failedPath, filename);
        await fs.promises.rename(filePath, failedFilePath);
        console.log(`[Blackhole] Moved to failed: ${filename}`);
      } catch (moveError) {
        console.error(`[Blackhole] Error moving to failed:`, moveError);
      }
    } finally {
      this.processing.delete(filePath);
    }
  }
}

export const blackholeWatcher = new BlackholeWatcher();
