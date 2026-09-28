# Spec: Smarter Agent Version Recommendations (EPMCDME-14767)

## Problem

`supportedVersion` for Claude, Codex, Gemini, Kimi, and Copilot CLI is a hand-edited constant per
plugin (`claude.plugin.ts:39`, `codex.plugin.ts:73`, `gemini.plugin.ts:16`, `kimi.plugin.ts:26`,
`copilot-cli.plugin.ts:27-28`) that goes stale between manual bumps. Two separate code paths decide
"is this current?" — `checkVersionCompatibility()` (`BaseAgentAdapter.ts:284`, pure local compare)
and `checkAgentForUpdate()` (`update.ts:45`, queries npm for most agents but special-cases Claude by
copying the hardcoded constant instead of checking, `update.ts:58-79`). This replaces the hardcoded
"recommended" value with a live npm-tracked one, unifies the two paths, and adds a global kill
switch.

## Scope

**Explicit named allowlist of five agents** — Claude, Codex, Gemini, Kimi, Copilot CLI — all
verified to share the identical hardcoded-constant pattern (`<AGENT>_SUPPORTED_VERSION` /
`<AGENT>_MINIMUM_SUPPORTED_VERSION`):

- Claude (`@anthropic-ai/claude-code`) — npm/upstream lockstep verified.
- Kimi (`@moonshot-ai/kimi-code`) — npm/upstream lockstep verified.
- Gemini (`@google/gemini-cli`) — npm/upstream lockstep verified live (`npm view` → `0.60.0`,
  matches GitHub's stable tag; nightly pre-releases are not returned by npm's `latest` dist-tag).
- Codex (`codex.plugin.ts:73`, npmPackage `@openai/codex`) — verified: npm `latest` (`0.155.1`)
  structurally excludes GitHub's heavy alpha pre-release stream (`0.157.0-alpha.x`, ahead of npm by
  design) via npm's semver pre-release-tag exclusion from the `latest` dist-tag — a mechanical
  guarantee, not an empirical match like the other four. Safe to use as source of truth for the same
  reason, not merely by analogy.
- Copilot CLI (`copilot-cli.plugin.ts:27-28`, npmPackage `@github/copilot`, has a real `install()`
  method) — npm/upstream lockstep verified live (`npm view` → `1.0.87`, matches GitHub's latest
  release tag `v1.0.87` exactly).

Kimi ACP needs no separate allowlist entry: it extends `KimiPlugin` and inherits
`KimiPluginMetadata` directly, so "Kimi" already covers it. Claude ACP
(`claude-acp.plugin.ts`) is explicitly **not** in scope — see Design §2 for why.

## Design

> **Revised 2026-09-28 after PR #576 review.** The original design fell back to the hardcoded
> constant whenever the live value was unavailable. That contradicted ticket criteria #4 ("no stale
> value shown as current") and #5 ("checks off → as if no supported version were configured"), so
> the sections below now describe the implemented behavior: an unknown tracked version is reported
> as unknown, and every passive consumer stays silent instead of comparing against the constant.

### 1. Version cache module

New module (e.g. `src/utils/version-cache.ts`) exposing `getCachedLatestVersion(packageName, {
forceRefresh? }): Promise<string | null>`. Wraps the existing `getLatestVersion()`
(`processes.ts:315`). Persists `{ [packageName]: { version, fetchedAt } }` to a new JSON file under
`~/.codemie/` (sibling to `version-warnings.json`, not part of the `ConfigLoader` schema). TTL is 24h
from `fetchedAt` (a `fetchedAt` in the future counts as stale); `forceRefresh: true` bypasses the
TTL. On npm failure (timeout, network, unparsable output) it returns the cached value only if that
entry is still inside its TTL, else `null` — an expired entry is never presented as current. Every
failure is logged with `logger.warn` (log file only). Failures are not cached, so the next call
retries. Writes are atomic (temp file + rename); a failed write still returns the fetched value.
Unparsable output means anything other than a version string. Malformed entries in the cache file
are ignored, and the next successful write replaces them.

### 2. `supportedVersion` becomes live-tracked, uniformly, for an explicit allowlist

