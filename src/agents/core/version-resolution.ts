import { getCachedLatestVersion } from '../../utils/version-cache.js';
import { extractVersion } from '../../utils/version-utils.js';
import { ConfigLoader } from '../../utils/config.js';
import { logger } from '../../utils/logger.js';

// kimi-acp runs the same package and binary as kimi (only its launch args differ).
export const LIVE_TRACKED_AGENT_NAMES = ['claude', 'codex', 'gemini', 'kimi', 'kimi-acp', 'copilot-cli'] as const;

export function isLiveTrackedAgent(agentName: string): boolean {
	return (LIVE_TRACKED_AGENT_NAMES as readonly string[]).includes(agentName);
}

export interface ResolveSupportedVersionInput {
	agentName: string;
	npmPackage?: string | null;
	fallbackSupportedVersion?: string;
	/** Bypass the 24h cache TTL for this package's lookup only (does not touch the toggle). */
	forceRefresh?: boolean;
}

/**
 * Whether the `versionChecks.enabled` toggle permits version checks.
 *
 * Resolved field by field — `CODEMIE_VERSION_CHECKS_ENABLED`, then the project's
 * `workspace.versionChecks`, then the global one — rather than through ConfigLoader.load(),
 * because load() swaps in a project's whole `workspace` block (hiding a global setting it
 * doesn't repeat) and throws when no profile is active (hiding the env var). Fail-safe: only an
 * explicit `false` disables checks; an unreadable config or unrecognized value leaves them on.
 */
export async function isVersionChecksEnabled(workingDir: string = process.cwd()): Promise<boolean> {
	const envValue = process.env.CODEMIE_VERSION_CHECKS_ENABLED;
	if (envValue !== undefined) {
		return envValue !== 'false';
	}

	const scopes: Array<{ scope: string; load: () => Promise<{ workspace?: { versionChecks?: { enabled?: unknown } } }> }> = [
		{ scope: 'local', load: () => ConfigLoader.loadLocalMultiProviderConfig(workingDir) },
		{ scope: 'global', load: () => ConfigLoader.loadMultiProviderConfig() },
	];
	for (const { scope, load } of scopes) {
		try {
			const enabled = (await load()).workspace?.versionChecks?.enabled;
			if (enabled !== undefined) {
				return enabled !== false;
			}
		} catch (error) {
			logger.debug('[version-resolution] config read failed, skipping scope', { scope, error: String(error) });
		}
	}
	return true;
}

// Matches a prerelease/build-metadata suffix after the numeric version, e.g. "1.2.3-beta.1" or
// "v1.2.3-rc1+build5" — npm's `latest` dist-tag should never point at one, but a live lookup is
// external input and this guards against silently presenting it as the recommended version.
const PRERELEASE_SUFFIX_PATTERN = /\d+\.\d+\.\d+[-+]/;

export interface ResolvedSupportedVersion {
	/** Version to install or display; the metadata fallback when no live value is available. */
	version: string | undefined;
	/**
	 * True only when `version` came from a successful npm lookup (fresh or cached). False when the
	 * toggle is off, the lookup failed, or the live value was rejected — callers comparing against
	 * it must then behave as if no supported version were configured, not present the fallback as
	 * current.
	 */
	isLive: boolean;
}

export async function resolveSupportedVersionDetailed(
	input: ResolveSupportedVersionInput
): Promise<ResolvedSupportedVersion> {
	const { agentName, npmPackage, fallbackSupportedVersion, forceRefresh } = input;
	const fallback: ResolvedSupportedVersion = { version: fallbackSupportedVersion, isLive: false };

	if (!isLiveTrackedAgent(agentName) || !npmPackage) {
		return fallback;
	}

	const enabled = await isVersionChecksEnabled();
	if (!enabled) {
		return fallback;
	}

	try {
		const live = await getCachedLatestVersion(npmPackage, { forceRefresh });
		if (live && PRERELEASE_SUFFIX_PATTERN.test(live)) {
			logger.debug('[resolveSupportedVersion] live version looks like a prerelease, using fallback', {
				agentName,
				live,
			});
			return fallback;
		}
		const extracted = live ? extractVersion(live) : null;
		return extracted ? { version: extracted, isLive: true } : fallback;
	} catch (error) {
		logger.debug('[resolveSupportedVersion] live lookup failed, using fallback', { agentName, error: String(error) });
		return fallback;
	}
}

/**
 * Install target for `installVersion('supported')`: the live tracked version, or the `latest`
 * channel when it is unknown (checks off, lookup failed). Never the hardcoded fallback, which can
 * be far behind upstream and would install — or downgrade to — a stale release.
 */
export async function resolveSupportedInstallVersion(input: ResolveSupportedVersionInput): Promise<string> {
	const { version, isLive } = await resolveSupportedVersionDetailed(input);
	return isLive && version ? version : 'latest';
}
