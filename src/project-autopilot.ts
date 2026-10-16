import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';

const bpSchema = z.object({ label: z.string().trim().min(1).max(100), bpname: z.string().trim().min(1).max(200), record_fields: z.string().trim().max(2000).optional() }).strict();
export const autopilotTargetSchema = z.object({
  shell: z.string().trim().min(1).max(100), enabled: z.boolean().default(true),
  bps: z.array(bpSchema).max(12).default([]), approvalBps: z.array(bpSchema).max(12).default([]),
  sourceProjectId: z.string().trim().max(200).optional(),
}).strict();
export type AutopilotTarget = z.infer<typeof autopilotTargetSchema> & { createdAt: string; updatedAt: string; lastRunAt?: string; lastScheduledDate?: string; lastError?: string };
export type AutopilotAlert = { id: string; shell: string; openedAt: string; severity: 'high' | 'medium' | 'info'; title: string; changes: AutopilotChange[]; acknowledgedAt?: string };
export type AutopilotChange = { path: string; label: string; before: unknown; after: unknown; direction: 'worse' | 'better' | 'changed'; severity: 'high' | 'medium' | 'info' };
type State = { version: 1; targets: AutopilotTarget[]; snapshots: Record<string, unknown>; alerts: AutopilotAlert[] };

const emptyState = (): State => ({ version: 1, targets: [], snapshots: {}, alerts: [] });
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const friendly = (path: string) => path.split('.').map(part => ({
  shellStatus: 'estado del shell', locked: 'elementos bloqueados', total: 'total', overdue: 'actividades vencidas', pending: 'aprobaciones pendientes',
  byStatus: 'estado', byResponsible: 'responsable', numericTotals: 'importe', schedule: 'planificación', cost: 'coste', coverage: 'cobertura',
}[part] ?? part)).join(' / ');

function severity(path: string, before: unknown, after: unknown): Pick<AutopilotChange, 'direction' | 'severity'> {
  const risky = /(overdue|pending|locked|late|hold|failed|error|unavailable)/i.test(path);
  if (typeof before === 'number' && typeof after === 'number' && risky) {
    if (after > before) return { direction: 'worse', severity: /overdue|failed|error|unavailable/i.test(path) ? 'high' : 'medium' };
    if (after < before) return { direction: 'better', severity: 'info' };
  }
  if (/shellStatus/i.test(path)) return { direction: 'changed', severity: String(after).toLowerCase() === 'active' ? 'info' : 'high' };
  if (/coverage/i.test(path)) return { direction: after === 'available' ? 'better' : 'worse', severity: after === 'available' ? 'info' : 'high' };
  return { direction: 'changed', severity: 'medium' };
}

export function materialChanges(previous: unknown, current: unknown, amountDelta = 1000): AutopilotChange[] {
  const changes: AutopilotChange[] = [];
  const visit = (before: unknown, after: unknown, path: string) => {
    if (same(before, after)) return;
    if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
      for (const key of new Set([...Object.keys(before as object), ...Object.keys(after as object)])) visit((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], path ? `${path}.${key}` : key);
      return;
    }
    if (/numericTotals/i.test(path) && typeof before === 'number' && typeof after === 'number' && Math.abs(after - before) < amountDelta) return;
    const impact = severity(path, before, after);
    changes.push({ path, label: friendly(path), before: before ?? null, after: after ?? null, ...impact });
  };
  visit(previous, current, '');
  return changes.slice(0, 100);
}

export function normalizeAutopilotSnapshot(payload: unknown) {
  const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const keyed = (value: unknown) => Object.fromEntries((Array.isArray(value) ? value : []).map(item => {
    const record = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    return [String(record.bp ?? record.label ?? 'unknown'), record];
  }));
  return stable({ shellStatus: (data.shell as Record<string, unknown> | undefined)?.status ?? null, cost: data.cost ?? {}, schedule: data.schedule ?? {}, bps: keyed(data.bps), approvals: keyed(data.approvals), coverage: data.coverage ?? {} });
}

