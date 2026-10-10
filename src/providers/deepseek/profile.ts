import { launchCdpBrowser, type CdpBrowser, type LaunchOptions } from '../../browser/cdp.ts';
import type { SignInResult } from '../../browser/sign-in.ts';
import { normalizeToken } from '../../core/accounts/token.ts';
import { addDeepSeekAccount, loadDeepSeekAccounts, removeDeepSeekAccount, type DeepSeekAccount } from './accounts.ts';
import { checkDeepSeekToken } from './auth.ts';

export const DEEPSEEK_SIGN_IN_SITE = { id: 'deepseek', url: 'https://chat.deepseek.com/' };

export function profileAccountId(profileId: string) {
  return `deepseek_profile_${profileId}`;
}

export interface DeepSeekProfileDeps {
  launch?: (options: LaunchOptions) => Promise<CdpBrowser>;
  check?: (token: string) => Promise<string | undefined>;
  save?: (account: DeepSeekAccount) => void;
  forget?: (id: string) => void;
}

function forgetProfileAccount(id: string) {
  if (loadDeepSeekAccounts().some(account => account.id === id)) removeDeepSeekAccount(id);
}

export async function checkDeepSeekProfile(profileId: string, profileDir: string, deps: DeepSeekProfileDeps = {}): Promise<SignInResult> {
  const id = profileAccountId(profileId);
  const forget = deps.forget ?? forgetProfileAccount;
  const cdp = await (deps.launch ?? launchCdpBrowser)({ profileDir });
  try {
    const context = cdp.browser.contexts()[0];
    if (!context) throw new Error('Browser profile has no default context');
    const page = await context.newPage();
    let raw: string | null;
    try {
      await page.goto(DEEPSEEK_SIGN_IN_SITE.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      raw = await page.evaluate(() => localStorage.getItem('userToken'));
    } catch (error) {
      return { signedIn: false, reason: `page did not load: ${error instanceof Error ? error.message : error}`.slice(0, 200) };
    } finally {
      await page.close().catch(() => {});
    }
    const token = raw ? normalizeToken(raw) : '';
    if (!token) {
      forget(id);
      return { signedIn: false, reason: 'not signed in' };
    }
    const rejected = await (deps.check ?? checkDeepSeekToken)(token);
    if (rejected) {
      forget(id);
      return { signedIn: false, reason: `session rejected: ${rejected}` };
    }
    const cookies = await context.cookies(DEEPSEEK_SIGN_IN_SITE.url);
    (deps.save ?? addDeepSeekAccount)({ id, token, cookies, invalid: false, resetAt: null });
    return { signedIn: true };
  } finally {
    await cdp.close();
  }
}
