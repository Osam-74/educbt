/**
 * One door for every uploaded backup. A SaaS backup goes straight to the restore. A file made by the WordPress
 * plugin is read (every check, before any row is trusted), translated into the SaaS shape, and only then restored,
 * so the same chunked upload, tenancy, status and error handling serve both.
 */
import { encode } from './format';
import { translatePluginBackup, type TranslateReport } from './from-plugin';
import { looksLikePluginFile, readPluginFile, PluginFileError } from './read-plugin-file';

export type PreparedUpload = { file: Buffer; source: 'saas' | 'plugin'; report: TranslateReport | null };

export function prepareUploadedFile(file: Buffer): PreparedUpload {
  if (!looksLikePluginFile(file)) return { file, source: 'saas', report: null };
  const plugin = readPluginFile(file);               // throws PluginFileError: refused whole, nothing half-read
  const { document, report } = translatePluginBackup(plugin);
  return { file: encode(document), source: 'plugin', report };
}

export { PluginFileError };
