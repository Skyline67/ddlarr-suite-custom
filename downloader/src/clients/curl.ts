import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { DownloadClient } from './base.js';
import { getConfig } from '../utils/config.js';

export interface DownloadProgress {
  filename: string;
  url: string;
  progress: number; // 0-100
  speed: string;
  size: string;
  downloaded: string;
  status: 'downloading' | 'completed' | 'failed';
  startedAt: Date;
}

// Track active downloads for progress reporting
const activeDownloads: Map<string, DownloadProgress> = new Map();

export function getActiveDownloads(): DownloadProgress[] {
  return Array.from(activeDownloads.values());
}

/**
 * curl client - downloads directly using curl command
 * Downloads to temp directory first, then moves to destination
 */
export class CurlClient implements DownloadClient {
  name = 'curl';

  isEnabled(): boolean {
    const config = getConfig().curl;
    return config.enabled && !!config.destinationPath;
  }

  async testConnection(): Promise<boolean> {
    const config = getConfig().curl;
    console.log('[curl] Testing connection...');
    console.log(`[curl] Config: destinationPath=${config.destinationPath}`);

    if (!config.destinationPath) {
      console.log('[curl] Missing required field: destinationPath');
      return false;
    }

    // Check if destination path exists
    if (!fs.existsSync(config.destinationPath)) {
      console.log(`[curl] Destination path does not exist: ${config.destinationPath}`);
      return false;
    }

    // Check if curl is available
    return new Promise((resolve) => {
      const proc = spawn('curl', ['--version']);
      proc.on('close', (code) => {
        if (code === 0) {
          console.log('[curl] curl is available');
          resolve(true);
        } else {
          console.log('[curl] curl is not available');
          resolve(false);
        }
      });
      proc.on('error', () => {
        console.log('[curl] curl is not available');
        resolve(false);
      });
    });
  }

  async addDownload(url: string, filename?: string): Promise<boolean> {
    if (!this.isEnabled()) {
      console.warn('[curl] Not enabled');
      return false;
    }

    const config = getConfig().curl;

    // Determine filename
    let finalFilename = filename || this.extractFilename(url);

    // Add extension from URL if missing
    const hasExtension = /\.[a-zA-Z0-9]{2,4}$/.test(finalFilename);
    if (!hasExtension) {
      const urlMatch = url.match(/\.([a-zA-Z0-9]{2,4})(?:\?|$)/);
      if (urlMatch) {
        finalFilename = `${finalFilename}.${urlMatch[1]}`;
        console.log(`[curl] Added extension from URL: ${urlMatch[1]}`);
      }
    }

    // Use .tmp subdirectory in destination to avoid cross-device rename issues
    const tempDir = path.join(config.destinationPath, '.tmp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempPath = path.join(tempDir, `curl_${Date.now()}_${finalFilename}`);
    const finalPath = path.join(config.destinationPath, finalFilename);

    console.log(`[curl] Downloading: ${url}`);
    console.log(`[curl] Temp path: ${tempPath}`);
    console.log(`[curl] Final path: ${finalPath}`);

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
      // curl with progress output
      // -L: follow redirects
      // -o: output file
      // --progress-bar: show progress
      // -#: progress bar mode (easier to parse)
      const proc = spawn('curl', [
        '-L',
        '-o', tempPath,
        '-#',
        '--fail',
        '-w', '%{size_download} %{speed_download}',
        url,
      ]);

      let lastProgress = 0;

      proc.stderr.on('data', (data: Buffer) => {
        const output = data.toString();
        // Parse progress from curl's progress bar output
        // Format: ###                                                          5.2%
        const progressMatch = output.match(/(\d+\.?\d*)%/);
        if (progressMatch) {
          lastProgress = parseFloat(progressMatch[1]);
          progress.progress = lastProgress;
          console.log(`[curl] Progress: ${lastProgress.toFixed(1)}%`);
        }
      });

      proc.stdout.on('data', (data: Buffer) => {
        const output = data.toString().trim();
        // Parse final stats: size speed
        const parts = output.split(' ');
        if (parts.length >= 2) {
          progress.downloaded = this.formatBytes(parseInt(parts[0], 10));
          progress.speed = this.formatBytes(parseFloat(parts[1])) + '/s';
        }
      });

      proc.on('close', (code) => {
        if (code === 0) {
          // Move file from temp to final destination
          try {
            fs.renameSync(tempPath, finalPath);
            console.log(`[curl] Download complete: ${finalPath}`);
            progress.progress = 100;
            progress.status = 'completed';

            // Remove from active downloads after a delay
            setTimeout(() => activeDownloads.delete(downloadId), 60000);
            resolve(true);
          } catch (moveError: any) {
            console.error(`[curl] Error moving file: ${moveError.message}`);
            // Try copy + delete if rename fails (cross-device)
            try {
              fs.copyFileSync(tempPath, finalPath);
              fs.unlinkSync(tempPath);
              console.log(`[curl] Download complete (copy mode): ${finalPath}`);
              progress.progress = 100;
              progress.status = 'completed';
              setTimeout(() => activeDownloads.delete(downloadId), 60000);
              resolve(true);
            } catch (copyError: any) {
              console.error(`[curl] Error copying file: ${copyError.message}`);
              progress.status = 'failed';
              setTimeout(() => activeDownloads.delete(downloadId), 60000);
              resolve(false);
            }
          }
        } else {
          console.error(`[curl] Download failed with code ${code}`);
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
        console.error(`[curl] Process error: ${error.message}`);
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

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
}
