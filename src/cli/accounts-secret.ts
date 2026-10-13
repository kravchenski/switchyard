import crypto from 'node:crypto';
import fs from 'node:fs';

import { type Keyring, KEYRING_ENTRY, readSecretFile, writeSecretFile } from '../core/secrets/accounts-secret.ts';

const SECRET_LINE = /^ACCOUNTS_SECRET=(.*)$/m;

export type InitResult = 'created' | 'moved' | 'copied' | 'exists' | 'environment' | 'locked';

export interface InitOptions {
  secretFile: string;
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

function removeEnvSecret(envFile: string) {
  if (!fs.existsSync(envFile)) return;
  const current = fs.readFileSync(envFile, 'utf8');
  const next = current.replace(/^ACCOUNTS_SECRET=[^\n]*\n?/m, '');
  if (next !== current) fs.writeFileSync(envFile, next, { mode: 0o600 });
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

export async function initAccountsSecret({ secretFile, envFile, env, keyring, random = randomSecret, credentialsFile }: InitOptions): Promise<InitResult> {
  const durable = readSecretFile(secretFile);
  const legacy = readFileSecret(envFile);
  const stored = await keyringValue(keyring);
  const vaultExists = Boolean(credentialsFile && fs.existsSync(credentialsFile));

  if (durable && stored.value && stored.value !== durable) {
    throw new Error(`${secretFile} and the system keyring hold different ACCOUNTS_SECRET values. Remove the one that does not open session/credentials.enc, then run this command again.`);
  }

  if (durable) {
    if (stored.value !== durable && await storeInKeyring(keyring, durable)) return 'copied';
    return 'exists';
  }

  if (legacy) {
    writeSecretFile(secretFile, legacy);
    removeEnvSecret(envFile);
    if (stored.value !== legacy) await storeInKeyring(keyring, legacy);
    return 'moved';
  }

  if (env.ACCOUNTS_SECRET) return 'environment';

  if (stored.value) {
    writeSecretFile(secretFile, stored.value);
    return 'copied';
  }

  if (vaultExists) return 'locked';

  const fresh = random();
  writeSecretFile(secretFile, fresh);
  await storeInKeyring(keyring, fresh);
  return 'created';
}

export const INIT_MESSAGES: Record<InitResult, string> = {
  created: 'Created ACCOUNTS_SECRET in the secret file and the system keyring. Back it up with: bun run account secret show. Restart the gateway to use saved accounts.',
  moved: 'Moved ACCOUNTS_SECRET out of .env into the secret file. Restart the gateway.',
  copied: 'Copied ACCOUNTS_SECRET into the secret file. Back it up with: bun run account secret show.',
  exists: 'ACCOUNTS_SECRET is already in the secret file. Back it up with: bun run account secret show.',
  environment: 'ACCOUNTS_SECRET comes from the environment; it is left there.',
  locked: 'Saved keys are protected by an ACCOUNTS_SECRET that is not available right now — the system keyring is locked or empty. Unlock the keyring, or put the old secret into the secret file, then run this again. Creating a new secret would leave the saved keys unreadable.',
};
