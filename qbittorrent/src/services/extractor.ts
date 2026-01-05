import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// Supported archive extensions
const ARCHIVE_EXTENSIONS = [
  '.zip',
  '.rar',
  '.7z',
  '.tar',
  '.tar.gz',
  '.tgz',
  '.tar.bz2',
  '.tbz2',
  '.tar.xz',
  '.txz',
];

/**
 * Check if a file is an archive based on its extension
 */
export function isArchive(filename: string): boolean {
  const lowerFilename = filename.toLowerCase();
  return ARCHIVE_EXTENSIONS.some(ext => lowerFilename.endsWith(ext));
}

/**
 * Get the archive type from filename
 */
function getArchiveType(filename: string): 'zip' | 'rar' | '7z' | 'tar' | null {
  const lowerFilename = filename.toLowerCase();

  if (lowerFilename.endsWith('.zip')) return 'zip';
  if (lowerFilename.endsWith('.rar')) return 'rar';
  if (lowerFilename.endsWith('.7z')) return '7z';
  if (
    lowerFilename.endsWith('.tar') ||
    lowerFilename.endsWith('.tar.gz') ||
    lowerFilename.endsWith('.tgz') ||
    lowerFilename.endsWith('.tar.bz2') ||
    lowerFilename.endsWith('.tbz2') ||
    lowerFilename.endsWith('.tar.xz') ||
    lowerFilename.endsWith('.txz')
  ) {
    return 'tar';
  }

  return null;
}

/**
 * Execute a command and return a promise
 */
function execCommand(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
      }
    });

    proc.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Extract an archive to the destination directory
 * Returns the list of extracted files
 */
export async function extractArchive(archivePath: string, destDir: string): Promise<string[]> {
  const archiveType = getArchiveType(archivePath);

  if (!archiveType) {
    throw new Error(`Unsupported archive type: ${archivePath}`);
  }

  console.log(`[Extractor] Extracting ${archiveType} archive: ${archivePath}`);
  console.log(`[Extractor] Destination: ${destDir}`);

  // Ensure destination directory exists
  if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
  }

  try {
    switch (archiveType) {
      case 'zip':
        await execCommand('unzip', ['-o', '-q', archivePath, '-d', destDir], destDir);
        break;

      case 'rar':
        // Use bsdtar from libarchive-tools (unrar is not available in Alpine)
        await execCommand('bsdtar', ['-xf', archivePath, '-C', destDir], destDir);
        break;

      case '7z':
        await execCommand('7z', ['x', `-o${destDir}`, '-y', archivePath], destDir);
        break;

      case 'tar':
        await execCommand('tar', ['-xf', archivePath, '-C', destDir], destDir);
        break;
    }

    console.log(`[Extractor] Extraction complete: ${archivePath}`);

    // Get list of extracted files (top-level only)
    const extractedFiles = fs.readdirSync(destDir)
      .filter(f => f !== path.basename(archivePath))
      .map(f => path.join(destDir, f));

    return extractedFiles;
  } catch (error: any) {
    console.error(`[Extractor] Extraction failed: ${error.message}`);
    throw new Error(`Extraction failed: ${error.message}`);
  }
}

/**
 * Delete a file (used to remove archive after extraction)
 */
export async function deleteFile(filePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fs.unlink(filePath, (err) => {
      if (err) {
        console.error(`[Extractor] Failed to delete file: ${filePath} - ${err.message}`);
        reject(err);
      } else {
        console.log(`[Extractor] Deleted archive: ${filePath}`);
        resolve();
      }
    });
  });
}
