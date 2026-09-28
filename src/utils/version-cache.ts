import * as fs from 'fs/promises';
import { writeFileAtomically } from './atomic-write.js';
import { logger } from './logger.js';
import { getCodemiePath } from './paths.js';
import { getLatestVersion } from './processes.js';

const TTL_MS = 24 * 60 * 60 * 1000;
// keeps a stale/first-run lookup from stalling agent startup; exported so callers racing this
// lookup against their own timeout (e.g. `codemie setup`) can size their timeout with margin.
export const FETCH_TIMEOUT_MS = 3000;

interface CacheEntry {
	version: string;
	fetchedAt: string;
}

interface CacheFile {
	version: 1;
	packages: Record<string, CacheEntry>;
}

const filePath = (): string => getCodemiePath('version-cache.json');
const emptyCache = (): CacheFile => ({ version: 1, packages: {} });

// Serializes every cache write (including clear) behind an in-process promise chain so
// concurrent callers (e.g. `Promise.all` over all agents in `checkAllAgentsForUpdates`) can't
// interleave a read-modify-write and silently drop each other's freshly-fetched entries.
let writeQueue: Promise<unknown> = Promise.resolve();
function enqueueCacheWrite<T>(task: () => Promise<T>): Promise<T> {
	const result = writeQueue.then(task, task);
	writeQueue = result.then(
		() => undefined,
		() => undefined
	);
	return result;
}

async function loadCache(): Promise<CacheFile> {
	try {
		const content = await fs.readFile(filePath(), 'utf-8');
		const parsed = JSON.parse(content) as unknown;
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			typeof (parsed as CacheFile).packages === 'object'
		) {
			return parsed as CacheFile;
		}
		return emptyCache();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === 'ENOENT') return emptyCache();
		logger.warn('[version-cache] corrupt or unreadable file — treating as empty', {
			error: String(error),
		});
		return emptyCache();
	}
}

// Atomic so a second codemie process reading the file mid-write sees the old or new
// version, never a torn one. Lost updates across processes remain possible — the
// worst case is one extra npm lookup.
async function saveCache(cache: CacheFile): Promise<void> {
	await writeFileAtomically(filePath(), JSON.stringify(cache, null, 2));
}

export async function getCachedLatestVersion(
	packageName: string,
	options: { forceRefresh?: boolean } = {}
): Promise<string | null> {
	const cache = await loadCache();
	const entry = cache.packages[packageName];
	const ageMs = entry ? Date.now() - Date.parse(entry.fetchedAt) : NaN;
	// A future fetchedAt (clock skew, hand-edited file) must not count as fresh forever.
	const withinTtl = !!entry && ageMs >= 0 && ageMs < TTL_MS;
	if (withinTtl && !options.forceRefresh) return entry.version;

	// On a failed fetch, an entry still inside its TTL is as current as a normal cache hit;
	// an expired one could be arbitrarily old and must not be presented as current, so
	// the check is skipped instead. Failures aren't cached, so the next call retries.
	const onFetchFailure = (reason: string): string | null => {
		logger.warn('[version-cache] live version lookup failed', {
			packageName,
			reason,
			usingCachedEntry: withinTtl,
		});
		return withinTtl && entry ? entry.version : null;
	};

	let live: string | null;
	try {
		live = await getLatestVersion(packageName, { timeout: FETCH_TIMEOUT_MS });
	} catch (error) {
		return onFetchFailure(String(error));
	}
	if (!live) return onFetchFailure('no version returned (offline, registry error or timeout)');

	// Scoped write: only this package's entry changes. Re-read the cache at write time
	// (inside the serialized queue) rather than reusing the pre-fetch snapshot, so a
	// concurrent refresh of another package isn't clobbered by this one. A failed write
	// must not discard the value that was just fetched.
	const fetched = live;
	try {
		await enqueueCacheWrite(async () => {
			const latest = await loadCache();
			latest.packages[packageName] = { version: fetched, fetchedAt: new Date().toISOString() };
			await saveCache(latest);
		});
	} catch (error) {
		logger.warn('[version-cache] failed to persist fetched version', {
			packageName,
			error: String(error),
		});
	}
	return fetched;
}

export async function clearVersionCache(): Promise<{ removed: number }> {
	return enqueueCacheWrite(async () => {
		const file = filePath();
		const cache = await loadCache();
		const removed = Object.keys(cache.packages).length;
		try {
			await fs.unlink(file);
			return { removed };
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') return { removed: 0 };
			logger.warn('[version-cache] clear() failed; cache left in place', { file, code });
			return { removed: 0 };
		}
	});
}
