import { existsSync } from 'node:fs';
import { mkdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Write a file via a temp file + rename, so a concurrent reader or writer (including
 * another process) never observes a half-written file. Keeps an existing file's mode;
 * new files are created 0600.
 */
export async function writeFileAtomically(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });

  const tempPath = `${filePath}.${process.pid}.tmp`;
  const mode = existsSync(filePath) ? (await stat(filePath)).mode & 0o777 : 0o600;

  try {
    await writeFile(tempPath, content, { encoding: 'utf-8', mode });
    await rename(tempPath, filePath);
  } catch (error) {
    try {
      await unlink(tempPath);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }
}
