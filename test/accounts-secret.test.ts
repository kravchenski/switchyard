import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { INIT_MESSAGES, initAccountsSecret, readFileSecret, resetAccountsSecret } from '../src/cli/accounts-secret.ts';
import { runAccountsCommand, type AccountsCliDeps } from '../src/cli/accounts.ts';
import { CredentialStore } from '../src/core/accounts/credential-store.ts';
import {
  accountsSecret,
  accountsSecretFile,
  forgetAccountsSecret,
  KEYRING_ENTRY,
  loadAccountsSecret as loadSecret,
  readSecretFile,
  writeSecretFile,
  type Keyring,
} from '../src/core/secrets/accounts-secret.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'secret-'));
const secretFile = () => join(scratch(), 'nested', 'secret');
const envFile = () => join(scratch(), '.env');
const SECRET = 'correct horse battery staple';
const WRONG_SECRET = 'a different long secret';

function loadAccountsSecret(keyring: Keyring, env: Record<string, string | undefined>, file: string, credentialsFile = join(scratch(), 'credentials.enc'), dotenvFile = envFile()) {
  return loadSecret(keyring, env, file, credentialsFile, dotenvFile);
}

function fakeKeyring(initial?: string, options: { broken?: boolean; dropWrites?: boolean } = {}) {
  let value = initial;
  const keyring: Keyring = {
    get: async entry => {
      if (options.broken) throw new Error('no keyring daemon');
      expect(entry).toEqual(KEYRING_ENTRY);
      return value ?? null;
    },
    set: async entry => {
      if (options.broken) throw new Error('no keyring daemon');
      if (!options.dropWrites) value = entry.value;
    },
  };
  return { keyring, value: () => value };
}

afterEach(forgetAccountsSecret);

