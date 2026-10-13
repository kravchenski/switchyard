import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { KEYRING_ENTRY, type Keyring } from '../core/secrets/accounts-secret.ts';

const SECRET_LINE = /^ACCOUNTS_SECRET=(.*)$/m;

export type InitResult = 'created' | 'copied' | 'moved' | 'exists' | 'environment' | 'created-in-env-file' | 'exists-in-env-file' | 'locked';

export interface InitOptions {
  envFile: string;
  env: Record<string, string | undefined>;
  keyring: Keyring;
  random?: () => string;
  credentialsFile?: string;
}

const randomSecret = () => crypto.randomBytes(32).toString('base64');

export function readFileSecret(envFile: string) {
  const current = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  return current.match(SECRET_LINE)?.[1]?.trim().replace(/^["']|["']$/g, '') || undefined;
}

function writeEnvFile(envFile: string, content: string) {
  const directory = path.dirname(envFile);
  if (directory && directory !== '.') fs.mkdirSync(directory, { recursive: true });
  const temporary = `${envFile}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, envFile);
  fs.chmodSync(envFile, 0o600);
}

function tightenMode(envFile: string) {
  if (process.platform !== 'win32' && fs.existsSync(envFile)) fs.chmodSync(envFile, 0o600);
}

export function ensureAccountsSecret(envFile: string, random: () => string = randomSecret) {
  const current = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  if (readFileSecret(envFile)) return 'exists' as const;
  const line = `ACCOUNTS_SECRET=${random()}`;
  writeEnvFile(envFile, SECRET_LINE.test(current)
    ? current.replace(SECRET_LINE, line)
    : `${current}${current && !current.endsWith('\n') ? '\n' : ''}${line}\n`);
  return 'created' as const;
}

async function keyringValue(keyring: Keyring) {
  try {
    return { ok: true as const, value: (await keyring.get(KEYRING_ENTRY)) || undefined };
  } catch {
    return { ok: false as const, value: undefined };
  }
}

async function storeInKeyring(keyring: Keyring, value: string) {
  try {
    await keyring.set({ ...KEYRING_ENTRY, value });
    return (await keyring.get(KEYRING_ENTRY)) === value;
  } catch {
    return false;
  }
}

export async function initAccountsSecret({ envFile, env, keyring, random = randomSecret, credentialsFile }: InitOptions): Promise<InitResult> {
  const fileSecret = readFileSecret(envFile);
  const stored = await keyringValue(keyring);
  const vaultExists = Boolean(credentialsFile && fs.existsSync(credentialsFile));

  if (fileSecret && stored.value && stored.value !== fileSecret) {
    throw new Error('.env and the system keyring hold different ACCOUNTS_SECRET values. Remove the one that does not open session/credentials.enc, then run this command again.');
  }

  if (fileSecret) {
    tightenMode(envFile);
    if (!stored.ok) return 'exists-in-env-file';
    if (stored.value === fileSecret) return 'exists';
    if (!await storeInKeyring(keyring, fileSecret)) return 'exists-in-env-file';
    return 'moved';
  }

  if (env.ACCOUNTS_SECRET) return 'environment';

  if (stored.value) {
    ensureAccountsSecret(envFile, () => stored.value!);
    return 'copied';
  }

  if (vaultExists) return 'locked';

  const fresh = random();
  if (stored.ok && await storeInKeyring(keyring, fresh)) {
    ensureAccountsSecret(envFile, () => fresh);
    return 'created';
  }
  ensureAccountsSecret(envFile, () => fresh);
  return 'created-in-env-file';
}

export const INIT_MESSAGES: Record<InitResult, string> = {
  created: 'Created ACCOUNTS_SECRET in the system keyring and kept a copy in .env. Restart the gateway to use saved accounts.',
  copied: 'Copied ACCOUNTS_SECRET from the system keyring to .env. Restart the gateway.',
  moved: 'Moved ACCOUNTS_SECRET to the system keyring. The .env copy stays as a fallback. Restart the gateway.',
  exists: 'ACCOUNTS_SECRET is already set in the system keyring and kept in .env.',
  environment: 'ACCOUNTS_SECRET comes from the environment; it is left there.',
  'created-in-env-file': 'No system keyring is available, so ACCOUNTS_SECRET was written to .env (mode 600).',
  'exists-in-env-file': 'ACCOUNTS_SECRET stays in .env because the system keyring is not available.',
  locked: 'Saved keys are protected by an ACCOUNTS_SECRET that is not available right now — the system keyring is locked or empty. Unlock the keyring, or put the old secret back into .env, then run this again. Creating a new secret would leave the saved keys unreadable.',
};