/** Operational state only: baseline and UI alerts. It never contains Unifier credentials or full records. */
export class ProjectAutopilotStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string, private readonly amountDelta = 1000) {}
  private async readDisk(): Promise<State> {
    try {
      const value = JSON.parse(await readFile(this.path, 'utf8')) as State;
      return value?.version === 1 && Array.isArray(value.targets) && value.snapshots && Array.isArray(value.alerts) ? value : emptyState();
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyState(); throw error; }
  }
  async read(): Promise<State> { await this.queue; return this.readDisk(); }
  private async writeDisk(state: State) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, this.path);
  }
  private mutate<T>(operation: (state: State) => T | Promise<T>): Promise<T> {
    const result = this.queue.then(async () => { const state = await this.readDisk(); const value = await operation(state); await this.writeDisk(state); return value; });
    this.queue = result.catch(() => {}); return result;
  }
  async configure(input: unknown) {
    const parsed = autopilotTargetSchema.parse(input); const now = new Date().toISOString();
    return this.mutate(state => {
      const existing = state.targets.find(target => target.shell === parsed.shell);
      const comparable = existing && { shell: existing.shell, bps: existing.bps, approvalBps: existing.approvalBps, sourceProjectId: existing.sourceProjectId };
      const next: AutopilotTarget = { ...parsed, createdAt: existing?.createdAt ?? now, updatedAt: now, lastRunAt: existing?.lastRunAt, lastScheduledDate: existing?.lastScheduledDate, lastError: existing?.lastError };
      state.targets = [...state.targets.filter(target => target.shell !== parsed.shell), next].sort((a, b) => a.shell.localeCompare(b.shell));
      if (!same(comparable, { shell: parsed.shell, bps: parsed.bps, approvalBps: parsed.approvalBps, sourceProjectId: parsed.sourceProjectId })) delete state.snapshots[parsed.shell];
      return next;
    });
  }
  async recordSuccess(shell: string, payload: unknown, scheduledDate?: string) {
    const snapshot = normalizeAutopilotSnapshot(payload); const now = new Date().toISOString();
    return this.mutate(state => {
      const target = state.targets.find(item => item.shell === shell); if (!target) throw new Error(`El shell ${shell} no está configurado en el autopilot.`);
      const previous = state.snapshots[shell]; const changes = previous === undefined ? [] : materialChanges(previous, snapshot, this.amountDelta);
      if (previous !== undefined && target.lastError) changes.unshift({ path: 'coverage.autopilot', label: 'cobertura / autopilot', before: 'unavailable', after: 'available', direction: 'better', severity: 'info' });
      let alert: AutopilotAlert | undefined;
      if (changes.length) {
        const level = changes.some(change => change.severity === 'high') ? 'high' : changes.some(change => change.severity === 'medium') ? 'medium' : 'info';
        alert = { id: randomUUID(), shell, openedAt: now, severity: level, title: `${changes.length} cambio${changes.length === 1 ? '' : 's'} relevante${changes.length === 1 ? '' : 's'} en ${shell}`, changes };
        state.alerts.unshift(alert); state.alerts = state.alerts.slice(0, 200);
      }
      state.snapshots[shell] = snapshot; target.lastRunAt = now; target.lastError = undefined; if (scheduledDate) target.lastScheduledDate = scheduledDate;
      return { status: previous === undefined ? 'baseline_created' : alert ? 'alert_opened' : 'no_relevant_changes', alert, snapshot };
    });
  }
  async recordFailure(shell: string, message: string, scheduledDate?: string) {
    const now = new Date().toISOString();
    return this.mutate(state => {
      const target = state.targets.find(item => item.shell === shell); if (!target) throw new Error(`El shell ${shell} no está configurado.`);
      const previousError = target.lastError; const changed = previousError !== message;
      target.lastRunAt = now; target.lastError = message; if (scheduledDate) target.lastScheduledDate = scheduledDate;
      let alert: AutopilotAlert | undefined;
      if (changed) {
        alert = { id: randomUUID(), shell, openedAt: now, severity: 'high', title: `Autopilot no pudo revisar ${shell}`, changes: [{ path: 'coverage.autopilot', label: 'cobertura / autopilot', before: previousError ? 'unavailable' : 'available', after: 'unavailable', direction: 'worse', severity: 'high' }] };
        state.alerts.unshift(alert); state.alerts = state.alerts.slice(0, 200);
      }
      return { status: changed ? 'alert_opened' : 'same_error', alert, error: message };
    });
  }
  async acknowledge(id: string) {
    return this.mutate(state => { const alert = state.alerts.find(item => item.id === id); if (!alert) throw new Error('La alerta no existe.'); alert.acknowledgedAt ??= new Date().toISOString(); return alert; });
  }
}

export function localDateTime(timeZone: string, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { date: `${value.year}-${value.month}-${value.day}`, hour: Number(value.hour), minute: Number(value.minute) };
}

export function snapshotDigest(value: unknown) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex'); }
