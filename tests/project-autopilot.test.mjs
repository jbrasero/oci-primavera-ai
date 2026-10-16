import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { localDateTime, materialChanges, normalizeAutopilotSnapshot, ProjectAutopilotStore } from '../dist/project-autopilot.js';

const snapshot = (overrides = {}) => ({
  shell: { projectNumber: 'P-0001', status: 'Active' },
  cost: { locked: 0, snapshots: { total: 1, numericTotals: { budget_amount: 100000 } }, workPackages: { total: 2, byStatus: { Active: 2 } } },
  schedule: { sheets: { total: 1, locked: 0, byStatus: { Active: 1 } }, activities: { total: 10, overdue: 1, byStatus: { Active: 9, Completed: 1 } } },
  bps: [{ label: 'Invoices', bp: 'Invoices', total: 2, byStatus: { Approved: 2 }, numericTotals: { amount: 5000 } }],
  approvals: [{ label: 'Purchase Orders', bp: 'Purchase Orders', total: 3, pending: 1, byStatus: { Pending: 1, Approved: 2 }, byResponsible: { Ana: 1 } }],
  coverage: { costLock: 'available', scheduleSheets: 'available', activities: 'available' }, ...overrides,
});

test('first run establishes baseline, identical run stays quiet, relevant change opens one alert', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'project-autopilot-'));
  try {
    const store = new ProjectAutopilotStore(join(dir, 'state.json'), 1000);
    await store.configure({ shell: 'P-0001', enabled: true, bps: [{ label: 'Invoices', bpname: 'Invoices' }], approvalBps: [{ label: 'PO', bpname: 'Purchase Orders' }] });
    assert.equal((await store.recordSuccess('P-0001', snapshot())).status, 'baseline_created');
    assert.equal((await store.recordSuccess('P-0001', snapshot())).status, 'no_relevant_changes');
    const changed = snapshot(); changed.schedule.activities.overdue = 3; changed.approvals[0].pending = 2;
    const result = await store.recordSuccess('P-0001', changed);
    assert.equal(result.status, 'alert_opened');
    assert.equal(result.alert.severity, 'high');
    assert.ok(result.alert.changes.some(change => change.path.endsWith('overdue') && change.direction === 'worse'));
    assert.equal((await store.read()).alerts.length, 1);
  } finally { await rm(dir, { recursive: true }); }
});

test('small financial noise is ignored but configured threshold and coverage changes are material', () => {
  const before = normalizeAutopilotSnapshot(snapshot());
  const noisy = snapshot(); noisy.cost.snapshots.numericTotals.budget_amount = 100999;
  assert.equal(materialChanges(before, normalizeAutopilotSnapshot(noisy), 1000).length, 0);
  noisy.cost.snapshots.numericTotals.budget_amount = 101000;
  assert.ok(materialChanges(before, normalizeAutopilotSnapshot(noisy), 1000).some(change => change.path.includes('numericTotals')));
  const unavailable = snapshot(); unavailable.coverage.scheduleSheets = 'unavailable';
  const changes = materialChanges(before, normalizeAutopilotSnapshot(unavailable), 1000);
  assert.equal(changes[0].severity, 'high'); assert.equal(changes[0].direction, 'worse');
});

test('pausing retains baseline; changing monitored BPs creates a fresh baseline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'project-autopilot-'));
  try {
    const store = new ProjectAutopilotStore(join(dir, 'state.json'));
    const config = { shell: 'P-0001', enabled: true, bps: [], approvalBps: [] };
    await store.configure(config); await store.recordSuccess('P-0001', snapshot());
    await store.configure({ ...config, enabled: false });
    assert.equal((await store.recordSuccess('P-0001', snapshot())).status, 'no_relevant_changes');
    await store.configure({ ...config, bps: [{ label: 'Invoices', bpname: 'Invoices' }] });
    assert.equal((await store.recordSuccess('P-0001', snapshot())).status, 'baseline_created');
  } finally { await rm(dir, { recursive: true }); }
});

test('execution failures alert once per distinct error and recovery is visible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'project-autopilot-'));
  try {
    const store = new ProjectAutopilotStore(join(dir, 'state.json'));
    await store.configure({ shell: 'P-0001', enabled: true, bps: [], approvalBps: [] });
    await store.recordSuccess('P-0001', snapshot());
    assert.equal((await store.recordFailure('P-0001', 'Timeout')).status, 'alert_opened');
    assert.equal((await store.recordFailure('P-0001', 'Timeout')).status, 'same_error');
    const recovered = await store.recordSuccess('P-0001', snapshot());
    assert.equal(recovered.status, 'alert_opened'); assert.equal(recovered.alert.severity, 'info');
  } finally { await rm(dir, { recursive: true }); }
});

