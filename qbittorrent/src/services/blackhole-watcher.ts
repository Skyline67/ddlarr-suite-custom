import * as fs from 'fs';
import * as path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import { getConfig } from '../config.js';
import { downloadManager } from './download-manager.js';

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
  private watcher: FSWatcher | null = null;
  private processing: Set<string> = new Set();
  private failedPath: string = '';

  /**
   * Start watching the blackhole folder
   */
  async start(): Promise<void> {
    const config = getConfig();

    if (!config.blackhole.enabled) {
      console.log('[Blackhole] Disabled');
      return;
    }

    const watchPath = config.blackhole.path;
    this.failedPath = path.join(watchPath, 'failed');

    // Ensure directories exist
    try {
      await fs.promises.mkdir(watchPath, { recursive: true });
      await fs.promises.mkdir(this.failedPath, { recursive: true });
      console.log(`[Blackhole] Watching folder: ${watchPath}`);
    } catch (error) {
      console.error(`[Blackhole] Error creating directories:`, error);
      return;
    }

    // Scan existing files first
    await this.scanExisting();

    // Start watching for new files
    this.watcher = chokidar.watch(watchPath, {
      ignored: [
        /(^|[\/\\])\../,         // Ignore dotfiles
        '**/failed/**',          // Ignore failed folder
      ],
      persistent: true,
      depth: 0,                  // Only watch top level
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100,
      },
    });

    this.watcher.on('add', (filePath) => {
      if (this.isValidTorrent(filePath)) {
        this.processFile(filePath);
      }
    });

    this.watcher.on('error', (error) => {
      console.error('[Blackhole] Watcher error:', error);
    });

    console.log('[Blackhole] Watcher started');
  }

  /**
   * Stop watching
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      console.log('[Blackhole] Watcher stopped');
    }
  }

  /**
   * Scan and process existing .torrent files
   */
  private async scanExisting(): Promise<void> {
    const config = getConfig();
    const watchPath = config.blackhole.path;

    try {
      const files = await fs.promises.readdir(watchPath);
      const torrentFiles = files.filter(f => this.isValidTorrent(f));

      if (torrentFiles.length > 0) {
        console.log(`[Blackhole] Found ${torrentFiles.length} existing torrent files`);
        for (const file of torrentFiles) {
          await this.processFile(path.join(watchPath, file));
        }
      }
    } catch (error) {
      console.error('[Blackhole] Error scanning existing files:', error);
    }
  }

  /**
   * Check if a file is a valid torrent file
   */
  private isValidTorrent(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
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