Each of the five plugins' hardcoded constants (`CLAUDE_SUPPORTED_VERSION`, `CODEX_SUPPORTED_VERSION`,
`GEMINI_SUPPORTED_VERSION`, `KIMI_SUPPORTED_VERSION`, `COPILOT_SUPPORTED_VERSION`) stays in the
source as the fallback-of-last-resort. A new shared accessor — e.g. `resolveSupportedVersion(agent):
Promise<string>` — becomes the single place both `checkVersionCompatibility()` and
`checkAgentForUpdate()` read from:

1. Look up the agent by an **explicit named allowlist** (agent id/name, not a structural check such
   as "does `metadata.npmPackage` exist"). Only `claude`, `codex`, `gemini`, `kimi`, `kimi-acp`
   (same package and binary as `kimi`), and `copilot-cli` are live-tracked. `claude-acp` is not:
   its `getVersion()` returns `null`, so it never takes part in version comparison.
2. If the agent is allowlisted and the global toggle (Section 3) is off: no network I/O, and the
   result is marked **not live**.
3. If allowlisted and the toggle is on, resolve via the version cache for the agent's npm package,
   extracting the version with the existing `extractVersion()` convention already used by
   `checkAgentForUpdate`'s non-Claude path. Only this path is marked **live**.
4. On any cache/fetch failure, a prerelease value, or a non-allowlisted agent, the result is marked
   **not live**.

The accessor (`resolveSupportedVersionDetailed()`) returns `{ version, isLive }`.
`checkVersionCompatibility()` exposes this as `versionKnown`; when it is `false`, the result reports
`supportedVersion: 'latest'`, `compatible: true`, and no update. The launch notice, `codemie doctor`,
`codemie setup` and `codemie update` then behave as if no supported version were configured. The
`minimumSupportedVersion` gate is computed independently and still applies. `installVersion('supported')`
(`resolveSupportedInstallVersion()`) installs the live version, or the `latest` channel when it is
unknown — never the hardcoded constant, which can be far behind upstream. `run()` resolves
compatibility once and shares it between the minimum gate and the notice.

`checkVersionCompatibility()` (`BaseAgentAdapter.ts:284`) becomes async and calls this accessor
instead of reading `this.metadata.supportedVersion` directly; its callers (`run()`'s startup warning,
`install.ts`, `update.ts`, `AgentsCheck.ts`, `setup.ts`'s `checkAndInstallClaude`) are updated to
await it. `checkAgentForUpdate()`'s Claude special-case (`update.ts:58-79`) is deleted — Claude now
goes through the same uniform npm-backed path as the other four allowlisted agents, via the same
accessor.

### 3. Global toggle

New nested boolean on `WorkspaceConfig`, following the existing `metrics.enabled` precedent —
`workspace.versionChecks.enabled` (default `true`), stored in `~/.codemie/codemie-cli.config.json` /
`.codemie/codemie-cli.config.json`, env var `CODEMIE_VERSION_CHECKS_ENABLED`. It is resolved field by
field — env var, then project, then global — not through `ConfigLoader.load()`. `load()` swaps in a
project's whole `workspace` block (which would hide a global setting the project doesn't repeat) and
throws when no profile is active (which would hide the env var). Both the env var and the config value resolve **fail-safe**: any
value other than an explicit, recognized "disable" (e.g. literal `false` for the config field,
`'false'` for the env var) resolves to enabled — the deliberate inverse of the `CODEMIE_DEBUG ===
'true'` fail-closed convention, required because an invalid or unrecognized stored value must never
silently disable checks.

When disabled, allowlisted agents resolve as not live, with no network calls from any gated flow:
- **Launch notice:** silent.
- **`codemie setup`:** shows a plain "installed" line.
- **`codemie doctor`:** no "tracking vX" warning.
- **`codemie update`:** skips these agents, with a dim "version checks are disabled" note instead of
  "Could not check".

`codemie doctor` and `codemie update`'s force-refresh bypasses only the 24h TTL, not the toggle —
with the toggle off, force-refresh is a no-op. Codex's and Gemini's own self-update suppression is
also skipped while checks are off. A value written earlier is left in place when checks are turned
off: CodeMie can't tell its value from one the user set. This is documented in
`docs/CONFIGURATION.md`.