test('concurrent shells cannot overwrite each other in the operational store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'project-autopilot-'));
  try {
    const store = new ProjectAutopilotStore(join(dir, 'state.json'));
    await Promise.all(['P-0001', 'P-0002'].map(shell => store.configure({ shell, enabled: true, bps: [], approvalBps: [] })));
    assert.deepEqual((await store.read()).targets.map(target => target.shell), ['P-0001', 'P-0002']);
    await Promise.all(['P-0001', 'P-0002'].map(shell => store.recordSuccess(shell, { ...snapshot(), shell: { projectNumber: shell, status: 'Active' } })));
    const state = await store.read(); assert.ok(state.snapshots['P-0001']); assert.ok(state.snapshots['P-0002']);
  } finally { await rm(dir, { recursive: true }); }
});

test('Madrid morning calculation handles dates through Intl timezone', () => {
  assert.deepEqual(localDateTime('Europe/Madrid', new Date('2026-01-15T07:05:00Z')), { date: '2026-01-15', hour: 8, minute: 5 });
  assert.deepEqual(localDateTime('Europe/Madrid', new Date('2026-07-15T06:05:00Z')), { date: '2026-07-15', hour: 8, minute: 5 });
});

test('web autopilot performs read-only baseline and opens one alert only after a relevant Unifier change', { skip: process.env.RUN_INTEGRATION_TESTS !== '1', timeout: 20000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'project-autopilot-web-'));
  let overdue = 1; const calls = [];
  const mock = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://localhost'); calls.push({ method: req.method, path: url.pathname, search: url.searchParams, body: raw ? JSON.parse(raw) : null });
    let data = [];
    if (url.pathname.endsWith('/admin/projectshell')) data = [{ projectnumber: 'P-0001', projectname: 'Demo', status: 'Active' }];
    else if (url.pathname.endsWith('/admin/shell')) data = [{ shell_number: 'P-0001', uuu_shell_addl_props: { gateway: [{ p6_project_id: 'P6-AUTO' }] } }];
    else if (url.pathname.endsWith('/projectcostsheet/lockstatus')) data = [{ locked: false }];
    else if (url.pathname.endsWith('/projectcostsheet/snapshot')) data = [{ budget_amount: 100000 }];
    else if (url.pathname.endsWith('/projectcostsheet/workpackage')) data = [{ status: 'Active' }];
    else if (url.pathname.includes('/schedule/')) data = [{ status: 'Active', sheet_lock: false }];
    else if (url.pathname.endsWith('/activity/sheet/activities')) data = Array.from({ length: overdue }, (_, index) => ({ status: 'Active', due_date: `2020-01-${String(index + 1).padStart(2, '0')}` }));
    else if (url.pathname.includes('/bp/records/')) data = req.method === 'POST' && raw.includes('Purchase Orders') ? [{ status: 'Pending', assigned_to: 'Ana' }] : [{ status: 'Approved', amount: 5000 }];
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: 200, data }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['dist/web.js'], { env: {
    PATH: process.env.PATH, PORT: '0', UNIFIER_BASE_URL: `http://127.0.0.1:${mock.address().port}/test`, UNIFIER_ACCESS_TOKEN: 'fake-test-token',
    UNIFIER_ALLOW_WRITE: 'false', PROJECT_AUTOPILOT_STATE_PATH: join(dir, 'state.json'), PROJECT_AUTOPILOT_SCHEDULER: 'false', AGENT_MONITOR_INTERVAL_MINUTES: '0', APP_AUTH_DISABLED: 'true',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => {
      let log = ''; child.on('error', reject); child.on('exit', code => reject(new Error(`Test server exited: ${code}`)));
      child.stderr.on('data', chunk => { log += chunk; const match = log.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) resolve(match[0]); });
    });
    const request = async (path, options) => { const response = await fetch(`${base}${path}`, options); const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value; };
    const config = { enabled: true, bps: [{ label: 'Invoices', bpname: 'Invoices' }], approvalBps: [{ label: 'PO', bpname: 'Purchase Orders' }] };
    await request('/api/autopilot/targets/P-0001', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
    assert.equal((await request('/api/autopilot/targets/P-0001/run', { method: 'POST' })).status, 'baseline_created');
    assert.equal((await request('/api/autopilot/targets/P-0001/run', { method: 'POST' })).status, 'no_relevant_changes');
    overdue = 3;
    const changed = await request('/api/autopilot/targets/P-0001/run', { method: 'POST' });
    assert.equal(changed.status, 'alert_opened'); assert.ok(changed.alert.changes.some(change => change.path.endsWith('overdue')));
    const state = await request('/api/autopilot');
    assert.equal(state.alerts.length, 1); assert.equal(state.targets[0].shell, 'P-0001');
    await request(`/api/autopilot/alerts/${state.alerts[0].id}/ack`, { method: 'POST' });
    assert.ok((await request('/api/autopilot')).alerts[0].acknowledgedAt);
    assert.ok(calls.filter(call => call.method === 'POST').every(call => call.path.includes('/bp/records/')), 'POST against Unifier is only the documented read endpoint');
    assert.ok(calls.some(call => call.path.endsWith('/activity/sheet/activities') && call.search.get('source_project_id') === 'P6-AUTO'));
  } finally {
    child.kill('SIGTERM'); await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)); await rm(dir, { recursive: true });
  }
});
