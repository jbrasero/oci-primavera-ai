import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

test('web authentication protects APIs, creates an HttpOnly session and logs out', { skip: process.env.RUN_INTEGRATION_TESTS !== '1', timeout: 15000 }, async () => {
  const child = spawn(process.execPath, ['dist/web.js'], { env: {
    PATH: process.env.PATH, PORT: '0', APP_AUTH_USERNAME: 'test-admin', APP_AUTH_PASSWORD: 'integration-test-password', APP_AUTH_SECURE_COOKIE: 'true',
    PROJECT_AUTOPILOT_SCHEDULER: 'false', AGENT_MONITOR_INTERVAL_MINUTES: '0',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => {
      let log = '';
      child.on('error', reject); child.on('exit', code => reject(new Error(`Test server exited: ${code}`)));
      child.stderr.on('data', chunk => { log += chunk; const match = log.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]); });
    });
    assert.equal((await fetch(`${base}/api/health`)).status, 401);
    const wrong = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'incorrecta' }) });
    assert.equal(wrong.status, 401);
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'test-admin', password: 'integration-test-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /^unifier_session=/); assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Secure/);
    assert.equal((await fetch(`${base}/api/auth/session`, { headers: { Cookie: cookie } }).then(response => response.json())).authenticated, true);
    assert.equal((await fetch(`${base}/api/health`, { headers: { Cookie: cookie } })).status, 200);
    const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await fetch(`${base}/api/health`, { headers: { Cookie: cookie } })).status, 401);

    const embeddedLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Unifier-Embed': '1' }, body: JSON.stringify({ username: 'test-admin', password: 'integration-test-password' }) });
    assert.equal(embeddedLogin.status, 200);
    const embeddedCookie = embeddedLogin.headers.get('set-cookie');
    assert.match(embeddedCookie, /^__Host-unifier_embed_session=/);
    assert.match(embeddedCookie, /HttpOnly/); assert.match(embeddedCookie, /SameSite=None/); assert.match(embeddedCookie, /Secure/); assert.match(embeddedCookie, /Partitioned/);
    assert.equal((await fetch(`${base}/api/auth/session`, { headers: { Cookie: embeddedCookie, 'X-Unifier-Embed': '1' } }).then(response => response.json())).authenticated, true);
    const embeddedPair = embeddedCookie.split(';', 1)[0];
    assert.equal((await fetch(`${base}/api/auth/session`, { headers: { Cookie: `unifier_session=expired-after-restart; ${embeddedPair}`, 'X-Unifier-Embed': '1' } }).then(response => response.json())).authenticated, true);
    assert.equal((await fetch(`${base}/api/health`, { headers: { Cookie: embeddedCookie } })).status, 200);
    const embeddedLogout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { Cookie: embeddedCookie, 'X-Unifier-Embed': '1' } });
    assert.equal(embeddedLogout.status, 200);
    assert.match(embeddedLogout.headers.get('set-cookie'), /^__Host-unifier_embed_session=/);
    assert.match(embeddedLogout.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await fetch(`${base}/api/health`, { headers: { Cookie: embeddedCookie } })).status, 401);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
  }
});
