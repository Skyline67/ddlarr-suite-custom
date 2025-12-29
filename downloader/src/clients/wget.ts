import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DownloadClient } from './base.js';
import { getConfig } from '../utils/config.js';
import { DownloadProgress } from './curl.js';

// Track active downloads for progress reporting
const activeDownloads: Map<string, DownloadProgress> = new Map();

export function getWgetActiveDownloads(): DownloadProgress[] {
  return Array.from(activeDownloads.values());
}

/**
 * wget client - downloads directly using wget command
 * Downloads to temp directory first, then moves to destination
 */
export class WgetClient implements DownloadClient {
  name = 'wget';

  isEnabled(): boolean {
    const config = getConfig().wget;
    return config.enabled && !!config.destinationPath;
  }

  async testConnection(): Promise<boolean> {
    const config = getConfig().wget;
    console.log('[wget] Testing connection...');
    console.log(`[wget] Config: destinationPath=${config.destinationPath}`);

    if (!config.destinationPath) {
      console.log('[wget] Missing required field: destinationPath');
      return false;
    }

    // Check if destination path exists
    if (!fs.existsSync(config.destinationPath)) {
      console.log(`[wget] Destination path does not exist: ${config.destinationPath}`);
      return false;
    }

    // Check if wget is available
    return new Promise((resolve) => {
      const proc = spawn('wget', ['--version']);
      proc.on('close', (code) => {
        if (code === 0) {
          console.log('[wget] wget is available');
          resolve(true);
        } else {
          console.log('[wget] wget is not available');
          resolve(false);
        }
      });
      proc.on('error', () => {
        console.log('[wget] wget is not available');
        resolve(false);
      });
    });
  }

  async addDownload(url: string, filename?: string): Promise<boolean> {
    if (!this.isEnabled()) {
      console.warn('[wget] Not enabled');
      return false;
    }

    const config = getConfig().wget;

    // Determine filename
    let finalFilename = filename || this.extractFilename(url);

    // Add extension from URL if missing
    const hasExtension = /\.[a-zA-Z0-9]{2,4}$/.test(finalFilename);
    if (!hasExtension) {
      const urlMatch = url.match(/\.([a-zA-Z0-9]{2,4})(?:\?|$)/);
      if (urlMatch) {
        finalFilename = `${finalFilename}.${urlMatch[1]}`;
        console.log(`[wget] Added extension from URL: ${urlMatch[1]}`);
      }
    }

    // Use .tmp subdirectory in destination to avoid cross-device rename issues
    const tempDir = path.join(config.destinationPath, '.tmp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempPath = path.join(tempDir, `wget_${Date.now()}_${finalFilename}`);
    const finalPath = path.join(config.destinationPath, finalFilename);

    console.log(`[wget] Downloading: ${url}`);
    console.log(`[wget] Temp path: ${tempPath}`);
    console.log(`[wget] Final path: ${finalPath}`);

    const downloadId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    // Initialize progress tracking
    const progress: DownloadProgress = {
      filename: finalFilename,
      url,
      progress: 0,
      speed: '0 B/s',
      size: 'Unknown',
      downloaded: '0 B',
      status: 'downloading',
      startedAt: new Date(),
    };
    activeDownloads.set(downloadId, progress);

    return new Promise((resolve) => {
      // wget with progress output
      // --progress=dot:mega: show progress dots
      // -O: output file
      // -c: continue partial downloads
      const proc = spawn('wget', [
        '--progress=bar:force',
        '-O', tempPath,
        url,
      ]);

      proc.stderr.on('data', (data: Buffer) => {
        const output = data.toString();

        // Parse progress from wget output
        // Format: 50% [======>                    ] 1,234,567   500K/s
        const progressMatch = output.match(/(\d+)%/);
        if (progressMatch) {
          progress.progress = parseInt(progressMatch[1], 10);
          console.log(`[wget] Progress: ${progress.progress}%`);
        }

        // Parse speed
        const speedMatch = output.match(/([\d.,]+\s*[KMGT]?B?\/s)/i);
        if (speedMatch) {
          progress.speed = speedMatch[1];
        }

        // Parse size
        const sizeMatch = output.match(/([\d.,]+\s*[KMGT])/);
        if (sizeMatch) {
          progress.downloaded = sizeMatch[1];
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          // Move file from temp to final destination
          try {
            fs.renameSync(tempPath, finalPath);
            console.log(`[wget] Download complete: ${finalPath}`);
            progress.progress = 100;
            progress.status = 'completed';

            // Remove from active downloads after a delay
            setTimeout(() => activeDownloads.delete(downloadId), 60000);
            resolve(true);
          } catch (moveError: any) {
            console.error(`[wget] Error moving file: ${moveError.message}`);
            // Try copy + delete if rename fails (cross-device)
            try {
              fs.copyFileSync(tempPath, finalPath);
              fs.unlinkSync(tempPath);
              console.log(`[wget] Download complete (copy mode): ${finalPath}`);
              progress.progress = 100;
              progress.status = 'completed';
              setTimeout(() => activeDownloads.delete(downloadId), 60000);
              resolve(true);
            } catch (copyError: any) {
              console.error(`[wget] Error copying file: ${copyError.message}`);
              progress.status = 'failed';
              setTimeout(() => activeDownloads.delete(downloadId), 60000);
              resolve(false);
            }
          }
        } else {
          console.error(`[wget] Download failed with code ${code}`);
          // Cleanup temp file
          try {
            if (fs.existsSync(tempPath)) {
              fs.unlinkSync(tempPath);
            }
          } catch {}
          progress.status = 'failed';
          setTimeout(() => activeDownloads.delete(downloadId), 60000);
          resolve(false);
        }
      });

      proc.on('error', (error) => {
        console.error(`[wget] Process error: ${error.message}`);
        progress.status = 'failed';
        setTimeout(() => activeDownloads.delete(downloadId), 60000);
        resolve(false);
      });
    });
  }

  private extractFilename(url: string): string {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      const filename = path.basename(pathname);
      return filename || `download_${Date.now()}`;
    } catch {
      return `download_${Date.now()}`;
    }
  }
}
