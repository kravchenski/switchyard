import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const KEYRING_ENTRY = { service: 'free-ai-gateway', name: 'ACCOUNTS_SECRET' };

export interface Keyring {
  get(entry: { service: string; name: string }): Promise<string | null>;
  set(entry: { service: string; name: string; value: string }): Promise<void>;
}

export const systemKeyring: Keyring = {
  get: entry => Bun.secrets.get(entry),
  set: entry => Bun.secrets.set(entry),
};

export type SecretSource = 'environment' | 'file' | 'keyring' | 'missing';

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
): Promise<SecretSource> {
  if (env.ACCOUNTS_SECRET) {
    loaded = env.ACCOUNTS_SECRET;
    delete env.ACCOUNTS_SECRET;
    return 'environment';
  }
  const durable = readSecretFile(file);
  if (durable) {
    loaded = durable;
    return 'file';
  }
  try {
    loaded = (await keyring.get(KEYRING_ENTRY)) || undefined;
  } catch {
    loaded = undefined;
  }
  return loaded ? 'keyring' : 'missing';
}

export function forgetAccountsSecret() {
  loaded = undefined;
}