### 4. Notice-dedup interaction

`VersionWarningStore` keeps keying its one-time notice on the resolved `supportedVersion` string,
unchanged. Because `resolveSupportedVersion()` only produces a new value when npm's reported version
actually changes, a same-value cache refresh returns the identical string and the existing dedup
logic in `version-warnings.ts` naturally stays silent — no code change needed there.

### 5. UI copy

Once the number follows npm rather than a hand-tested pin, every string that says CodeMie "tested",
"verified" or "recommends" a version is inaccurate. All of them use "tracking" framing instead
(decided during implementation, superseding the original two-string scope):

- `update.ts` — up-to-date message: "no newer version available".
- `setup.ts` — "ahead of the tracked v...".
- `AgentsCheck.ts` — "CodeMie is tracking v...".
- The launch notice ("CodeMie is tracking X vN; you are running vM"), the `install --supported`
  option help, and the two related `tips.json` entries.

## Acceptance Criteria

- The allowlisted agents' (Claude, Codex, Gemini, Kimi incl. Kimi ACP, Copilot CLI) tracked version
  is sourced from a cached npm `latest` lookup when the global toggle is on. On fetch failure or with
  the toggle off it is reported as unknown: no notice, warning or update offer. The hardcoded constant
  is never presented as current.
- The accessor keys off an explicit named allowlist, not a structural signal like
  `metadata.npmPackage` presence — `claude-acp` is never targeted for a live lookup.
- `minimumSupportedVersion` still blocks launch below the floor regardless of the toggle or lookup
  outcome.
- `checkAgentForUpdate()` no longer special-cases Claude; all five allowlisted agents go through one
  uniform check.
- A single setting (env var > project > global) gates the startup warning, `codemie setup`,
  `codemie doctor` and `codemie update` identically. A global `false` holds in projects that have
  their own `workspace` block, and the env var works without an active profile.
- An invalid or unrecognized stored value for the toggle resolves to "checks enabled."
- `codemie doctor --refresh-versions` and `codemie update --force-refresh` re-check each package
  against npm, bypassing only the 24h TTL; a failed lookup keeps that package's existing entry.
- No user-facing string claims CodeMie "tested", "verified" or "recommends" a version; they use the
  §5 "tracking" framing. Other copy changes are limited to the checks-disabled notes in
  `codemie update` / `codemie install --supported`, and hiding the "Latest tracked version" line of
  the below-minimum message when the version is unknown.
- A cache refresh that resolves to an unchanged version does not re-trigger `VersionWarningStore`'s
  notice.

## Non-goals

- `minimumSupportedVersion` stays hardcoded and keeps blocking (even with checks off). Its
  comparison is only moved ahead of the unknown-version exit so it keeps working, and its message
  drops the "Latest tracked version" line when that version is unknown.
- opencode and pi agents are not touched by this change.
- Claude ACP is out of scope (no version comparison); Kimi ACP was added to the allowlist because it
  is the same binary as Kimi.
- No per-agent toggle granularity — one global switch only.
- Automated backend-compatibility testing of new agent versions against CodeMie.
- Tests: written on explicit request during PR #576 review (version resolution, version cache,
  `exec()`, notice/doctor/update/install version paths).

## Open Risks

- `AGENTS.md` currently describes Copilot CLI as "Analytics ingestion only — never installed or
  launched by CodeMie," which is stale against the plugin's actual `install()` method and its
  inclusion in this live-tracking allowlist. Flagged as documentation drift; fixing the guide is out
  of this ticket's scope.
- `checkVersionCompatibility()` becoming async may touch every call site's signature — the
  implementation plan should enumerate all callers explicitly.
- A cache miss (fresh install, past 24h, or offline) pays one npm lookup of up to 3s per launch;
  failures are deliberately not cached, so an offline user pays it on every launch.
- The cache file has no cross-process lock: writes are atomic, so a reader never sees a torn file,
  but concurrent CLI invocations are last-write-wins (worst case: one extra lookup).
- Known, pre-existing and out of scope: `codemie update kimi` updates the npm package, not the
  native Kimi binary; a malformed installed version skips the minimum gate; `setup` shows a green
  check for a below-minimum Claude.
