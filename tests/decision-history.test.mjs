import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { buildContractPublication } from '../dist/contract-decision-report.js';
import { zipAttachments } from '../dist/unifier-attachments.js';
import { inflateRawSync } from 'node:zlib';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

export function publicationFixture() {
  const dossierId = randomUUID();
  const files = Array.from({ length: 6 }, (_, i) => ({ name: `contrato-${i + 1}.pdf`, data: Buffer.from(`%PDF-1.4\nDocumento de prueba ${i}`).toString('base64') }));
  const documents = files.map(file => ({ name: file.name, sha256: createHash('sha256').update(Buffer.from(file.data, 'base64')).digest('hex') }));
  const event = { eventId: randomUUID(), dossierId, shell: 'P-0001', recordedAt: '2026-09-18T10:00:00.000Z', kind: 'extraction', actor: 'Revisor de prueba', reason: 'Anexo 2, página 3', subject: 'Propuesta inicial', evidence: 'Importe según anexo firmado.', changes: [{ field: 'amount', before: null, after: 100 }], documents };
  return { shell: event.shell, bpname: 'Contract', files, recordFields: { amount: 125 }, reviewedFields: { amount: 125, vendor: 'Compañía Ejemplo' },
    resolutions: { 0: { type: 'exception', actor: event.actor, reason: 'Excepción aprobada por el revisor para la demo.', resolvedAt: event.recordedAt } },
    history: { dossierId, events: [event,
      { ...event, eventId: randomUUID(), kind: 'field_changed', subject: 'Importe corregido', changes: [{ field: 'amount', before: 100, after: 125 }] },
      { ...event, eventId: randomUUID(), kind: 'exception', subject: 'Validación resuelta', changes: [] },
      { ...event, eventId: randomUUID(), kind: 'publication_requested', subject: 'Publicación con documentos e historial', changes: [] },
    ] },
  };
}

test('publication packages six original PDFs plus the readable PDF and exact JSON in one ZIP', async () => {
  const input = publicationFixture();
  const before = structuredClone(input);
  const result = await buildContractPublication(input);
  assert.deepEqual(input, before, 'building the snapshot must not mutate the draft');
  assert.equal(result.attachments.length, 8);
  assert.equal(Buffer.from(result.attachments[6].base64, 'base64').subarray(0, 5).toString(), '%PDF-');
  const report = JSON.parse(Buffer.from(result.attachments[7].base64, 'base64'));
  assert.equal(report.destination.shell, input.shell);
  assert.equal(report.destination.bpname, input.bpname);
  assert.deepEqual(report.events, input.history.events);
  assert.deepEqual(report.reviewedFields, input.reviewedFields);
  assert.deepEqual(report.mappedFields, input.recordFields);
  assert.deepEqual(report.resolutions, input.resolutions);
  assert.match(report.scope, /No certifica/);
  assert.match(report.attribution, /no autenticados/);
  const zip = zipAttachments(result.attachments.map(file => ({ name: file.name, content: Buffer.from(file.base64, 'base64') })));
  let offset = 0;
  for (const attachment of result.attachments) {
    assert.equal(zip.readUInt32LE(offset), 0x04034b50);
    const size = zip.readUInt32LE(offset + 18), nameSize = zip.readUInt16LE(offset + 26);
    assert.equal(zip.subarray(offset + 30, offset + 30 + nameSize).toString(), attachment.name);
    const start = offset + 30 + nameSize;
    assert.deepEqual(inflateRawSync(zip.subarray(start, start + size)), Buffer.from(attachment.base64, 'base64'));
    offset = start + size;
  }
});

test('history from another shell or dossier, duplicate events and missing publication request are rejected', async () => {
  for (const mutate of [
    x => { x.shell = 'P-0002'; },
    x => { x.history.events[0].dossierId = randomUUID(); },
    x => { x.history.events[1].eventId = x.history.events[0].eventId; },
    x => { x.history.events.pop(); },
    x => { x.history = null; },
  ]) {
    const input = publicationFixture(); mutate(input);
    await assert.rejects(buildContractPublication(input));
  }
});

test('changed, missing, or added source documents require revalidation', async () => {
  for (const mutate of [
    x => { x.files[0].data = Buffer.from('modified').toString('base64'); },
    x => { x.files.pop(); },
    x => { x.files[0].name = 'renamed.pdf'; },
    x => { x.history.events = x.history.events.filter(e => e.kind !== 'extraction'); },
  ]) {
    const input = publicationFixture(); mutate(input);
    await assert.rejects(buildContractPublication(input), /Revalida/);
  }
});

test('report attachment names cannot collide with user documents', async () => {
  const input = publicationFixture();
  input.files[0].name = `historial-decisiones-${input.history.dossierId}.pdf`;
  input.history.events.forEach(event => { event.documents[0].name = input.files[0].name; });
  await assert.rejects(buildContractPublication(input), /mismo nombre/);
});

