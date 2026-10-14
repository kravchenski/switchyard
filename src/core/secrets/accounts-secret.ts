import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { open } from './vault.ts';

export const KEYRING_ENTRY = { service: 'free-ai-gateway', name: 'ACCOUNTS_SECRET' };

export interface Keyring {
  get(entry: { service: string; name: string }): Promise<string | null>;
  set(entry: { service: string; name: string; value: string }): Promise<void>;
}

export const systemKeyring: Keyring = {
  get: entry => Bun.secrets.get(entry),
  set: entry => Bun.secrets.set(entry),
};

export type SecretSource = 'environment' | 'file' | 'env-file' | 'keyring' | 'missing' | 'locked';

export function readFileSecret(envFile: string) {
  const current = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
  return current.match(/^ACCOUNTS_SECRET=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, '') || undefined;
}

export function secretOpensCredentials(secret: string, file: string) {
  if (!existsSync(file)) return true;
  try {
    return Array.isArray(JSON.parse(open(readFileSync(file, 'utf8').trim(), secret)));
  } catch {
    return false;
  }
}

export function accountsSecretFile(env: Record<string, string | undefined> = process.env) {
  if (env.ACCOUNTS_SECRET_FILE) return env.ACCOUNTS_SECRET_FILE;
  const home = env.HOME || env.USERPROFILE || homedir();
  const config = process.platform === 'darwin'
    ? join(home, 'Library', 'Application Support', 'Free AI Gateway')
    : process.platform === 'win32'
      ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Free AI Gateway')
      : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'free-ai-gateway');
  return join(config, 'secret');
}

export function readSecretFile(file: string) {
  if (!existsSync(file)) return undefined;
  return readFileSync(file, 'utf8').trim() || undefined;
}

export function writeSecretFile(file: string, value: string) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${value}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

let loaded: string | undefined;

export function accountsSecret(env: Record<string, string | undefined> = process.env) {
  return env.ACCOUNTS_SECRET || loaded;
}

export async function loadAccountsSecret(
  keyring: Keyring = systemKeyring,
  env: Record<string, string | undefined> = process.env,
  file: string = accountsSecretFile(env),
  credentialsFile: string = resolve(env.SESSION_DIR || 'session', 'credentials.enc'),
  envFile: string = '.env',
): Promise<SecretSource> {
  const environment = env.ACCOUNTS_SECRET;
  delete env.ACCOUNTS_SECRET;
  loaded = undefined;
  const candidates: Array<[SecretSource, string | undefined]> = [
    ['environment', environment],
    ['file', readSecretFile(file)],
    ['env-file', readFileSecret(envFile)],
  ];
  for (const [source, value] of candidates) {
    if (value && secretOpensCredentials(value, credentialsFile)) {
      loaded = value;
      return source;
    }
  }
  try {
    const value = await keyring.get(KEYRING_ENTRY);
    if (value && secretOpensCredentials(value, credentialsFile)) {
      loaded = value;
      return 'keyring';
    }
  } catch {
    // A locked or unavailable keyring must not replace the saved encryption key.
  }
  return existsSync(credentialsFile) ? 'locked' : 'missing';
}

export function forgetAccountsSecret() {
  loaded = undefined;
}
