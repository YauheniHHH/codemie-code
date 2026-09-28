import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const state = vi.hoisted(() => ({ dir: '' }));
const getLatestVersion = vi.hoisted(() => vi.fn());
const warn = vi.hoisted(() => vi.fn());

vi.mock('../paths.js', () => ({
  getCodemiePath: (name: string) => join(state.dir, name),
}));
vi.mock('../processes.js', () => ({ getLatestVersion }));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
}));

import { getCachedLatestVersion, refreshCachedLatestVersion } from '../version-cache.js';

const PKG = '@openai/codex';
const HOUR = 60 * 60 * 1000;

async function seedCache(version: string, ageMs: number): Promise<void> {
  const fetchedAt = new Date(Date.now() - ageMs).toISOString();
  await writeFile(
    join(state.dir, 'version-cache.json'),
    JSON.stringify({ version: 1, packages: { [PKG]: { version, fetchedAt } } }),
    'utf-8'
  );
}

describe('getCachedLatestVersion', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    state.dir = await mkdtemp(join(tmpdir(), 'codemie-version-cache-'));
  });

  afterEach(async () => {
    await rm(state.dir, { recursive: true, force: true });
  });

  it('serves a fresh entry without a network call', async () => {
    await seedCache('0.150.0', 1 * HOUR);

    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.150.0');
    expect(getLatestVersion).not.toHaveBeenCalled();
  });

  it('refreshes an expired entry and persists the new value', async () => {
    await seedCache('0.150.0', 25 * HOUR);
    getLatestVersion.mockResolvedValue('0.160.0');

    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.160.0');
    const saved = JSON.parse(await readFile(join(state.dir, 'version-cache.json'), 'utf-8'));
    expect(saved.packages[PKG].version).toBe('0.160.0');
  });

  it('returns null, not the expired entry, when the lookup returns nothing, and logs it', async () => {
    await seedCache('0.150.0', 25 * HOUR);
    getLatestVersion.mockResolvedValue(null);

    await expect(getCachedLatestVersion(PKG)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[version-cache] live version lookup failed',
      expect.objectContaining({ packageName: PKG, usingCachedEntry: false })
    );
  });

  it('returns null, not the expired entry, when the lookup throws', async () => {
    await seedCache('0.150.0', 25 * HOUR);
    getLatestVersion.mockRejectedValue(new Error('ENOTFOUND'));

    await expect(getCachedLatestVersion(PKG)).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('keeps an in-TTL entry when a forced refresh fails', async () => {
    await seedCache('0.150.0', 1 * HOUR);
    getLatestVersion.mockResolvedValue(null);

    await expect(getCachedLatestVersion(PKG, { forceRefresh: true })).resolves.toBe('0.150.0');
    expect(warn).toHaveBeenCalledWith(
      '[version-cache] live version lookup failed',
      expect.objectContaining({ usingCachedEntry: true })
    );
  });

  it('treats a fetchedAt in the future as stale rather than fresh forever', async () => {
    await seedCache('0.150.0', -48 * HOUR);
    getLatestVersion.mockResolvedValue('0.160.0');

    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.160.0');
    expect(getLatestVersion).toHaveBeenCalledTimes(1);
  });

  it('still returns the fetched version when the cache cannot be written', async () => {
    // A directory where the cache file should be makes the atomic rename fail.
    await mkdir(join(state.dir, 'version-cache.json'));
    getLatestVersion.mockResolvedValue('0.160.0');

    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.160.0');
    expect(warn).toHaveBeenCalledWith(
      '[version-cache] failed to persist fetched version',
      expect.objectContaining({ packageName: PKG })
    );
  });

  it('treats npm output that is not a version as a failure and does not cache it', async () => {
    getLatestVersion.mockResolvedValue('npm notice New major version of npm available!');

    await expect(getCachedLatestVersion(PKG)).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[version-cache] live version lookup failed',
      expect.objectContaining({ reason: 'unparsable npm output' })
    );
    await expect(readFile(join(state.dir, 'version-cache.json'), 'utf-8')).rejects.toThrow();
  });

  it('passes a prerelease string through unchanged so the resolver can reject it', async () => {
    getLatestVersion.mockResolvedValue('0.161.0-beta.1');

    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.161.0-beta.1');
  });

  it.each([
    ['packages is null', { version: 1, packages: null }],
    ['packages is an array', { version: 1, packages: [] }],
    ['an entry has the wrong shape', { version: 1, packages: { [PKG]: { version: 42 } } }],
  ])('recovers when %s, and heals the file on the next write', async (_label, content) => {
    await writeFile(join(state.dir, 'version-cache.json'), JSON.stringify(content), 'utf-8');
    getLatestVersion.mockResolvedValue('0.160.0');

    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.160.0');
    const saved = JSON.parse(await readFile(join(state.dir, 'version-cache.json'), 'utf-8'));
    expect(saved.packages[PKG].version).toBe('0.160.0');
  });

  it('does not cache a failure, so the next call retries', async () => {
    getLatestVersion.mockResolvedValueOnce(null).mockResolvedValueOnce('0.160.0');

    await expect(getCachedLatestVersion(PKG)).resolves.toBeNull();
    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.160.0');
    expect(getLatestVersion).toHaveBeenCalledTimes(2);
  });
});

describe('refreshCachedLatestVersion', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    state.dir = await mkdtemp(join(tmpdir(), 'codemie-version-cache-'));
  });

  afterEach(async () => {
    await rm(state.dir, { recursive: true, force: true });
  });

  it('re-checks a fresh entry against npm and stores the new value', async () => {
    await seedCache('0.150.0', 1 * HOUR);
    getLatestVersion.mockResolvedValue('0.160.0');

    await expect(refreshCachedLatestVersion(PKG)).resolves.toBe(true);
    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.160.0');
    expect(getLatestVersion).toHaveBeenCalledTimes(1);
  });

  it('keeps the existing entry when the lookup fails, instead of wiping it', async () => {
    await seedCache('0.150.0', 1 * HOUR);
    getLatestVersion.mockResolvedValue(null);

    await expect(refreshCachedLatestVersion(PKG)).resolves.toBe(false);
    await expect(getCachedLatestVersion(PKG)).resolves.toBe('0.150.0');
    expect(warn).toHaveBeenCalledWith(
      '[version-cache] forced version refresh failed',
      expect.objectContaining({ packageName: PKG })
    );
  });
});
