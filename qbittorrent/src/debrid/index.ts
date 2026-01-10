import { DebridService, DebridTorrentStatus, DebridFileInfo } from './base.js';
import { AllDebridClient } from './alldebrid.js';
import { RealDebridClient } from './realdebrid.js';
import { PremiumizeClient } from './premiumize.js';

export type { DebridTorrentStatus, DebridFileInfo } from './base.js';

// All available debrid services
export const debridServices: DebridService[] = [
  new AllDebridClient(),
  new RealDebridClient(),
  new PremiumizeClient(),
];

/**
 * Get all enabled debrid services
 */
export function getEnabledDebridServices(): DebridService[] {
  return debridServices.filter(service => service.isEnabled());
}

/**
 * Check if any debrid service is configured
 */
export function isAnyDebridConfigured(): boolean {
  return debridServices.some(service => service.isConfigured());
}

/**
 * Check if any debrid service is enabled
 */
export function isAnyDebridEnabled(): boolean {
  return debridServices.some(service => service.isEnabled());
}

/**
 * Debrid a link using the first available service
 * Tries each enabled service in order until one succeeds
 * Returns the original link if all services fail
 */
export async function debridLink(link: string): Promise<string> {
  const enabledServices = getEnabledDebridServices();

  if (enabledServices.length === 0) {
    console.log('[Debrid] No debrid service enabled, returning original link');
    return link;
  }

  for (const service of enabledServices) {
    try {
      const debridedLink = await service.debridLink(link);
      if (debridedLink && debridedLink !== link) {
        console.log(`[Debrid] Successfully debrided with ${service.name}`);
        return debridedLink;
      }
    } catch (error: any) {
      console.warn(`[Debrid] ${service.name} failed: ${error.message}`);
      // Continue to next service
    }
  }

  console.warn('[Debrid] All services failed, returning original link');
  return link;
}

/**
 * Test connection to a specific debrid service
 */
export async function testDebridService(serviceName: string): Promise<boolean> {
  const service = debridServices.find(
    s => s.name.toLowerCase() === serviceName.toLowerCase()
  );

  if (!service) {
    console.error(`[Debrid] Service not found: ${serviceName}`);
    return false;
  }

  return service.testConnection();
}

export type { DebridService } from './base.js';

/**
 * Get all enabled debrid services that support torrents
 */
export function getTorrentEnabledServices(): DebridService[] {
  return debridServices.filter(service => service.isEnabled() && service.supportsTorrents());
}

/**
 * Result of debrid torrent upload and processing
 */
export interface DebridTorrentResult {
  service: string;
  torrentId: string;
  downloadLinks: string[];
  files?: DebridFileInfo[];  // File info with paths for multi-file torrents
  totalSize?: number;  // Total size in bytes from debrid status
}

/**
 * Upload a torrent to a debrid service and wait for it to be ready
 * Polls the service until the torrent is ready or an error occurs
 */
export async function debridTorrent(
  torrentBuffer: Buffer,
  filename: string,
  onStatusUpdate?: (status: DebridTorrentStatus, serviceName: string) => void,
  timeoutMs: number = 24 * 60 * 60 * 1000, // 24 hours default
  pollIntervalMs: number = 5000
): Promise<DebridTorrentResult> {
  const enabledServices = getTorrentEnabledServices();

  if (enabledServices.length === 0) {
    throw new Error('No debrid service with torrent support is enabled');
  }

  let lastError: Error | null = null;

  for (const service of enabledServices) {
    try {
      console.log(`[Debrid] Trying ${service.name} for torrent upload...`);

      // Upload torrent
      const torrentId = await service.uploadTorrent(torrentBuffer, filename);
      console.log(`[Debrid] ${service.name}: Torrent uploaded with id ${torrentId}`);

      // Poll for completion
      const startTime = Date.now();

      while (Date.now() - startTime < timeoutMs) {
        const status = await service.getTorrentStatus(torrentId);

        if (onStatusUpdate) {
          onStatusUpdate(status, service.name);
        }

        // Check if ready - prefer files array over downloadLinks
        const hasFiles = status.files && status.files.length > 0;
        const hasLinks = status.downloadLinks && status.downloadLinks.length > 0;

        if (status.status === 'ready' && (hasFiles || hasLinks)) {
          const fileCount = hasFiles ? status.files!.length : status.downloadLinks!.length;
          console.log(`[Debrid] ${service.name}: Torrent ready with ${fileCount} file(s), size: ${status.totalSize}`);
          return {
            service: service.name,
            torrentId,
            downloadLinks: status.downloadLinks || status.files!.map(f => f.link),
            files: status.files,
            totalSize: status.totalSize,
          };
        }

        if (status.status === 'error') {
          throw new Error(status.errorMessage || 'Torrent processing failed');
        }

        // Wait before next poll
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }

      throw new Error(`Timeout waiting for torrent after ${Math.round(timeoutMs / 1000 / 60)} minutes`);
    } catch (error: any) {
      console.warn(`[Debrid] ${service.name} failed: ${error.message}`);
      lastError = error;
      // Continue to next service
    }
  }

  throw lastError || new Error('All debrid services failed to process torrent');
}
