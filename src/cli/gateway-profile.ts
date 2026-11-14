import path from 'node:path';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GatewayProfileOptions {
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export function localGatewayUrl(env: Record<string, string | undefined> = process.env) {
  const host = (env.HOST ?? '').trim();
  const reachable = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const port = (env.UNIFIED_PORT ?? '').trim() || '3260';
  return `http://${reachable.includes(':') ? `[${reachable}]` : reachable}:${port}`;
}

async function post(route: string, profileDir: string, options: GatewayProfileOptions) {
  const env = options.env ?? process.env;
  const apiKey = (env.GATEWAY_API_KEY ?? '').trim();
  try {
    const response = await (options.fetch ?? fetch)(`${localGatewayUrl(env)}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify({ profileDir: path.resolve(profileDir) }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function releaseGatewayProfiles(profileDirs: string[], options: GatewayProfileOptions = {}) {
  const released = (await Promise.all(profileDirs.map(async dir => (await post('/v1/gateway/browser/release', dir, options)) ? dir : undefined)))
    .filter((dir): dir is string => dir !== undefined);
  return async () => {
    await Promise.all(released.map(dir => post('/v1/gateway/browser/resume', dir, options)));
  };
}