describe('initAccountsSecret', () => {
  test('creates a new secret in the secret file and the keyring', async () => {
    const file = secretFile();
    const store = fakeKeyring();
    expect(await initAccountsSecret({ secretFile: file, envFile: envFile(), env: {}, keyring: store.keyring, random: () => 'fresh' })).toBe('created');
    expect(readSecretFile(file)).toBe('fresh');
    expect(store.value()).toBe('fresh');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test('moves a legacy .env copy into the secret file and empties .env', async () => {
    const file = secretFile();
    const env = envFile();
    writeFileSync(env, 'NVIDIA_API_KEY=k\nACCOUNTS_SECRET="from-file"\nHOST=0.0.0.0\n');
    const store = fakeKeyring();
    expect(await initAccountsSecret({ secretFile: file, envFile: env, env: { ACCOUNTS_SECRET: 'from-file' }, keyring: store.keyring })).toBe('moved');
    expect(readSecretFile(file)).toBe('from-file');
    expect(store.value()).toBe('from-file');
    expect(readFileSecret(env)).toBeUndefined();
    expect(readFileSync(env, 'utf8')).toBe('NVIDIA_API_KEY=k\nHOST=0.0.0.0\n');
  });

  test('migrates a .env copy even when the keyring is unavailable', async () => {
    const file = secretFile();
    const env = envFile();
    writeFileSync(env, 'ACCOUNTS_SECRET=file\n');
    expect(await initAccountsSecret({ secretFile: file, envFile: env, env: {}, keyring: fakeKeyring(undefined, { broken: true }).keyring })).toBe('moved');
    expect(readSecretFile(file)).toBe('file');
    expect(readFileSecret(env)).toBeUndefined();
  });

  test('keeps the secret file and copies it into the keyring', async () => {
    const file = secretFile();
    writeSecretFile(file, 'durable');
    const store = fakeKeyring();
    expect(await initAccountsSecret({ secretFile: file, envFile: envFile(), env: {}, keyring: store.keyring, random: () => 'unused' })).toBe('copied');
    expect(store.value()).toBe('durable');
    expect(readSecretFile(file)).toBe('durable');
  });

  test('leaves a secret that is already in both places alone', async () => {
    const file = secretFile();
    writeSecretFile(file, 'same');
    expect(await initAccountsSecret({ secretFile: file, envFile: envFile(), env: {}, keyring: fakeKeyring('same').keyring })).toBe('exists');
    expect(readSecretFile(file)).toBe('same');
  });

  test('refuses to pick between two different secrets', async () => {
    const file = secretFile();
    writeSecretFile(file, 'file');
    const store = fakeKeyring('keyring');
    await expect(initAccountsSecret({ secretFile: file, envFile: envFile(), env: {}, keyring: store.keyring })).rejects.toThrow('different ACCOUNTS_SECRET');
    expect(readSecretFile(file)).toBe('file');
    expect(store.value()).toBe('keyring');
  });

  test('never mints a new secret while saved keys already exist', async () => {
    const file = secretFile();
    const vault = join(scratch(), 'credentials.enc');
    writeFileSync(vault, 'unreadable-without-the-secret');
    const store = fakeKeyring();
    expect(await initAccountsSecret({ secretFile: file, envFile: envFile(), env: {}, keyring: store.keyring, random: () => 'fresh', credentialsFile: vault })).toBe('locked');
    expect(existsSync(file)).toBeFalse();
    expect(store.value()).toBeUndefined();
    expect(INIT_MESSAGES.locked).toContain('unreadable');
  });

  test('falls back to the secret file without a keyring and leaves environment secrets alone', async () => {
    const file = secretFile();
    expect(await initAccountsSecret({ secretFile: file, envFile: envFile(), env: {}, keyring: fakeKeyring(undefined, { broken: true }).keyring, random: () => 'fallback' })).toBe('created');
    expect(readSecretFile(file)).toBe('fallback');

    const other = secretFile();
    expect(await initAccountsSecret({ secretFile: other, envFile: envFile(), env: { ACCOUNTS_SECRET: 'docker' }, keyring: fakeKeyring().keyring })).toBe('environment');
    expect(existsSync(other)).toBeFalse();

    expect(await initAccountsSecret({ secretFile: other, envFile: envFile(), env: {}, keyring: fakeKeyring('stored').keyring })).toBe('copied');
    expect(readSecretFile(other)).toBe('stored');
  });

  test('recovers a working keyring secret instead of copying an incorrect file secret over it', async () => {
    const file = secretFile();
    const vault = join(scratch(), 'credentials.enc');
    const credentials = new CredentialStore(vault, SECRET);
    credentials.addApiKey({ provider: 'nvidia', label: 'a', apiKey: 'saved-key' });
    const original = readFileSync(vault, 'utf8');
    writeSecretFile(file, WRONG_SECRET);
    const store = fakeKeyring(SECRET);
    expect(await initAccountsSecret({ secretFile: file, envFile: envFile(), env: {}, keyring: store.keyring, credentialsFile: vault })).toBe('recovered');
    expect(readSecretFile(file)).toBe(SECRET);
    expect(store.value()).toBe(SECRET);
    expect(readFileSync(vault, 'utf8')).toBe(original);
    expect(credentials.list()[0]?.token).toBe('saved-key');
  });

  test('leaves every secret and the vault untouched when none opens it', async () => {
    const file = secretFile();
    const vault = join(scratch(), 'credentials.enc');
    const dotenv = envFile();
    new CredentialStore(vault, SECRET).addApiKey({ provider: 'nvidia', label: 'a', apiKey: 'saved-key' });
    const original = readFileSync(vault, 'utf8');
    writeSecretFile(file, WRONG_SECRET);
    writeFileSync(dotenv, `ACCOUNTS_SECRET=${WRONG_SECRET}\n`);
    const store = fakeKeyring(WRONG_SECRET);
    expect(await initAccountsSecret({ secretFile: file, envFile: dotenv, env: {}, keyring: store.keyring, credentialsFile: vault })).toBe('locked');
    expect(readSecretFile(file)).toBe(WRONG_SECRET);
    expect(readFileSecret(dotenv)).toBe(WRONG_SECRET);
    expect(store.value()).toBe(WRONG_SECRET);
    expect(readFileSync(vault, 'utf8')).toBe(original);
  });
});

describe('resetAccountsSecret', () => {
  test('preserves the old ciphertext and allows new keys to be saved after restarting', async () => {
    const file = secretFile();
    const vault = join(scratch(), 'credentials.enc');
    const dotenv = envFile();
    new CredentialStore(vault, SECRET).addApiKey({ provider: 'nvidia', label: 'old', apiKey: 'old-key' });
    const original = readFileSync(vault, 'utf8');
    writeFileSync(dotenv, `OTHER=keep\nACCOUNTS_SECRET=${SECRET}\n`);
    const store = fakeKeyring(SECRET);
    const backup = await resetAccountsSecret({ secretFile: file, envFile: dotenv, env: {}, keyring: store.keyring, credentialsFile: vault, random: () => WRONG_SECRET });
    expect(backup).toBeDefined();
    expect(readFileSync(backup!, 'utf8')).toBe(original);
    expect(new CredentialStore(backup!, SECRET).list()[0]?.token).toBe('old-key');
    expect(existsSync(vault)).toBeFalse();
    expect(readSecretFile(file)).toBe(WRONG_SECRET);
    expect(store.value()).toBe(WRONG_SECRET);
    expect(readFileSync(dotenv, 'utf8')).toBe('OTHER=keep\n');
    expect(await loadAccountsSecret(store.keyring, {}, file, vault, dotenv)).toBe('file');
    const reopened = new CredentialStore(vault, () => accountsSecret({}));
    reopened.addApiKey({ provider: 'nvidia', label: 'new', apiKey: 'new-key' });
    expect(reopened.list()[0]?.token).toBe('new-key');
  });

  test('restores the original vault if the secret file cannot be written', async () => {
    const vault = join(scratch(), 'credentials.enc');
    writeFileSync(vault, 'original-ciphertext');
    const invalidParent = join(scratch(), 'not-a-directory');
    writeFileSync(invalidParent, 'file');
    const store = fakeKeyring(SECRET);
    await expect(resetAccountsSecret({ secretFile: join(invalidParent, 'secret'), envFile: envFile(), env: {}, keyring: store.keyring, credentialsFile: vault, random: () => WRONG_SECRET })).rejects.toThrow();
    expect(readFileSync(vault, 'utf8')).toBe('original-ciphertext');
    expect(store.value()).toBe(SECRET);
  });
});

describe('secret file', () => {
  test('defaults to the config directory and honours ACCOUNTS_SECRET_FILE', () => {
    expect(accountsSecretFile({ ACCOUNTS_SECRET_FILE: '/tmp/custom', HOME: '/home/me' })).toBe('/tmp/custom');
    if (process.platform === 'linux') {
      expect(accountsSecretFile({ HOME: '/home/me', XDG_CONFIG_HOME: undefined })).toBe('/home/me/.config/free-ai-gateway/secret');
      expect(accountsSecretFile({ HOME: '/home/me', XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/free-ai-gateway/secret');
    }
  });

  test('writes atomically with mode 600 and reads back empty files as nothing', () => {
    const file = secretFile();
    writeSecretFile(file, 'value');
    expect(readSecretFile(file)).toBe('value');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(existsSync(`${file}.tmp`)).toBeFalse();

    writeFileSync(file, '   \n');
    expect(readSecretFile(file)).toBeUndefined();
    expect(readSecretFile(join(scratch(), 'nope'))).toBeUndefined();
  });
});

describe('loadAccountsSecret', () => {
  test('prefers the environment and removes it so child processes do not inherit it', async () => {
    const env: Record<string, string | undefined> = { ACCOUNTS_SECRET: 'env-secret', OTHER: 'x' };
    expect(await loadAccountsSecret(fakeKeyring('keyring-secret').keyring, env, secretFile())).toBe('environment');
    expect(env).toEqual({ OTHER: 'x' });
    expect(accountsSecret({})).toBe('env-secret');
  });

  test('reads the secret file before the keyring', async () => {
    const file = secretFile();
    writeSecretFile(file, 'file-secret');
    expect(await loadAccountsSecret(fakeKeyring('keyring-secret').keyring, {}, file)).toBe('file');
    expect(accountsSecret({})).toBe('file-secret');

    const empty = secretFile();
    expect(await loadAccountsSecret(fakeKeyring('keyring-secret').keyring, {}, empty)).toBe('keyring');
    expect(accountsSecret({})).toBe('keyring-secret');

    expect(await loadAccountsSecret(fakeKeyring().keyring, {}, secretFile())).toBe('missing');
    expect(accountsSecret({})).toBeUndefined();
    expect(await loadAccountsSecret(fakeKeyring(undefined, { broken: true }).keyring, {}, secretFile())).toBe('missing');
  });

  test('the credential store reads the loaded secret lazily', async () => {
    const store = new CredentialStore(join(scratch(), 'credentials.enc'), () => accountsSecret({}));
    expect(() => store.list()).not.toThrow();
    expect(() => store.addApiKey({ provider: 'nvidia', label: 'a', apiKey: 'k' })).toThrow('run: bun run account init');
    await loadAccountsSecret(fakeKeyring('correct horse battery staple').keyring, {}, secretFile());
    store.addApiKey({ provider: 'nvidia', label: 'a', apiKey: 'k' });
    expect(store.list()).toHaveLength(1);
  });

  test('tries the keyring when both environment and file secrets fail to open saved keys', async () => {
    const file = secretFile();
    const vault = join(scratch(), 'credentials.enc');
    new CredentialStore(vault, SECRET).addApiKey({ provider: 'nvidia', label: 'a', apiKey: 'saved-key' });
    writeSecretFile(file, WRONG_SECRET);
    const env: Record<string, string | undefined> = { ACCOUNTS_SECRET: WRONG_SECRET };
    expect(await loadAccountsSecret(fakeKeyring(SECRET).keyring, env, file, vault)).toBe('keyring');
    expect(env).toEqual({});
    expect(accountsSecret({})).toBe(SECRET);
    expect(readSecretFile(file)).toBe(WRONG_SECRET);
  });

  test('tries the legacy .env copy and reports locked when no secret opens saved keys', async () => {
    const file = secretFile();
    const vault = join(scratch(), 'credentials.enc');
    const dotenv = envFile();
    new CredentialStore(vault, SECRET).addApiKey({ provider: 'nvidia', label: 'a', apiKey: 'saved-key' });
    writeFileSync(dotenv, `ACCOUNTS_SECRET="${SECRET}"\n`);
    expect(await loadAccountsSecret(fakeKeyring(WRONG_SECRET).keyring, {}, file, vault, dotenv)).toBe('env-file');
    expect(accountsSecret({})).toBe(SECRET);
    writeFileSync(dotenv, `ACCOUNTS_SECRET=${WRONG_SECRET}\n`);
    expect(await loadAccountsSecret(fakeKeyring(WRONG_SECRET).keyring, {}, file, vault, dotenv)).toBe('locked');
    expect(accountsSecret({})).toBeUndefined();
    expect(new CredentialStore(vault, SECRET).list()[0]?.token).toBe('saved-key');
  });
});

describe('accounts CLI secret commands', () => {
  const deps = (lines: string[], overrides: Partial<AccountsCliDeps> = {}): AccountsCliDeps => ({
    store: { list: () => [], addApiKey: () => { throw new Error('unused'); }, remove: () => false },
    askHidden: async () => '',
    log: line => lines.push(line),
    initSecret: async () => 'Created ACCOUNTS_SECRET',
    secretSource: async () => 'file',
    showSecret: async () => 'Secret file: /tmp/secret\nACCOUNTS_SECRET=abc',
    ...overrides,
  });

  test('init and secret report what happened', async () => {
    const lines: string[] = [];
    expect(await runAccountsCommand(['init'], deps(lines))).toBe(0);
    expect(await runAccountsCommand(['secret'], deps(lines))).toBe(0);
    expect(lines).toEqual(['Created ACCOUNTS_SECRET', 'ACCOUNTS_SECRET: file']);
  });

  test('secret --show prints the value so it can be backed up', async () => {
    const lines: string[] = [];
    expect(await runAccountsCommand(['secret', '--show'], deps(lines))).toBe(0);
    expect(lines).toEqual(['Secret file: /tmp/secret\nACCOUNTS_SECRET=abc']);
  });

  test('only resets the vault when --reset is explicitly requested', async () => {
    const lines: string[] = [];
    const callbacks = deps(lines, { resetSecret: async () => 'Backed up the encrypted vault' });
    expect(await runAccountsCommand(['init'], callbacks)).toBe(0);
    expect(await runAccountsCommand(['init', '--reset'], callbacks)).toBe(0);
    expect(lines).toEqual(['Created ACCOUNTS_SECRET', 'Backed up the encrypted vault']);
  });

  test('secret distinguishes a locked keyring from a missing secret', async () => {
    const lines: string[] = [];
    expect(await runAccountsCommand(['secret'], deps(lines, { secretSource: async () => 'locked' }))).toBe(0);
    expect(lines).toEqual(['ACCOUNTS_SECRET: locked']);
    expect(INIT_MESSAGES.locked).toContain('unreadable');
  });
});
