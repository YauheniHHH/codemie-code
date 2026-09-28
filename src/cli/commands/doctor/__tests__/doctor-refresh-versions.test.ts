import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The health checks themselves are covered elsewhere; here every check is a no-op
// so only the --refresh-versions wiring runs.
vi.mock('../checks/index.js', () => {
  class NoopCheck {
    name = 'noop';
    async run() {
      return { name: 'noop', success: true, details: [] };
    }
  }
  class AIConfigCheck extends NoopCheck {
    getConfig() {
      return null;
    }
  }
  return {
    NodeVersionCheck: NoopCheck,
    NpmCheck: NoopCheck,
    PythonCheck: NoopCheck,
    UvCheck: NoopCheck,
    AwsCliCheck: NoopCheck,
    AIConfigCheck,
    JWTAuthCheck: NoopCheck,
    AgentsCheck: NoopCheck,
    WorkflowsCheck: NoopCheck,
    FrameworksCheck: NoopCheck,
  };
});

vi.mock('../formatter.js', () => ({
  HealthCheckFormatter: class {
    displayHeader() {}
    startCheck() {}
    updateProgress() {}
    displayCheck() {}
    async displaySummary() {}
  },
}));

vi.mock('../../../../providers/core/registry.js', () => ({
  ProviderRegistry: { getHealthCheck: vi.fn(), registerProvider: vi.fn((t: unknown) => t) },
}));
vi.mock('../../../../utils/tips.js', () => ({ renderTip: vi.fn() }));
vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), getLogFilePath: vi.fn() },
}));

const refreshMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../utils/version-cache.js', () => ({ refreshCachedLatestVersion: refreshMock }));

const versionChecks = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../../../agents/core/version-resolution.js', () => ({
  isVersionChecksEnabled: vi.fn(async () => versionChecks.enabled),
  isLiveTrackedAgent: (name: string) => ['claude', 'kimi', 'kimi-acp'].includes(name),
}));

vi.mock('../../../../agents/registry.js', () => ({
  AgentRegistry: {
    getAllAgents: () => [
      { name: 'claude', metadata: { npmPackage: '@anthropic-ai/claude-code' } },
      { name: 'kimi', metadata: { npmPackage: '@moonshot-ai/kimi-code' } },
      { name: 'kimi-acp', metadata: { npmPackage: '@moonshot-ai/kimi-code' } },
      { name: 'opencode', metadata: { npmPackage: 'opencode-ai' } },
    ],
  },
}));

import { createDoctorCommand } from '../index.js';

describe('codemie doctor --refresh-versions', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  const printed = () => logSpy.mock.calls.flat().join('\n');

  beforeEach(() => {
    vi.clearAllMocks();
    versionChecks.enabled = true;
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('re-checks each live-tracked package once, in place', async () => {
    refreshMock.mockResolvedValue(true);

    await createDoctorCommand().parseAsync(['--refresh-versions'], { from: 'user' });

    expect(refreshMock.mock.calls.map(([pkg]) => pkg).sort()).toEqual([
      '@anthropic-ai/claude-code',
      '@moonshot-ai/kimi-code',
    ]);
    expect(printed()).toContain('2/2 checked against npm');
  });

  it('reports failed lookups and says their cached values were kept', async () => {
    refreshMock.mockImplementation(async (pkg: string) => pkg !== '@moonshot-ai/kimi-code');

    await createDoctorCommand().parseAsync(['--refresh-versions'], { from: 'user' });

    expect(printed()).toContain('1/2 checked against npm');
    expect(printed()).toContain('1 lookup(s) failed; their previous cached values were kept');
  });

  it('is a no-op with a note when version checks are disabled', async () => {
    versionChecks.enabled = false;

    await createDoctorCommand().parseAsync(['--refresh-versions'], { from: 'user' });

    expect(refreshMock).not.toHaveBeenCalled();
    expect(printed()).toContain('--refresh-versions is a no-op');
  });
});
