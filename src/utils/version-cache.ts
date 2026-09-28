import { readFile } from 'fs/promises';
import { writeFileAtomically } from './atomic-write.js';
import { logger } from './logger.js';
import { getCodemiePath } from './paths.js';
import { getLatestVersion } from './processes.js';

const TTL_MS = 24 * 60 * 60 * 1000;
// keeps a stale/first-run lookup from stalling agent startup; exported so callers racing this
// lookup against their own timeout (e.g. `codemie setup`) can size their timeout with margin.
export const FETCH_TIMEOUT_MS = 3000;

// What `npm view <pkg> version` prints for a real release. Prerelease/build suffixes are kept
// (not stripped) so version-resolution can still recognize and reject them.
const NPM_VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/;

interface CacheEntry {
	version: string;
	fetchedAt: string;
}

interface CacheFile {
	version: 1;
	packages: Record<string, CacheEntry>;
}

type FetchOutcome = { ok: true; version: string } | { ok: false; reason: string };

const filePath = (): string => getCodemiePath('version-cache.json');
const emptyCache = (): CacheFile => ({ version: 1, packages: {} });

// Serializes every cache write behind an in-process promise chain so concurrent callers
// (e.g. `Promise.all` over all agents in `checkAllAgentsForUpdates`) can't interleave a
// read-modify-write and silently drop each other's freshly-fetched entries.
let writeQueue: Promise<unknown> = Promise.resolve();
function enqueueCacheWrite<T>(task: () => Promise<T>): Promise<T> {
	const result = writeQueue.then(task, task);
	writeQueue = result.then(
		() => undefined,
		() => undefined
	);
	return result;
}

function isCacheEntry(value: unknown): value is CacheEntry {
	return (
		typeof value === 'object' &&
		value !== null &&
		typeof (value as CacheEntry).version === 'string' &&
		typeof (value as CacheEntry).fetchedAt === 'string'
	);
}

// Keeps only well-formed entries, so a hand-edited or partially corrupt file degrades to
// "not cached" and is healed by the next successful write instead of breaking every lookup.
async function loadCache(): Promise<CacheFile> {
	try {
		const content = await readFile(filePath(), 'utf-8');
		const packages = (JSON.parse(content) as { packages?: unknown } | null)?.packages;
		if (typeof packages !== 'object' || packages === null || Array.isArray(packages)) {
			return emptyCache();
		}
		const valid: Record<string, CacheEntry> = {};
		for (const [name, entry] of Object.entries(packages)) {
			if (isCacheEntry(entry)) valid[name] = entry;
		}
		return { version: 1, packages: valid };
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

// Fetches the package's npm `latest` and caches it. Failures (including output that isn't a
// version) are never cached, so the next call retries. A failed write keeps the fetched value.
async function fetchAndStore(packageName: string): Promise<FetchOutcome> {
	let raw: string | null;
	try {
		raw = await getLatestVersion(packageName, { timeout: FETCH_TIMEOUT_MS });
	} catch (error) {
		return { ok: false, reason: String(error) };
	}
	if (!raw) return { ok: false, reason: 'no version returned (offline, registry error or timeout)' };
	const version = raw.trim();
	if (!NPM_VERSION_PATTERN.test(version)) return { ok: false, reason: 'unparsable npm output' };

	// Scoped write: only this package's entry changes. Re-read the cache at write time
	// (inside the serialized queue) rather than reusing the pre-fetch snapshot, so a
	// concurrent refresh of another package isn't clobbered by this one.
	try {
		await enqueueCacheWrite(async () => {
			const latest = await loadCache();
			latest.packages[packageName] = { version, fetchedAt: new Date().toISOString() };
			await saveCache(latest);
		});
	} catch (error) {
		logger.warn('[version-cache] failed to persist fetched version', {
			packageName,
			error: String(error),
		});
	}
	return { ok: true, version };
}

/**
 * The package's npm `latest` version, served from a 24h cache. A cache miss (or `forceRefresh`)
 * fetches from npm. When that fetch fails, an entry still inside its TTL is returned; otherwise
 * `null`, so an expired value is never presented as current.
 *
 * @param packageName - npm package name, e.g. `@openai/codex`
 * @param options.forceRefresh - bypass the TTL and re-check npm now
 * @returns the version string, or `null` when no current value is available
 */
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

	const outcome = await fetchAndStore(packageName);
	if (outcome.ok) return outcome.version;

	// An entry still inside its TTL is as current as a normal cache hit; an expired one could
	// be arbitrarily old and must not be presented as current, so the check is skipped instead.
	logger.warn('[version-cache] live version lookup failed', {
		packageName,
		reason: outcome.reason,
		usingCachedEntry: withinTtl,
	});
	return withinTtl && entry ? entry.version : null;
}

/**
 * Re-check one package against npm regardless of its cache age (`codemie doctor
 * --refresh-versions`). On failure the existing entry is left as it is. Returns whether npm
 * answered with a version.
 */
export async function refreshCachedLatestVersion(packageName: string): Promise<boolean> {
	const outcome = await fetchAndStore(packageName);
	if (!outcome.ok) {
		logger.warn('[version-cache] forced version refresh failed', { packageName, reason: outcome.reason });
	}
	return outcome.ok;
}