test('oversized histories fail before producing any publication package', async () => {
  const input = publicationFixture(); input.history.events[0].evidence = 'a'.repeat(2_000_001);
  await assert.rejects(buildContractPublication(input), /2 MB/);
});

test('browser history stays in memory, preserves revalidation and isolates dossiers without network writes', async () => {
  const nodes = new Map();
  const listeners = {};
  const node = () => ({ value: '', textContent: '', open: false, addEventListener() {}, append() {}, replaceChildren() {} });
  const document = { querySelector: selector => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); }, createElement: node };
  const window = { addEventListener: (name, fn) => { listeners[name] = fn; } };
  runInNewContext(await readFile('public/decision-history.js', 'utf8'), { window, document, crypto: webcrypto, structuredClone, fetch: () => { throw new Error('Network writes must not occur.'); } });
  const history = window.DecisionHistory;
  const files = [{ name: 'test.pdf', arrayBuffer: async () => new TextEncoder().encode('test').buffer }];
  const result = { fields: [{ id: 'amount', value: 100, evidence: 'Test' }] };
  await history.begin('P-0001', files, null, result, 'test-model');
  history.record('field_changed', 'Correction', [{ field: 'amount', before: 100, after: 125 }]);
  const before = history.snapshot();
  await history.begin('P-0001', files, result, result, 'test-model');
  assert.equal(history.snapshot().dossierId, before.dossierId);
  assert.equal(history.snapshot().events.length, 3);
  let warned = false;
  listeners.beforeunload({ preventDefault: () => { warned = true; } }); assert.ok(warned);
  history.published(); warned = false;
  listeners.beforeunload({ preventDefault: () => { warned = true; } }); assert.equal(warned, false);
  await history.begin('P-0002', files, result, result, 'test-model');
  assert.notEqual(history.snapshot().dossierId, before.dossierId);
  assert.equal(history.snapshot().events.length, 1);
  assert.equal(history.snapshot().events[0].shell, 'P-0002');
  assert.equal(before.events.length, 2, 'snapshots remain immutable when new events arrive');
});

test('web -> MCP -> simulated Unifier sends a single record with eight attachments and no local history', { skip: process.env.RUN_INTEGRATION_TESTS !== '1', timeout: 20000 }, async () => {
  const received = [];
  let unifierStatus = 200;
  const mock = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ method: req.method, url: req.url, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: unifierStatus, data: [{ record_no: 'DEMO-0001' }] }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const priorLocalHistory = await stat('data/decisions.jsonl').then(s => s.mtimeMs, () => null);
  const child = spawn(process.execPath, ['dist/web.js'], { env: {
    PATH: process.env.PATH, PORT: '0', UNIFIER_BASE_URL: `http://127.0.0.1:${mock.address().port}/test`,
    UNIFIER_ACCESS_TOKEN: 'fake-test-token', UNIFIER_ALLOW_WRITE: 'true',
    CONTRACT_BP_NAME: 'Contract', CONTRACT_FIELD_MAP_JSON: '{"amount":"amount"}', AGENT_MONITOR_INTERVAL_MINUTES: '0', APP_AUTH_DISABLED: 'true',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => {
      let log = '';
      child.on('error', reject); child.on('exit', code => reject(new Error(`Test server exited: ${code}`)));
      child.stderr.on('data', chunk => { log += chunk; const match = log.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]); });
    });
    assert.equal((await fetch(`${base}/api/decisions`)).status, 410);
    assert.equal((await fetch(`${base}/api/decisions`, { method: 'POST', body: '{}' })).status, 410);
    const input = publicationFixture();
    const payload = { shell: input.shell, reviewedFields: input.reviewedFields, files: input.files.map(f => ({ ...f, type: 'application/pdf' })), resolutions: input.resolutions, decisionHistory: input.history, unresolvedBlockers: [], confirmed: true };
    const commit = body => fetch(`${base}/api/intake/contract/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await commit({ ...payload, decisionHistory: null })).status, 500);
    assert.equal(received.length, 0);
    const success = await commit(payload);
    const response = await success.json();
    assert.equal(success.status, 200, JSON.stringify(response));
    assert.equal(response.decisionReport.files.length, 2);
    assert.equal(response.attachedFiles.length, 8);
    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/test/ws/rest/service/v1/bp/record/file/P-0001');
    assert.equal(received[0].body.data.length, 1);
    assert.equal(received[0].body.data[0]._attachment.length, 8);
    assert.equal(received[0].body.options.bpname, 'Contract');
    unifierStatus = 602;
    const failure = await commit(payload);
    assert.equal(failure.status, 500);
    assert.ok((await failure.json()).error);
    assert.equal(await stat('data/decisions.jsonl').then(s => s.mtimeMs, () => null), priorLocalHistory);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve));
  }
});
