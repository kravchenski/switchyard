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

const disabledLoginPage = `<!doctype html><html><body><div id="app"></div><script>
function makeJwt(payload) {
  const b64 = value => btoa(JSON.stringify(value));
  return b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64(payload) + '.sig';
}
let rendered = null;
function render() {
  const signedIn = Boolean(localStorage.getItem('token'));
  if (signedIn === rendered) return;
  rendered = signedIn;
  const app = document.getElementById('app');
  if (signedIn) {
    app.innerHTML = '<h1>provider dashboard</h1>';
    return;
  }
  app.innerHTML = '<button id="entry">Continue with email</button><input type="email" id="email" disabled>'
    + '<form id="login" style="display:none"><input type="email" id="email2"><input type="password" id="password"><button type="submit">Sign in</button></form>';
  document.getElementById('entry').addEventListener('click', () => {
    document.getElementById('login').style.display = 'block';
  });
  document.getElementById('login').addEventListener('submit', event => {
    event.preventDefault();
    const email = document.getElementById('email2').value;
    const password = document.getElementById('password').value;
    if (email === 'user@example.com' && password === 'secret') localStorage.setItem('token', makeJwt({ id: 'u1' }));
  });
}
render();
setInterval(render, 200);
</script></body></html>`;

let server: ReturnType<typeof Bun.serve> | undefined;
let origin = '';

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      const html = path === '/google' ? googleEntryPage
        : path === '/glogin' ? googleLoginPage
        : path === '/empty' ? '<!doctype html><html><body><h1>landing</h1></body></html>'
        : path === '/provider/disabled' ? disabledLoginPage
        : path.startsWith('/provider/') ? dashboardPage
        : loginPage;
      return new Response(html, { headers: { 'content-type': 'text/html' } });
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

function site(id: 'fake-chat' | 'fake-google-chat' | 'fake-arena-chat'): ChatSite {
  if (id === 'fake-chat') return { id, url: `${origin}/`, inputSelector: '#email', responseUrl: /chat/, signIn: { storageKey: 'token', claim: 'id' } };
  if (id === 'fake-google-chat') return { id, url: `${origin}/google`, inputSelector: '#google', responseUrl: /chat/, signIn: { storageKey: 'token', claim: 'id' } };
  return { id, url: 'http://127.0.0.1:1/unreachable', inputSelector: '#never', responseUrl: /never/ };
}

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

  test('signs into a dashboard whose email field starts disabled', async () => {
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
});
