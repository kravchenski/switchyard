import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { autoSignIn } from '../src/browser/auto-login.ts';
import type { ChatSite } from '../src/browser/browser-chat.ts';
import type { SignInResult } from '../src/browser/sign-in.ts';
import { findBrowserExecutable } from '../src/platform/browserExecutable.ts';

const loginPage = `<!doctype html><html><body><div id="app"></div><script>
function makeJwt(payload) {
  const b64 = value => btoa(JSON.stringify(value));
  return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(payload) + '.sig';
}
if (new URLSearchParams(location.search).has('stale') && !sessionStorage.getItem('stale-done')) {
  sessionStorage.setItem('stale-done', '1');
  localStorage.setItem('token', 'not-a-jwt');
  location.reload();
}
if (localStorage.getItem('token')) {
  document.getElementById('app').innerHTML = '<h1>chat ready</h1>';
} else {
  document.getElementById('app').innerHTML = '<form id="login"><input type="email" id="email"><input type="password" id="password"><button type="submit">Sign in</button></form><div id="error"></div>';
  document.getElementById('login').addEventListener('submit', event => {
    event.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    if (email === 'user@example.com' && password === 'secret') {
      localStorage.setItem('token', makeJwt({ id: 'u1', email }));
      location.reload();
    } else {
      document.getElementById('error').textContent = 'Wrong email or password';
    }
  });
}
</script></body></html>`;

const googleEntryPage = `<!doctype html><html><body>
<button id="google">Sign in with Google</button>
<script>
document.getElementById('google').addEventListener('click', () => window.open('/glogin', 'auth', 'width=480,height=640'));
</script></body></html>`;

const googleLoginPage = `<!doctype html><html><body>
<input type="email" id="email">
<button id="identifierNext" type="button">Next</button>
<input type="password" id="password" style="display:none">
<button id="passwordNext" type="button" style="display:none">Next</button>
<div id="consent" style="display:none"><button id="consentNext" type="button">Продолжить</button><button id="consentCancel" type="button">Отмена</button></div>
<div id="error"></div>
<script>
function makeJwt(payload) {
  const b64 = value => btoa(JSON.stringify(value));
  return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(payload) + '.sig';
}
document.getElementById('identifierNext').addEventListener('click', () => {
  const email = document.getElementById('email').value;
  if (email !== 'user@example.com') {
    document.getElementById('error').textContent = 'Wrong email';
    return;
  }
  document.getElementById('password').style.display = 'block';
  document.getElementById('passwordNext').style.display = 'block';
});
document.getElementById('passwordNext').addEventListener('click', () => {
  const password = document.getElementById('password').value;
  if (password !== 'secret') {
    document.getElementById('error').textContent = 'Wrong password';
    return;
  }
  document.getElementById('email').style.display = 'none';
  document.getElementById('identifierNext').style.display = 'none';
  document.getElementById('password').style.display = 'none';
  document.getElementById('passwordNext').style.display = 'none';
  document.getElementById('consent').style.display = 'block';
});
document.getElementById('consentCancel').addEventListener('click', () => {
  document.getElementById('error').textContent = 'Consent declined';
});
document.getElementById('consentNext').addEventListener('click', () => {
  localStorage.setItem('token', makeJwt({ id: 'u1', email: document.getElementById('email').value }));
  window.close();
});
</script></body></html>`;

const dashboardPage = `<!doctype html><html><body><div id="app"></div><script>
function makeJwt(payload) {
  const b64 = value => btoa(JSON.stringify(value));
  return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(payload) + '.sig';
}
if (new URLSearchParams(location.search).has('preset')) localStorage.setItem('token', makeJwt({ id: 'u1' }));
let rendered = null;
function render() {
  const signedIn = Boolean(localStorage.getItem('token'));
  if (signedIn === rendered) return;
  rendered = signedIn;
  const app = document.getElementById('app');
  if (signedIn) {
    app.innerHTML = '<h1>provider dashboard</h1><button>Create key</button>';
  } else {
    app.innerHTML = '<button id="google">Continue with Google</button><input type="email" id="email">';
    document.getElementById('google').addEventListener('click', () => window.open('/glogin', 'auth', 'width=480,height=640'));
  }
}
render();
setInterval(render, 200);
</script></body></html>`;

