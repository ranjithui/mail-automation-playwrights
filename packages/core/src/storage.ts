/**
 * Attachment storage.
 *
 * Behind a tiny interface so the local disk driver can be swapped for S3, GCS
 * or Azure Blob later without touching call sites. Files are stored under
 * opaque names and only ever served through an authorised API route - the
 * storage directory is never exposed as a static mount.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { env } from '@mail/config';

export interface StoredFile {
  filename: string;
  storagePath: string;
  size: number;
  checksum: string;
}

export interface StorageDriver {
  save(buffer: Buffer, originalName: string): Promise<StoredFile>;
  resolve(storagePath: string): string;
  remove(storagePath: string): Promise<void>;
  exists(storagePath: string): boolean;
}

class LocalStorage implements StorageDriver {
  async save(buffer: Buffer, originalName: string): Promise<StoredFile> {
    const ext = path.extname(originalName).slice(0, 12);
    const filename = `${crypto.randomBytes(16).toString('hex')}${ext}`;
    const target = path.join(env.storageDir, filename);
    await fs.promises.writeFile(target, buffer);
    return {
      filename,
      storagePath: filename,
      size: buffer.byteLength,
      checksum: crypto.createHash('sha256').update(buffer).digest('hex'),
    };
  }

  resolve(storagePath: string): string {
    // Guards against traversal in a stored path.
    const safe = path.basename(storagePath);
    return path.join(env.storageDir, safe);
  }

  async remove(storagePath: string): Promise<void> {
    await fs.promises.rm(this.resolve(storagePath), { force: true });
  }

  exists(storagePath: string): boolean {
    return fs.existsSync(this.resolve(storagePath));
  }
}

export const storage: StorageDriver = new LocalStorage();

const ALLOWED_MIME = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip',
  'application/x-zip-compressed',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain',
  'text/csv',
]);

export function isAllowedUpload(mimeType: string): boolean {
  return ALLOWED_MIME.has(mimeType);
}
