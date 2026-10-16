import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUnifierJson, restBaseUrl } from '../dist/unifier-response.js';

test('normalizes UI URL to documented REST company root', () => {
  assert.equal(restBaseUrl('https://example.com/company/unifier/'), 'https://example.com/company');
  assert.equal(restBaseUrl('https://example.com/company/'), 'https://example.com/company');
  assert.equal(restBaseUrl('https://example.com/em2/ws/rest/service/'), 'https://example.com/em2');
});
test('HTTP 200 login page is never accepted as a working REST response', async () => {
  await assert.rejects(readUnifierJson(new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } })), /HTML/);
});
test('redirects, unauthorized, malformed JSON and application errors fail', async () => {
  for (const response of [new Response(null, { status: 302 }), new Response(null, { status: 401 }), new Response('invalid'), Response.json({ status: 602, data: [] })]) {
    await assert.rejects(readUnifierJson(response));
  }
});
test('valid empty and populated lists are accepted', async () => {
  for (const data of [[], [{ projectnumber: 'TEST' }]]) {
    assert.deepEqual(await readUnifierJson(Response.json({ status: 200, data })), { status: 200, data });
  }
});