const disabledLoginPage = `<!doctype html><html><body><div id="app"></div><div id="consent" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999"><div style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:#fff;padding:16px"><p>We use cookies</p><button id="no-thanks">No thanks</button></div></div><script>
function makeJwt(payload) {
  const b64 = value => btoa(JSON.stringify(value));
  return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(payload) + '.sig';
}
let rendered = null;
let stage = 'entry';
let emailValue = '';
function render() {
  const signedIn = Boolean(localStorage.getItem('token'));
  if (signedIn === rendered) return;
  rendered = signedIn;
  const app = document.getElementById('app');
  if (signedIn) {
    app.innerHTML = '<h1>provider dashboard</h1>';
    return;
  }
  if (stage === 'entry') {
    app.innerHTML = '<button id="entry" disabled>Continue with email</button><input type="email" id="email" disabled>'
      + '<label><input type="checkbox" id="terms"> I agree to the Terms of Service and Privacy Policy</label>';
    document.getElementById('terms').addEventListener('change', () => {
      const ok = document.getElementById('terms').checked;
      document.getElementById('entry').disabled = !ok;
      document.getElementById('email').disabled = !ok;
    });
    document.getElementById('entry').addEventListener('click', () => {
      emailValue = document.getElementById('email').value;
      stage = 'password';
      rendered = null;
      render();
    });
    return;
  }
  app.innerHTML = '<form id="login"><input type="password" id="password"><button type="submit">Sign in</button></form>';
  document.getElementById('login').addEventListener('submit', event => {
    event.preventDefault();
    const password = document.getElementById('password').value;
    if (emailValue === 'user@example.com' && password === 'secret') localStorage.setItem('token', makeJwt({ id: 'u1' }));
  });
}
document.getElementById('no-thanks').addEventListener('click', () => document.getElementById('consent').remove());
render();
setInterval(render, 200);
</script></body></html>`;

const cookieLoginPage = `<!doctype html><html><body><div id="app"></div><script>
function makeJwt(payload) {
  const b64 = value => btoa(JSON.stringify(value));
  return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(payload) + '.sig';
}
function setCookie() {
  const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, email: 'user@example.com' });
  document.cookie = 'arena-auth-prod-v1.0=base64-' + btoa(JSON.stringify({ access_token: token }));
}
if (new URLSearchParams(location.search).has('preset')) setCookie();
let rendered = null;
function render() {
  const signedIn = Boolean(document.cookie.match(/(?:^|;\\s*)arena-auth-prod-v1\\.0=/));
  if (signedIn === rendered) return;
  rendered = signedIn;
  const app = document.getElementById('app');
  if (signedIn) {
    app.innerHTML = '<h1>chat ready</h1>';
    return;
  }
  app.innerHTML = '<form id="login"><input type="email" id="email"><input type="password" id="password"><button type="submit">Sign in</button></form>';
  document.getElementById('login').addEventListener('submit', event => {
    event.preventDefault();
    const email = document.getElementById('email').value;
    const password = document.getElementById('password').value;
    if (email === 'user@example.com' && password === 'secret') {
      setCookie();
      location.reload();
    }
  });
}
render();
setInterval(render, 200);
</script></body></html>`;

function bouncePage(next: string): string {
  return `<!doctype html><html><body><div id="app"></div><script>
${next === 'done' ? `localStorage.setItem('token', makeJwt({ id: 'u1' }));` : ''}
function makeJwt(payload) {
  const b64 = value => btoa(JSON.stringify(value));
  return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(payload) + '.sig';
}
if (${next === 'done' ? 'true' : 'false'}) {
  document.getElementById('app').innerHTML = '<h1>chat ready</h1>';
} else {
  document.getElementById('app').innerHTML = '<button id="google">Continue with Google</button>';
  document.getElementById('google').addEventListener('click', () => {
    location.href = location.origin.replace('127.0.0.1', 'localhost') + '${next === 'done' ? '' : next}';
  });
}
</script></body></html>`;
}

let server: ReturnType<typeof Bun.serve> | undefined;
let origin = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/provider/redirect' || path === '/provider/redirect-login') {
        const target = path.endsWith('redirect-login') ? '/provider/keys' : '/provider/landed';
        const host = new URL(request.url).hostname === '127.0.0.1' ? 'localhost' : '127.0.0.1';
        return new Response(null, { status: 302, headers: { location: `http://${host}:${server!.port}${target}` } });
      }
      const html = path === '/google' ? googleEntryPage
        : path === '/glogin' ? googleLoginPage
        : path === '/empty' ? '<!doctype html><html><body><h1>landing</h1></body></html>'
        : path === '/cookie' ? cookieLoginPage
        : path === '/bounce1' ? bouncePage('/bounce2')
        : path === '/bounce2' ? bouncePage('/bounce3')
        : path === '/bounce3' ? bouncePage('done')
        : path === '/provider/landed' ? '<!doctype html><html><body><h1>provider dashboard</h1><button>Create key</button></body></html>'
        : path === '/provider/disabled' ? disabledLoginPage
        : path.startsWith('/provider/') ? dashboardPage
        : loginPage;
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
});

