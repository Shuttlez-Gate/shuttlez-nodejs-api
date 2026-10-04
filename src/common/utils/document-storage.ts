import { existsSync, readFileSync } from 'fs';
import { isAbsolute, join } from 'path';

export const DRIVER_DOCUMENT_MEDIA_PREFIX = '/api/v1/media/driver-documents';

export function driverDocumentMediaUrl(id: string): string {
  return `${DRIVER_DOCUMENT_MEDIA_PREFIX}/${id}`;
}

export function toDataUrlStoragePath(
  file: { mimetype?: string; buffer: Buffer },
): string {
  const mime = file.mimetype?.trim() || 'application/octet-stream';
  return `data:${mime};base64,${file.buffer.toString('base64')}`;
}

export function resolveUploadDir(): string {
  const configured = process.env.UPLOAD_DIR?.trim();
  const serverless = Boolean(
    process.env.VERCEL ||
      process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.LAMBDA_TASK_ROOT,
  );
  if (serverless) {
    if (configured?.startsWith('/tmp')) return configured;
    return join('/tmp', configured || 'uploads');
  }
  return configured || 'uploads';
}

export function readStoredDocument(
  storagePath: string,
  contentType?: string | null,
): { buffer: Buffer; contentType: string } | null {
  const path = storagePath?.trim();
  if (!path) return null;

  if (path.startsWith('data:')) {
    const match = path.match(/^data:([^;,]+);base64,(.+)$/s);
    if (!match) return null;
    return {
      contentType: match[1] || contentType || 'application/octet-stream',
      buffer: Buffer.from(match[2], 'base64'),
    };
  }

  if (path.startsWith('http://') || path.startsWith('https://')) {
    return null;
  }

  const candidates = [
    path,
    isAbsolute(path) ? path : join(process.cwd(), path),
    join(resolveUploadDir(), path),
    join(process.cwd(), 'uploads', path),
    join('/tmp/uploads', path),
  ];
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    try {
      return {
        contentType: contentType || 'application/octet-stream',
        buffer: readFileSync(candidate),
      };
    } catch {
      continue;
    }
  }
  return null;
}

export function isImageContent(contentType?: string | null, fileName?: string | null): boolean {
  if ((contentType ?? '').toLowerCase().startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|bmp|heic|svg)$/i.test(fileName ?? '');
}
