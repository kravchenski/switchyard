import { spawn } from 'node:child_process';
import { mkdirSync, readlinkSync } from 'node:fs';
import path from 'node:path';

import { requireBrowserExecutable } from '../platform/browserExecutable.ts';
import { launchCdpBrowser } from './cdp.ts';

const GOOGLE_SIGN_IN_URL = 'https://accounts.google.com/';
const LIST_ACCOUNTS_URL = 'https://accounts.google.com/ListAccounts?json=standard&source=ChromiumBrowser';

export function googleProfileDir(env: Record<string, string | undefined> = process.env) {
  return path.resolve(env.SESSION_DIR || 'session', 'browser-profile');
}

const HANDED_OFF_MS = 3_000;

export function profileLockOwner(profileDir: string, alive: (pid: number) => boolean = pidAlive) {
  let target: string;
  try {
    target = readlinkSync(path.join(profileDir, 'SingletonLock'));
  } catch {
    return undefined;
  }
  const pid = Number(target.slice(target.lastIndexOf('-') + 1));
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
}

function pidAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function openProfileWindow(urls: string | string[], profileDir = googleProfileDir()) {
  mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  const child = spawn(requireBrowserExecutable({ interactive: true }), [
    `--user-data-dir=${profileDir}`,
    '--password-store=basic',
    '--no-first-run',
    '--no-default-browser-check',
    ...(Array.isArray(urls) ? urls : [urls]),
  ], { stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  const owner = Date.now() - startedAt < HANDED_OFF_MS ? profileLockOwner(profileDir) : undefined;
  if (owner && owner !== child.pid) {
    throw new Error(`The browser profile is already open in another browser (pid ${owner}), so no sign-in window could be shown. Close that browser or restart the gateway, then try again.`);
  }
}

export function openGoogleSignIn(profileDir = googleProfileDir()) {
  return openProfileWindow(GOOGLE_SIGN_IN_URL, profileDir);
}

export function parseListAccounts(body: string) {
  const emails = body.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [];
  return [...new Set(emails.map(email => email.toLowerCase()))];
}

export async function listGoogleAccounts(profileDir = googleProfileDir()) {
  const cdp = await launchCdpBrowser({ profileDir });
  try {
    const context = cdp.browser.contexts()[0];
    if (!context) throw new Error('Browser profile has no default context');
    const response = await context.request.get(LIST_ACCOUNTS_URL, { timeout: 20_000 });
    return parseListAccounts(await response.text());
  } finally {
    await cdp.close();
  }
}
