/**
 * Version handling contract (EPMCDME-13734):
 *  - versions above the minimum never block and never prompt — they get one
 *    notice per (agent, version, recommended version) combination;
 *  - versions below `minimumSupportedVersion` are known-broken and still refuse
 *    to launch, throwing in silent/ACP mode so the caller gets a structured signal.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AgentMetadata } from '../types.js';

vi.mock('../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setSessionId: vi.fn(),
  },
}));

vi.mock('../../../providers/core/registry.js', () => ({
  ProviderRegistry: {
    registerProvider: vi.fn((template: unknown) => template),
    registerSetupSteps: vi.fn(),
    registerHealthCheck: vi.fn(),
    registerModelProxy: vi.fn(),
    getProvider: vi.fn(() => ({ authType: 'none' })),
    getProviderNames: vi.fn(() => []),
  },
}));

vi.mock('../../../utils/processes.js', () => ({
  detectGitBranch: vi.fn(() => Promise.resolve(null)),
  detectGitRemoteRepo: vi.fn(() => Promise.resolve(null)),
  exec: vi.fn(),
  installGlobal: vi.fn(),
  uninstallGlobal: vi.fn(),
  getCommandPath: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../../utils/version-warnings.js', () => ({
  VersionWarningStore: {
    hasWarned: vi.fn(async () => false),
    recordWarning: vi.fn(async () => undefined),
  },
}));

vi.mock('../../../utils/cli-updater.js', () => ({
  getCurrentCliVersion: vi.fn(async () => '0.15.1'),
}));

vi.mock('../../../utils/interactive.js', () => ({
  isNonInteractiveEnvironment: vi.fn(() => false),
}));

// Tracked version resolves to the metadata value as if confirmed live; flip
// `isLive` to simulate checks disabled / lookup failure.
const versionResolution = vi.hoisted(() => ({ isLive: true }));
vi.mock('../version-resolution.js', () => ({
  resolveSupportedInstallVersion: vi.fn(async ({ fallbackSupportedVersion }) => fallbackSupportedVersion),
  resolveSupportedVersionDetailed: vi.fn(async ({ fallbackSupportedVersion }) => ({
    version: fallbackSupportedVersion,
    isLive: versionResolution.isLive,
  })),
}));

const metadata = (overrides: Partial<AgentMetadata> = {}): AgentMetadata => ({
  name: 'claude',
  displayName: 'Claude Code',
  description: 'Test agent',
  npmPackage: null,
  cliCommand: 'claude',
  envMapping: {},
  supportedProviders: ['anthropic-subscription'],
  silentMode: false,
  supportedVersion: '2.1.218',
  minimumSupportedVersion: '2.1.208',
  ...overrides,
});

async function adapterFor(
  installedVersion: string | null,
  overrides: Partial<AgentMetadata> = {}
) {
  const { BaseAgentAdapter } = await import('../BaseAgentAdapter.js');
  class TestAdapter extends BaseAgentAdapter {}
  const adapter = new TestAdapter(metadata(overrides));
  vi.spyOn(adapter, 'getVersion').mockResolvedValue(installedVersion);
  return adapter;
}

describe('warnOnceIfUntested', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    versionResolution.isLive = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('stays silent when the tracked version is unknown (checks off or lookup failed)', async () => {
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    versionResolution.isLive = false;
    const adapter = await adapterFor('2.1.230');

    await adapter.warnOnceIfUntested();

    expect(console.error).not.toHaveBeenCalled();
    expect(VersionWarningStore.recordWarning).not.toHaveBeenCalled();
  });

  it('stays silent when the installed version is the recommended one', async () => {
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    const adapter = await adapterFor('2.1.218');

    await adapter.warnOnceIfUntested();

    expect(console.error).not.toHaveBeenCalled();
    expect(VersionWarningStore.recordWarning).not.toHaveBeenCalled();
  });

  it('notices a mismatch once and records the baseline it was acknowledged against', async () => {
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    const adapter = await adapterFor('2.1.230');

    await adapter.warnOnceIfUntested();

    expect(console.error).toHaveBeenCalled();
    expect(VersionWarningStore.recordWarning).toHaveBeenCalledWith(
      'claude',
      '2.1.230',
      '2.1.218',
      '0.15.1'
    );
  });

  it('stays silent once the pair is already acknowledged', async () => {
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.hasWarned).mockResolvedValue(true);
    const adapter = await adapterFor('2.1.230');

    await adapter.warnOnceIfUntested();

    expect(console.error).not.toHaveBeenCalled();
    expect(VersionWarningStore.recordWarning).not.toHaveBeenCalled();
  });

  it('writes no banner in silent mode, so the JSON-RPC stream stays clean', async () => {
    const adapter = await adapterFor('2.1.230', { silentMode: true });

    await adapter.warnOnceIfUntested();

    expect(console.error).not.toHaveBeenCalled();
  });

  it('proceeds when the marker store fails', async () => {
    const { VersionWarningStore } = await import('../../../utils/version-warnings.js');
    vi.mocked(VersionWarningStore.hasWarned).mockRejectedValue(new Error('EACCES'));
    vi.mocked(VersionWarningStore.recordWarning).mockRejectedValue(new Error('EACCES'));
    const adapter = await adapterFor('2.1.230');

    await expect(adapter.warnOnceIfUntested()).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalled();
  });
});

describe('run() below the minimum supported version', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    versionResolution.isLive = true;
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('still refuses to launch when the tracked version is unknown', async () => {
    versionResolution.isLive = false;
    const adapter = await adapterFor('2.1.100', { silentMode: true });

    await expect(adapter.run([])).rejects.toThrow(/below the minimum supported version/);
  });

  it('omits the "Latest tracked version" line when the tracked version is unknown', async () => {
    versionResolution.isLive = false;
    const adapter = await adapterFor('2.1.100');
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(adapter.run([])).rejects.toThrow('process.exit called');

    const printed = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(printed).toContain('Minimum required version');
    expect(printed).not.toContain('Latest tracked version');
    expect(printed).not.toContain('vlatest');
  });

  it('resolves version compatibility once and shares it with both checks', async () => {
    const adapter = await adapterFor('2.1.230');
    const compatSpy = vi.spyOn(adapter, 'checkVersionCompatibility');
    const noticeSpy = vi
      .spyOn(adapter, 'warnOnceIfUntested')
      .mockRejectedValue(new Error('stop after version checks'));

    await expect(adapter.run([])).rejects.toThrow('stop after version checks');

    expect(compatSpy).toHaveBeenCalledTimes(1);
    expect(noticeSpy).toHaveBeenCalledWith(await compatSpy.mock.results[0].value);
  });

  it('throws in silent mode so ACP callers get a structured error', async () => {
    const adapter = await adapterFor('2.1.100', { silentMode: true });

    await expect(adapter.run([])).rejects.toThrow(/below the minimum supported version/);
  });

  it('refuses to launch interactively with a non-zero exit', async () => {
    const adapter = await adapterFor('2.1.100');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(adapter.run([])).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