const profileDirs: string[] = [];

afterAll(() => {
  server?.stop(true);
  for (const dir of profileDirs) rmSync(dir, { recursive: true, force: true });
});

function profile() {
  const dir = mkdtempSync(join(tmpdir(), 'auto-login-'));
  profileDirs.push(dir);
  return dir;
}

function site(id: 'fake-chat' | 'fake-google-chat' | 'fake-arena-chat' | 'fake-bounce-chat'): ChatSite {
  if (id === 'fake-chat') return { id, url: `${origin}/`, inputSelector: '#email', responseUrl: /chat/, signIn: { storageKey: 'token', claim: 'id' } };
  if (id === 'fake-google-chat') return { id, url: `${origin}/google`, inputSelector: '#google', responseUrl: /chat/, signIn: { storageKey: 'token', claim: 'id' } };
  if (id === 'fake-bounce-chat') return { id, url: `${origin}/bounce1`, inputSelector: '#google', responseUrl: /chat/, signIn: { storageKey: 'token', claim: 'id' } };
  return { id, url: 'http://127.0.0.1:1/unreachable', inputSelector: '#never', responseUrl: /never/ };
}

const cookieSite = (query = ''): ChatSite => ({
  id: 'fake-cookie-chat',
  url: `${origin}/cookie${query}`,
  inputSelector: '#email',
  responseUrl: /chat/,
  signIn: { cookie: 'arena-auth-prod-v1.0', tokenPattern: 'access_token":"([^"]+)', claim: 'email', expiring: true },
});

const credentials = { email: 'user@example.com', password: 'secret' };

