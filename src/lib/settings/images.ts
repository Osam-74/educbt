import sharp from 'sharp';
import { SettingsError } from './service';

/** Decode and re-encode raster bytes, stripping metadata and any appended data.
 * Small DB-backed PNGs make server/PDF rendering independent of expiring URLs.
 */
export async function normalizeImage(file: File): Promise<string> {
  if (!file.size || file.size > 2 * 1024 * 1024) throw new SettingsError('Choose a PNG or JPEG smaller than 2 MB.');
  try {
    const bytes = Buffer.from(await file.arrayBuffer());
    const decoded = sharp(bytes, { limitInputPixels: 16_000_000, animated: false, failOn: 'warning' });
    const metadata = await decoded.metadata();
    if (!['png', 'jpeg'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('Raster only');
    const png = await decoded.rotate().resize({ width: 600, height: 600, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
    const data = 'data:image/png;base64,' + png.toString('base64');
    if (data.length > 400000) throw new Error('Too large');
    return data;
  } catch { throw new SettingsError('That image could not be read. Choose a smaller PNG or JPEG.'); }
}
