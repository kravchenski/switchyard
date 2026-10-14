import crypto from 'node:crypto';
import fs from 'node:fs';

import { type Keyring, KEYRING_ENTRY, readFileSecret, readSecretFile, secretOpensCredentials, writeSecretFile } from '../core/secrets/accounts-secret.ts';

export { readFileSecret } from '../core/secrets/accounts-secret.ts';

export type InitResult = 'created' | 'moved' | 'copied' | 'exists' | 'environment' | 'locked' | 'recovered';

export interface InitOptions {
  secretFile: string;
  envFile: string;
  env: Record<string, string | undefined>;
  keyring: Keyring;
  random?: () => string;
  credentialsFile?: string;
}

const randomSecret = () => crypto.randomBytes(32).toString('base64');

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

  if (vaultExists) {
    const value = [env.ACCOUNTS_SECRET, durable, legacy, stored.value]
      .find(candidate => candidate && secretOpensCredentials(candidate, credentialsFile!));
    if (!value) return 'locked';
    // Only reconcile conflicting copies after proving which one opens the vault.
    if (value === env.ACCOUNTS_SECRET && !durable && !legacy) return 'environment';
    const changed = durable !== value || (stored.value !== undefined && stored.value !== value);
    if (durable !== value) writeSecretFile(secretFile, value);
    if (stored.value !== value) await storeInKeyring(keyring, value);
    if (legacy === value) removeEnvSecret(envFile);
    return changed ? 'recovered' : 'exists';
  }

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

  const fresh = random();
  writeSecretFile(secretFile, fresh);
  await storeInKeyring(keyring, fresh);
  return 'created';
}

export async function resetAccountsSecret({ secretFile, envFile, keyring, random = randomSecret, credentialsFile }: InitOptions) {
  const fresh = random();
  // Validate before moving any existing data.
  if (fresh.length < 16) throw new Error('Vault secret must be at least 16 characters');
  const backup = credentialsFile && fs.existsSync(credentialsFile)
    ? `${credentialsFile}.backup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
    : undefined;
  if (backup) fs.renameSync(credentialsFile!, backup);
  try {
    writeSecretFile(secretFile, fresh);
  } catch (error) {
    if (backup) fs.renameSync(backup, credentialsFile!);
    throw error;
  }
  await storeInKeyring(keyring, fresh);
  removeEnvSecret(envFile);
  return backup;
}

export const INIT_MESSAGES: Record<InitResult, string> = {
  created: 'Created ACCOUNTS_SECRET in the secret file and the system keyring. Back it up with: bun run account secret show. Restart the gateway to use saved accounts.',
  moved: 'Moved ACCOUNTS_SECRET out of .env into the secret file. Restart the gateway.',
  copied: 'Copied ACCOUNTS_SECRET into the secret file. Back it up with: bun run account secret show.',
  exists: 'ACCOUNTS_SECRET is already in the secret file. Back it up with: bun run account secret show.',
  environment: 'ACCOUNTS_SECRET comes from the environment; it is left there.',
  recovered: 'Recovered the ACCOUNTS_SECRET that opens the saved keys and synchronized the secret file and system keyring. Restart the gateway.',
  locked: 'None of the available ACCOUNTS_SECRET values opens the saved keys. Unlock the system keyring or restore the original secret into the secret file. Creating a new secret would leave the saved keys unreadable. If the original secret is lost, run: bun run account init --reset (backs up the encrypted vault; API keys must be added again).',
};