describe.skipIf(process.env.RUN_BROWSER_TESTS !== '1' || !findBrowserExecutable())('auto sign-in', () => {
  test('logs in through the email and password form, then reports the profile as already signed in', async () => {
    const dir = profile();
    const recorded: Array<[string, SignInResult]> = [];
    const first = await autoSignIn({
      sites: [site('fake-chat')],
      credentials,
      profileDir: dir,
      onSignIn: (id, result) => recorded.push([id, result]),
    });
    expect(first).toEqual([{ site: 'fake-chat', status: 'logged-in', detail: 'signed in as u1' }]);
    expect(recorded).toEqual([['fake-chat', { signedIn: true }]]);

    const second = await autoSignIn({
      sites: [site('fake-chat')],
      credentials,
      profileDir: dir,
    });
    expect(second).toEqual([{ site: 'fake-chat', status: 'signed-in', detail: 'already signed in' }]);
  }, 120_000);

  test('reports a failure and the sign-in state when the password is wrong', async () => {
    const recorded: SignInResult[] = [];
    const results = await autoSignIn({
      sites: [site('fake-chat')],
      credentials: { email: 'user@example.com', password: 'wrong' },
      profileDir: profile(),
      waitForSignInMs: 2_000,
      onSignIn: (id, result) => recorded.push(result),
    });
    expect(results).toEqual([{ site: 'fake-chat', status: 'failed', detail: 'not signed in after the login attempt [direct form submitted]' }]);
    expect(recorded).toEqual([{ signedIn: false, reason: 'not signed in after the login attempt [direct form submitted]' }]);
  }, 120_000);

  test('logs in through the Google popup', async () => {
    const results = await autoSignIn({
      sites: [site('fake-google-chat')],
      credentials,
      viaGoogle: true,
      profileDir: profile(),
    });
    expect(results).toEqual([{ site: 'fake-google-chat', status: 'logged-in', detail: 'signed in as u1' }]);
  }, 120_000);

  test('prefers Google by default when the site offers it', async () => {
    const results = await autoSignIn({
      sites: [site('fake-google-chat')],
      credentials,
      profileDir: profile(),
    });
    expect(results).toEqual([{ site: 'fake-google-chat', status: 'logged-in', detail: 'signed in as u1' }]);
  }, 120_000);

  test('clears a stale token that hides the login form', async () => {
    const results = await autoSignIn({
      sites: [{ ...site('fake-chat'), url: `${origin}/?stale` }],
      credentials,
      profileDir: profile(),
    });
    expect(results).toEqual([{ site: 'fake-chat', status: 'logged-in', detail: 'signed in as u1' }]);
  }, 120_000);

  test('signs into a provider dashboard through Google', async () => {
    const results = await autoSignIn({
      sites: [],
      dashboards: [{ id: 'fake-provider', url: `${origin}/provider/keys` }],
      credentials,
      profileDir: profile(),
    });
    expect(results).toEqual([{ site: 'fake-provider', status: 'logged-in', detail: 'signed in' }]);
  }, 120_000);

  test('reports an already signed-in provider dashboard', async () => {
    const results = await autoSignIn({
      sites: [],
      dashboards: [{ id: 'fake-provider', url: `${origin}/provider/keys?preset` }],
      credentials,
      profileDir: profile(),
    });
    expect(results).toEqual([{ site: 'fake-provider', status: 'signed-in', detail: 'already signed in' }]);
  }, 120_000);

  test('reports a failed provider dashboard when the page is unreachable', async () => {
    const results = await autoSignIn({
      sites: [],
      dashboards: [{ id: 'fake-dead', url: 'http://127.0.0.1:1/keys' }],
      credentials,
      profileDir: profile(),
    });
    expect(results).toHaveLength(1);
    expect(results[0].site).toBe('fake-dead');
    expect(results[0].status).toBe('failed');
  }, 120_000);

  test('signs into a dashboard behind a consent banner whose email field starts disabled', async () => {
    const results = await autoSignIn({
      sites: [],
      dashboards: [{ id: 'fake-disabled', url: `${origin}/provider/disabled` }],
      credentials,
      profileDir: profile(),
    });
    expect(results).toEqual([{ site: 'fake-disabled', status: 'logged-in', detail: 'signed in' }]);
  }, 120_000);

  test('skips sites without a sign-in rule without opening them', async () => {
    const results = await autoSignIn({
      sites: [site('fake-arena-chat')],
      profileDir: profile(),
    });
    expect(results).toEqual([{ site: 'fake-arena-chat', status: 'skipped', detail: 'sign-in is optional' }]);
  }, 120_000);

  test('reports a failure when the login form cannot be found', async () => {
    const results = await autoSignIn({
      sites: [{ id: 'empty-chat', url: `${origin}/empty`, inputSelector: '#x', responseUrl: /x/, signIn: { storageKey: 'token', claim: 'id' } }],
      credentials,
      profileDir: profile(),
    });
    expect(results).toEqual([{ site: 'empty-chat', status: 'failed', detail: 'login form not found' }]);
  }, 120_000);

  test('reports an already signed-in site behind a cookie session', async () => {
    const results = await autoSignIn({
      sites: [cookieSite('?preset')],
      credentials,
      profileDir: profile(),
    });
    expect(results).toEqual([{ site: 'fake-cookie-chat', status: 'signed-in', detail: 'already signed in' }]);
  }, 120_000);

  test('signs into a site that stores its session in a cookie', async () => {
    const results = await autoSignIn({
      sites: [cookieSite()],
      credentials,
      profileDir: profile(),
    });
    expect(results).toEqual([{ site: 'fake-cookie-chat', status: 'logged-in', detail: 'signed in as user@example.com' }]);
  }, 120_000);

  test('retries Google sign-in when the provider bounces back to its login page', async () => {
    const results = await autoSignIn({
      sites: [site('fake-bounce-chat')],
      credentials,
      profileDir: profile(),
    });
    expect(results).toEqual([{ site: 'fake-bounce-chat', status: 'logged-in', detail: 'signed in as u1' }]);
  }, 120_000);

  test('reports a dashboard that redirects to another host without a login form as already signed in', async () => {
    const results = await autoSignIn({
      sites: [],
      dashboards: [{ id: 'fake-redirect', url: `${origin}/provider/redirect` }],
      credentials,
      profileDir: profile(),
    });
    expect(results).toEqual([{ site: 'fake-redirect', status: 'signed-in', detail: 'already signed in' }]);
  }, 120_000);

  test('signs in when the dashboard login lands on another host', async () => {
    const results = await autoSignIn({
      sites: [],
      dashboards: [{ id: 'fake-redirect-login', url: `${origin}/provider/redirect-login` }],
      credentials,
      profileDir: profile(),
    });
    expect(results).toEqual([{ site: 'fake-redirect-login', status: 'logged-in', detail: 'signed in' }]);
  }, 120_000);
});
