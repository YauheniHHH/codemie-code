import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../../../providers/core/registry.js', () => ({
  ProviderRegistry: {
    registerProvider: vi.fn((template: unknown) => template),
    registerSetupSteps: vi.fn(),
    registerHealthCheck: vi.fn(),
    registerModelProxy: vi.fn(),
    getProvider: vi.fn(),
    getProviderNames: vi.fn(() => []),
  },
}));

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

// Keep ~/.gemini writes inside a temp directory.
const homeState = vi.hoisted(() => ({ dir: '' }));
vi.mock('../../../../utils/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../utils/paths.js')>(
    '../../../../utils/paths.js'
  );
  const { join: joinPath } = await import('path');
  return { ...actual, resolveHomeDir: (p: string) => joinPath(homeState.dir, p) };
});

const versionChecks = vi.hoisted(() => ({ enabled: true }));
vi.mock('../../../core/version-resolution.js', () => ({
  isVersionChecksEnabled: vi.fn(async () => versionChecks.enabled),
  resolveSupportedInstallVersion: vi.fn(async () => 'latest'),
  resolveSupportedVersionDetailed: vi.fn(async ({ fallbackSupportedVersion }) => ({
    version: fallbackSupportedVersion,
    isLive: true,
  })),
}));

const execMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../utils/processes.js', async () => {
  const actual = await vi.importActual<typeof import('../../../../utils/processes.js')>(
    '../../../../utils/processes.js'
  );
  return { ...actual, exec: execMock };
});

import { GeminiPlugin, GeminiPluginMetadata } from '../gemini.plugin.js';

const settingsPath = () => join(homeState.dir, '.gemini', 'settings.json');

async function runBeforeRun(): Promise<Record<string, unknown>> {
  const plugin = new GeminiPlugin();
  await GeminiPluginMetadata.lifecycle!.beforeRun!.call(plugin, {}, {});
  return JSON.parse(await readFile(settingsPath(), 'utf-8'));
}

describe('GeminiPlugin', () => {
  const originalPlatform = process.platform;

  beforeEach(async () => {
    vi.clearAllMocks();
    versionChecks.enabled = true;
    homeState.dir = await mkdtemp(join(tmpdir(), 'codemie-gemini-home-'));
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    await rm(homeState.dir, { recursive: true, force: true });
  });

  describe('beforeRun self-updater suppression', () => {
    it('disables Gemini auto-update while version checks are on', async () => {
      const settings = await runBeforeRun();

      expect(settings.general).toEqual({ enableAutoUpdate: false });
    });

    it('leaves auto-update alone when version checks are off', async () => {
      versionChecks.enabled = false;

      const settings = await runBeforeRun();

      expect(settings.general).toBeUndefined();
    });

    it('never overrides a value the user already set', async () => {
      await mkdir(join(homeState.dir, '.gemini'), { recursive: true });
      await writeFile(settingsPath(), JSON.stringify({ general: { enableAutoUpdate: true } }), 'utf-8');

      const settings = await runBeforeRun();

      expect(settings.general).toEqual({ enableAutoUpdate: true });
    });
  });

  describe('getVersion', () => {
    it('runs through a shell on Windows, where gemini is an npm .cmd shim', async () => {
      Object.defineProperty(process, 'platform', { value: 'win32' });
      execMock.mockResolvedValue({ code: 0, stdout: '0.59.0\n', stderr: '' });

      await expect(new GeminiPlugin().getVersion()).resolves.toBe('0.59.0');
      expect(execMock).toHaveBeenCalledWith('gemini', ['--version'], expect.objectContaining({ shell: true }));
    });

    it('does not use a shell on other platforms', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      execMock.mockResolvedValue({ code: 0, stdout: '0.59.0', stderr: '' });

      await new GeminiPlugin().getVersion();
      expect(execMock).toHaveBeenCalledWith('gemini', ['--version'], expect.objectContaining({ shell: false }));
    });
  });
});
