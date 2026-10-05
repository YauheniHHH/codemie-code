import { get as httpGet, type Agent as HttpAgent } from 'node:http';
import { get as httpsGet } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import {
  IMPLICIT_NO_PROXY,
  getEnvNoProxyEntries,
  getProxyAgentForUrl,
  parseNoProxyRules,
  shouldBypassProxy,
  splitRules,
} from './system-proxy.js';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org/';
const MAX_RESPONSE_BYTES = 1024 * 1024;

type NpmConfig = Record<string, string>;

// Minimal .npmrc reader: `key=value` lines, `#`/`;` comments, optional surrounding quotes, and
// `${VAR}` expansion when `expandEnv` is set. Expansion is off for a project .npmrc (a value that
// needs it is skipped): the lookup runs on every agent launch, so a checked-out repo must not be
// able to route env secrets (e.g. `registry=https://host/${TOKEN}/`) to a host of its choosing.
function readNpmrc(file: string, expandEnv: boolean): NpmConfig {
  if (!existsSync(file)) return {};
  const config: NpmConfig = {};
  try {
    for (const rawLine of readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#') || line.startsWith(';')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
        value = value.slice(1, -1);
      }
      if (expandEnv) {
        value = value.replace(/\$\{([^}]+)\}/g, (_, name: string) => process.env[name] ?? '');
      } else if (/\$\{[^}]+\}/.test(value)) {
        continue;
      }
      config[key] = value;
    }
  } catch {
    return {};
  }
  return config;
}

// npm's own precedence for the settings used here: env var > project .npmrc > user .npmrc.
function npmSetting(config: NpmConfig, key: string): string | undefined {
  const envKey = `npm_config_${key.replace(/-/g, '_')}`;
  return process.env[envKey] || process.env[envKey.toUpperCase()] || config[key] || undefined;
}

function loadNpmConfig(cwd: string): NpmConfig {
  const userConfig = process.env.npm_config_userconfig || process.env.NPM_CONFIG_USERCONFIG || join(homedir(), '.npmrc');
  return { ...readNpmrc(userConfig, true), ...readNpmrc(join(cwd, '.npmrc'), false) };
}

/** The registry npm would use for this package, honoring `@scope:registry` and `registry`. */
export function resolveRegistry(packageName: string, cwd: string = process.cwd()): string {
  const config = loadNpmConfig(cwd);
  const scope = packageName.startsWith('@') ? packageName.split('/')[0] : undefined;
  const registry = (scope && config[`${scope}:registry`]) || npmSetting(config, 'registry') || DEFAULT_REGISTRY;
  return registry.endsWith('/') ? registry : `${registry}/`;
}

// npm's own `https-proxy`/`proxy` settings win over HTTPS_PROXY/HTTP_PROXY, as they do for npm
// itself. Without them, the shared resolver applies the env vars and then the Windows system
// proxy / PAC, so a registry behind a PAC-only corporate proxy is reachable too.
async function proxyAgentFor(url: URL, config: NpmConfig): Promise<HttpAgent | undefined> {
  const isHttps = url.protocol === 'https:';
  const npmProxy = isHttps
    ? npmSetting(config, 'https-proxy') || npmSetting(config, 'proxy')
    : npmSetting(config, 'proxy');
  if (!npmProxy) return getProxyAgentForUrl(url, { keepAlive: false });

  const port = Number.parseInt(url.port, 10) || (isHttps ? 443 : 80);
  const noProxyRules = parseNoProxyRules([
    ...IMPLICIT_NO_PROXY,
    ...getEnvNoProxyEntries(),
    ...splitRules(npmSetting(config, 'noproxy')),
  ]);
  if (shouldBypassProxy(url.hostname, port, noProxyRules)) return undefined;
  return isHttps ? new HttpsProxyAgent(npmProxy) : new HttpProxyAgent(npmProxy);
}

// Bounds proxy discovery (a registry read and a PAC fetch on Windows) by the caller's deadline;
// a discovery failure goes direct, as getProxyAgentForUrl itself does.
async function proxyAgentWithin(
  url: URL,
  config: NpmConfig,
  timeoutMs: number
): Promise<{ agent: HttpAgent | undefined } | null> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const discovered = proxyAgentFor(url, config).then(
    (agent) => ({ agent }),
    () => ({ agent: undefined })
  );
  try {
    return await Promise.race([discovered, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The `latest` dist-tag version of a package, read straight from the npm registry (one small
 * HTTP request instead of spawning `npm view`, which takes 3s+ on Windows). Uses npm's configured
 * registry and proxy, else the system proxy. Returns `null` on any failure — timeout, network
 * error, non-200, or a response without a version; registries that require authentication are
 * not supported.
 *
 * @param packageName - npm package name, e.g. `@openai/codex`
 * @param options.timeoutMs - give up after this long, proxy discovery included
 */
export async function fetchLatestVersionFromRegistry(
  packageName: string,
  options: { timeoutMs: number; cwd?: string }
): Promise<string | null> {
  const startedAt = Date.now();
  let url: URL;
  let config: NpmConfig;
  try {
    const cwd = options.cwd ?? process.cwd();
    config = loadNpmConfig(cwd);
    // `@scope/name` must be encoded as `@scope%2fname` for registries other than npmjs.
    url = new URL(`${packageName.replace('/', '%2f')}/latest`, resolveRegistry(packageName, cwd));
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return null;
  }

  const proxy = await proxyAgentWithin(url, config, options.timeoutMs);
  const remainingMs = options.timeoutMs - (Date.now() - startedAt);
  if (!proxy || remainingMs <= 0) {
    return null;
  }
  return requestLatestVersion(url, proxy.agent, remainingMs);
}

function requestLatestVersion(url: URL, agent: HttpAgent | undefined, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    const get = url.protocol === 'https:' ? httpsGet : httpGet;
    const request = get(
      url,
      { agent, headers: { accept: 'application/json' }, timeout: timeoutMs },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }
        let body = '';
        response.setEncoding('utf-8');
        response.on('data', (chunk: string) => {
          body += chunk;
          if (body.length > MAX_RESPONSE_BYTES) request.destroy();
        });
        response.on('end', () => {
          try {
            const version = (JSON.parse(body) as { version?: unknown }).version;
            resolve(typeof version === 'string' ? version : null);
          } catch {
            resolve(null);
          }
        });
        response.on('error', () => resolve(null));
      }
    );
    // `timeout` above only covers an idle socket; this bounds the whole request.
    const deadline = setTimeout(() => request.destroy(), timeoutMs);
    request.on('close', () => {
      clearTimeout(deadline);
      resolve(null); // no-op if the response already resolved
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
}
