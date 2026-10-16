import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readUnifierJson, restBaseUrl } from "./unifier-response.js";
import { zipAttachments } from "./unifier-attachments.js";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const configuration = {
  baseUrl: restBaseUrl(process.env.UNIFIER_BASE_URL ?? ""),
  username: process.env.UNIFIER_USERNAME ?? "",
  password: process.env.UNIFIER_PASSWORD ?? "",
  accessToken: process.env.UNIFIER_AUTH_MODE === "credentials" ? "" : process.env.UNIFIER_ACCESS_TOKEN ?? "",
  tokenAuthScheme: (process.env.UNIFIER_TOKEN_AUTH_SCHEME ?? "Bearer").toLowerCase() === "basic" ? "Basic" : "Bearer",
  allowWrite: process.env.UNIFIER_ALLOW_WRITE === "true",
};

class UnifierClient {
  private token?: string;
  private tokenExpiresAt = 0;

  private assertConfigured() {
    if (!configuration.baseUrl || (!configuration.accessToken && (!configuration.username || !configuration.password))) {
      throw new Error("Faltan UNIFIER_BASE_URL y un UNIFIER_ACCESS_TOKEN o las credenciales Basic.");
    }
  }

  private async accessToken(force = false): Promise<string> {
    this.assertConfigured();
    if (configuration.accessToken) return configuration.accessToken;
    if (!force && this.token && Date.now() < this.tokenExpiresAt) return this.token;

    const basic = Buffer.from(`${configuration.username}:${configuration.password}`).toString("base64");
    const response = await fetch(`${configuration.baseUrl}/ws/rest/service/v2/auth/token`, {
      headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(30000),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("Unifier ha redirigido al proveedor de identidad en lugar de devolver un token. Verifica que el usuario sea un Integration User activo con autenticación Basic, o configura el flujo OAuth autorizado para esta instancia.");
    }
    const payload = await readUnifierJson(response);

    const data = payload as { data?: { access_token?: string; expires_in?: number }; access_token?: string };
    const token = data.data?.access_token ?? data.access_token;
    if (!token) throw new Error("La respuesta de autenticación no incluye access_token.");
    this.token = token;
    this.tokenExpiresAt = Date.now() + Math.max(60, (data.data?.expires_in ?? 3600) - 60) * 1000;
    return token;
  }

  async request(method: string, path: string, query?: Record<string, string>, body?: Json, readOnlyPost = false): Promise<{ status: number; data: Json }> {
    if (!path.startsWith("/ws/rest/service/v1/") && !path.startsWith("/ws/rest/service/v2/")) {
      throw new Error("La ruta debe comenzar por /ws/rest/service/v1/ o /ws/rest/service/v2/.");
    }
    if (path.includes("..") || path.includes("://")) throw new Error("Ruta REST no válida.");
    const normalizedMethod = method.toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(normalizedMethod)) throw new Error("Método HTTP no permitido.");
    if (!['GET', 'HEAD'].includes(normalizedMethod) && !(readOnlyPost && normalizedMethod === "POST") && !configuration.allowWrite) {
      throw new Error("Escrituras deshabilitadas. Configura UNIFIER_ALLOW_WRITE=true tras revisar el impacto.");
    }

    const url = new URL(`${configuration.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const execute = async (retry = false) => {
      const response = await fetch(url, {
        method: normalizedMethod,
        headers: { Authorization: `${configuration.accessToken ? configuration.tokenAuthScheme : "Bearer"} ${await this.accessToken(retry)}`, Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(30000),
      });
      if (response.status === 401 && !retry && !configuration.accessToken) return execute(true);
      return { status: response.status, data: await readUnifierJson(response) as Json };
    };
    return execute();
  }
}

function result(value: unknown) { return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] }; }
function failure(error: unknown) { return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true }; }

const client = new UnifierClient();
const server = new McpServer({ name: "primavera-unifier", version: "0.1.0" });

type RecordData = Record<string, unknown>;

function dataArray(response: { data: Json }, context: string): RecordData[] {
  const payload = response.data as { status?: unknown; data?: unknown };
  if (Number(payload.status) !== 200 || !Array.isArray(payload.data)) throw new Error(`${context} no devolvió una lista válida.`);
  return payload.data as RecordData[];
}

function dataObject(response: { data: Json }, context: string): RecordData {
  const payload = response.data as { status?: unknown; data?: unknown };
  if (Number(payload.status) !== 200 || !payload.data || Array.isArray(payload.data) || typeof payload.data !== "object") {
    throw new Error(`${context} no devolvió un objeto válido.`);
  }
  return payload.data as RecordData;
}

function countValues(values: Array<unknown>) {
  return Object.fromEntries(values.reduce<Map<string, number>>((counts, value) => {
    const key = String(value ?? "Sin especificar");
    counts.set(key, (counts.get(key) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()));
}

function compactRecord(record: RecordData) {
  return Object.fromEntries(Object.entries(record)
    .filter(([key, value]) => !key.startsWith("_") && (value === null || ["string", "number", "boolean"].includes(typeof value)))
    .slice(0, 24));
}

function bpSummary(records: RecordData[]) {
  const owners = records.flatMap(record => [record.creator_id, record.uuu_user_id, record.assigned_to, record.uuu_assignee]).filter(Boolean);
  const numericTotals = new Map<string, number>();
  for (const record of records) for (const [field, value] of Object.entries(record)) {
    if (typeof value === "number" && /(amount|budget|commit|cost|forecast|actual)/i.test(field)) {
      numericTotals.set(field, (numericTotals.get(field) ?? 0) + value);
    }
  }
  return {
    total: records.length,
    byStatus: countValues(records.map(record => record.status ?? record.record_status)),
    byResponsible: countValues(owners),
    numericTotals: Object.fromEntries(numericTotals),
    latest: records.slice(0, 10).map(compactRecord),
  };
}

function scheduleSummary(activities: RecordData[]) {
  const today = new Date();
  const overdue = activities.filter(activity => {
    const date = activity.end_date ?? activity.finish_date ?? activity.due_date ?? activity.planned_finish_date;
    const parsed = typeof date === "string" || typeof date === "number" ? new Date(date) : undefined;
    const status = String(activity.status ?? activity.activity_status ?? "").toLowerCase();
    return parsed && !Number.isNaN(parsed.valueOf()) && parsed < today && !/(complete|completed|done|closed)/.test(status);
  });
  return { total: activities.length, byStatus: countValues(activities.map(activity => activity.status ?? activity.activity_status)), overdueCount: overdue.length, overdue: overdue.slice(0, 20).map(compactRecord), sample: activities.slice(0, 20).map(compactRecord) };
}

async function validateShell(projectNumber: string) {
  const lookup = await client.request("GET", "/ws/rest/service/v1/admin/projectshell", {
    options: JSON.stringify({ filter_condition: `projectnumber=${projectNumber}` }),
  });
  const shell = dataArray(lookup, "La validación del shell").find(item => String(item.projectnumber) === projectNumber);
  if (!shell) throw new Error(`No existe un shell con project_number ${projectNumber}.`);
  return shell;
}

async function readBpRecords(projectNumber: string, bpname: string, options: Record<string, unknown> = {}) {
  const response = await client.request("POST", `/ws/rest/service/v1/bp/records/${encodeURIComponent(projectNumber)}`, undefined, { bpname, ...options }, true);
  return dataArray(response, `El BP ${bpname}`);
}

async function optionalRead<T>(label: string, operation: () => Promise<T>) {
  try { return { label, value: await operation() }; }
  catch (error) { return { label, error: error instanceof Error ? error.message : "No disponible" }; }
}

server.tool("unifier_connection_test", "Verifica acceso REST y una respuesta JSON válida del listado de shells.", {}, async () => {
  try {
    const response = await client.request("GET", "/ws/rest/service/v1/admin/projectshell", { options: JSON.stringify({ status: "Active" }) });
    const data = response.data as { status?: unknown; data?: unknown };
    if (Number(data.status) !== 200 || !Array.isArray(data.data)) throw new Error("El listado no devolvió status 200 y una lista JSON de proyectos; conexión no validada.");
    return result({ connected: true, status: response.status, count: data.data.length, message: "Lectura de shells verificada mediante JSON." });
  } catch (error) { return failure(error); }
});

server.tool("unifier_list_shells", "Lista proyectos/shells de Unifier mediante V1 admin/projectshell. Devuelve una página de items, total y summary; usa total para el recuento exacto y no enumeres más elementos de los incluidos en items.", {
  status: z.enum(["Active", "Inactive", "On-Hold", "View-Only"]).optional(),
  type: z.enum(["wbs_shell", "generic_shell"]).optional(),
  filter_condition: z.string().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).optional(),
}, async ({ status, type, filter_condition, limit = 20, offset = 0 }) => {
  try {
    const options = Object.fromEntries(Object.entries({ status, type, filter_condition }).filter(([, value]) => value !== undefined));
    const response = await client.request("GET", "/ws/rest/service/v1/admin/projectshell", Object.keys(options).length ? { options: JSON.stringify(options) } : undefined);
    const payload = response.data as { status?: unknown; data?: unknown };
    if (Number(payload.status) !== 200 || !Array.isArray(payload.data)) throw new Error("Unifier no devolvió una lista válida de proyectos/shells.");
    const all = payload.data as Record<string, unknown>[];
    const countBy = (field: string) => Object.fromEntries(all.reduce((counts, shell) => {
      const value = String(shell[field] ?? "Sin especificar");
      counts.set(value, (counts.get(value) ?? 0) + 1);
      return counts;
    }, new Map<string, number>()));
    const items = all.slice(offset, offset + limit);
    return result({
      status: response.status,
      total: all.length,
      count: all.length,
      offset,
      limit,
      returned: items.length,
      hasMore: offset + items.length < all.length,
      nextOffset: offset + items.length < all.length ? offset + items.length : null,
      summary: { byType: countBy("type"), byStatus: countBy("status") },
      items,
    });
  } catch (error) { return failure(error); }
});

server.tool("unifier_read_shell_360", "Workflow de lectura encadenada para una Ficha 360 de un shell. Primero valida el project_number mediante V1 admin/projectshell y después consulta V2 admin/shell para recuperar metadatos activos. No realiza escrituras ni expone campos sensibles.", {
  project_number: z.string().trim().min(1).max(100),
}, async ({ project_number }) => {
  try {
    const lookup = await client.request("GET", "/ws/rest/service/v1/admin/projectshell", {
      options: JSON.stringify({ filter_condition: `projectnumber=${project_number}` }),
    });
    const lookupPayload = lookup.data as { status?: unknown; data?: unknown };
    if (Number(lookupPayload.status) !== 200 || !Array.isArray(lookupPayload.data)) {
      throw new Error("La validación del shell no devolvió una lista válida.");
    }
    const shell = (lookupPayload.data as Record<string, unknown>[]).find(item => String(item.projectnumber) === project_number);
    if (!shell) throw new Error(`No existe un shell con project_number ${project_number}.`);

    const details = await client.request("GET", "/ws/rest/service/v2/admin/shell");
    const detailPayload = details.data as { status?: unknown; data?: unknown };
    if (Number(detailPayload.status) !== 200 || !Array.isArray(detailPayload.data)) {
      throw new Error("La consulta de metadatos V2 no devolvió una lista válida.");
    }
    const detail = (detailPayload.data as Record<string, unknown>[]).find(item => String(item.shell_number) === project_number);
    const properties = detail?.uuu_shell_addl_props as Record<string, unknown> | undefined;
    const currencies = Array.isArray(properties?.currency)
      ? (properties.currency as Record<string, unknown>[]).map(currency => ({
          code: currency.currencyCode,
          name: currency.currencyName,
          symbol: currency.currencySymbol,
          projectCurrency: currency.isProjectCurrency,
        }))
      : [];
    const cloud = Array.isArray(properties?.cloud) ? properties.cloud as Record<string, unknown>[] : [];
    const gateway = Array.isArray(properties?.gateway) ? properties.gateway as Record<string, unknown>[] : [];

    return result({
      workflow: "shell-360-read",
      readOnly: true,
      steps: [
        { step: 1, endpoint: "GET /ws/rest/service/v1/admin/projectshell", outcome: "shell validated", status: lookup.status },
        { step: 2, endpoint: "GET /ws/rest/service/v2/admin/shell", outcome: detail ? "active metadata found" : "no active V2 metadata for this shell", status: details.status },
      ],
      shell: {
        projectNumber: shell.projectnumber,
        projectName: shell.projectname,
        status: shell.status,
        type: shell.type,
        details: detail ? {
          model: detail.shell_model_name,
          phase: detail.shell_phase,
          location: detail.shell_location,
          shellType: detail.shell_type,
          currencies,
          integrations: {
            primaveraCloud: cloud.map(item => ({ type: item.integration_type, projectId: item.ext_project_id, projectName: item.ext_project_name })),
            primaveraGateway: gateway.map(item => ({ projectId: item.p6_project_id, projectName: item.p6_project_name, scheduleType: item.schedule_type })),
          },
        } : null,
      },
    });
  } catch (error) { return failure(error); }
});

server.tool("unifier_inspect_bp", "Inspector de BP de solo lectura: valida el shell y consulta un Business Process. Resume estados, responsables, importes detectados y los últimos registros.", {
  project_number: z.string().trim().min(1).max(100),
  bpname: z.string().trim().min(1).max(200),
  record_fields: z.string().optional(),
  filter_condition: z.string().optional(),
}, async ({ project_number, bpname, record_fields, filter_condition }) => {
  try {
    const shell = await validateShell(project_number);
    const records = await readBpRecords(project_number, bpname, { record_fields, filter_condition });
    return result({ workflow: "bp-inspector", readOnly: true, steps: ["validate shell", "read BP records", "summarize records"], shell: { projectNumber: shell.projectnumber, projectName: shell.projectname, status: shell.status }, bp: bpname, summary: bpSummary(records) });
  } catch (error) { return failure(error); }
});

server.tool("unifier_find_bp_record", "Buscador de un record_no en varios BPs y shells conocidos. Consulta cada objetivo indicado y devuelve únicamente las coincidencias; no realiza escrituras.", {
  record_no: z.string().trim().min(1).max(200),
  targets: z.array(z.object({ project_number: z.string().trim().min(1).max(100), bpname: z.string().trim().min(1).max(200) })).min(1).max(20),
}, async ({ record_no, targets }) => {
  try {
    const matches: Array<RecordData> = [];
    const checked: Array<RecordData> = [];
    for (const target of targets) {
      await validateShell(target.project_number);
      const records = await readBpRecords(target.project_number, target.bpname, { filter_condition: `record_no=${record_no}` });
      checked.push({ projectNumber: target.project_number, bp: target.bpname, found: records.length });
      for (const record of records) matches.push({ projectNumber: target.project_number, bp: target.bpname, record: compactRecord(record) });
    }
    return result({ workflow: "record-finder", readOnly: true, recordNo: record_no, checked, matches, matchCount: matches.length });
  } catch (error) { return failure(error); }
});

server.tool("unifier_project_health", "Salud de proyecto de solo lectura. Encadena la Ficha 360, el estado de Cost Sheet, paquetes de trabajo y los BPs de costes, compromisos, cambios o facturas que se indiquen.", {
  project_number: z.string().trim().min(1).max(100),
  bps: z.array(z.object({ label: z.enum(["costes", "compromisos", "cambios", "facturas", "otro"]), bpname: z.string().trim().min(1).max(200), record_fields: z.string().optional() })).max(8).optional(),
}, async ({ project_number, bps = [] }) => {
  try {
    const shell = await validateShell(project_number);
    const [lockStatus, workPackages, ...bpResponses] = await Promise.all([
      client.request("GET", "/ws/rest/service/v2/projectcostsheet/lockstatus", { project_number }),
      client.request("GET", "/ws/rest/service/v2/projectcostsheet/workpackage", { project_number }),
      ...bps.map(bp => readBpRecords(project_number, bp.bpname, { record_fields: bp.record_fields })),
    ]);
    const lock = dataArray(lockStatus, "El estado de Cost Sheet");
    const packages = dataArray(workPackages, "Los paquetes de trabajo");
    return result({
      workflow: "project-health", readOnly: true,
      steps: ["validate shell", "read cost sheet status", "read work packages", "read selected BP categories", "identify data-backed indicators"],
      shell: { projectNumber: shell.projectnumber, projectName: shell.projectname, status: shell.status },
      costSheet: { lockStatus: lock.map(compactRecord), workPackages: { total: packages.length, byStatus: countValues(packages.map(item => item.status)), sample: packages.slice(0, 10).map(compactRecord) } },
      bpIndicators: bps.map((bp, index) => ({ label: bp.label, bp: bp.bpname, ...bpSummary(bpResponses[index] as RecordData[]) })),
      alerts: [shell.status !== "Active" ? "El shell no está activo." : null, lock.some(item => String(item.locked).toLowerCase() === "true") ? "Cost Sheet bloqueada." : null].filter(Boolean),
    });
  } catch (error) { return failure(error); }
});

server.tool("unifier_project_autopilot_snapshot", "Snapshot determinista y de solo lectura para el Autopilot de proyecto. Reúne coste, planificación, BPs y aprobaciones en métricas estables, preparadas para comparar con la ejecución anterior sin descargar registros completos.", {
  project_number: z.string().trim().min(1).max(100),
  bps: z.array(z.object({ label: z.string().trim().min(1).max(100), bpname: z.string().trim().min(1).max(200), record_fields: z.string().optional() })).max(12).optional(),
  approval_bps: z.array(z.object({ label: z.string().trim().min(1).max(100), bpname: z.string().trim().min(1).max(200), record_fields: z.string().optional() })).max(12).optional(),
  source_project_id: z.string().trim().min(1).max(200).optional(),
}, async ({ project_number, bps = [], approval_bps = [], source_project_id }) => {
  try {
    const shell = await validateShell(project_number);
    let resolvedSourceProjectId = source_project_id;
    if (!resolvedSourceProjectId) {
      const integration = await optionalRead("shellIntegrations", async () => {
        const details = dataArray(await client.request("GET", "/ws/rest/service/v2/admin/shell"), "Los metadatos del shell");
        const detail = details.find(item => String(item.shell_number) === project_number);
        const props = detail?.uuu_shell_addl_props as Record<string, unknown> | undefined;
        const gateway = Array.isArray(props?.gateway) ? props.gateway as Record<string, unknown>[] : [];
        const cloud = Array.isArray(props?.cloud) ? props.cloud as Record<string, unknown>[] : [];
        return String(gateway.find(item => item.p6_project_id)?.p6_project_id ?? cloud.find(item => item.ext_project_id)?.ext_project_id ?? '') || undefined;
      });
      resolvedSourceProjectId = integration.value;
    }
    const uniqueBps = [...new Map([...bps, ...approval_bps].map(bp => [bp.bpname, bp])).values()];
    const [costLock, costSnapshots, workPackages, scheduleSheets, activities, ...bpReads] = await Promise.all([
      optionalRead("costLock", async () => dataArray(await client.request("GET", "/ws/rest/service/v2/projectcostsheet/lockstatus", { project_number }), "El bloqueo de Cost Sheet")),
      optionalRead("costSnapshots", async () => dataArray(await client.request("GET", "/ws/rest/service/v2/projectcostsheet/snapshot", { project_number }), "Los snapshots de Cost Sheet")),
      optionalRead("workPackages", async () => dataArray(await client.request("GET", "/ws/rest/service/v2/projectcostsheet/workpackage", { project_number }), "Los paquetes de trabajo")),
      optionalRead("scheduleSheets", async () => dataArray(await client.request("GET", `/ws/rest/service/v1/schedule/${encodeURIComponent(project_number)}`), "Las Schedule Sheets")),
      resolvedSourceProjectId
        ? optionalRead("activities", async () => dataArray(await client.request("GET", "/ws/rest/service/v2/activity/sheet/activities", { project_number, source_project_id: resolvedSourceProjectId! }), "Las actividades"))
        : Promise.resolve({ label: "activities", value: undefined, error: "source_project_id no configurado" }),
      ...uniqueBps.map(bp => optionalRead(`bp:${bp.bpname}`, () => readBpRecords(project_number, bp.bpname, { record_fields: bp.record_fields }))),
    ]);
    const bpByName = new Map(uniqueBps.map((bp, index) => [bp.bpname, bpReads[index]]));
    const costLockItems = costLock.value ?? [];
    const snapshotItems = costSnapshots.value ?? [];
    const packageItems = workPackages.value ?? [];
    const sheetItems = scheduleSheets.value ?? [];
    const activityItems = activities.value ?? [];
    const metrics = (bp: typeof bps[number]) => {
      const read = bpByName.get(bp.bpname); if (!read?.value) return { label: bp.label, bp: bp.bpname, unavailable: true };
      const summary = bpSummary(read.value);
      return { label: bp.label, bp: bp.bpname, total: summary.total, byStatus: summary.byStatus, numericTotals: summary.numericTotals };
    };
    const approvals = approval_bps.map(bp => {
      const read = bpByName.get(bp.bpname); if (!read?.value) return { label: bp.label, bp: bp.bpname, unavailable: true };
      const summary = bpSummary(read.value);
      const pending = Object.entries(summary.byStatus).filter(([status]) => /(pending|open|hold|late|review|approve|workflow)/i.test(status)).reduce((sum, [, count]) => sum + Number(count), 0);
      return { label: bp.label, bp: bp.bpname, total: summary.total, pending, byStatus: summary.byStatus, byResponsible: summary.byResponsible };
    });
    const coverageEntries = [costLock, costSnapshots, workPackages, scheduleSheets, activities, ...bpReads].map(read => [read.label, 'value' in read && read.value ? "available" : "unavailable"]);
    const scheduled = scheduleSummary(activityItems);
    return result({
      workflow: "project-autopilot-snapshot", readOnly: true,
      steps: ["validate shell", "collect cost evidence", "collect schedule evidence", "collect BP and approval metrics", "return stable comparison snapshot"],
      shell: { projectNumber: shell.projectnumber, projectName: shell.projectname, status: shell.status },
      cost: {
        locked: costLockItems.filter(item => String(item.locked).toLowerCase() === "true").length,
        snapshots: { total: snapshotItems.length, numericTotals: bpSummary(snapshotItems).numericTotals },
        workPackages: { total: packageItems.length, byStatus: countValues(packageItems.map(item => item.status)) },
      },
      schedule: {
        sheets: { total: sheetItems.length, locked: sheetItems.filter(item => String(item.sheet_lock).toLowerCase() === "true").length, byStatus: countValues(sheetItems.map(item => item.status)) },
        activities: resolvedSourceProjectId ? { sourceProjectId: resolvedSourceProjectId, total: scheduled.total, overdue: scheduled.overdueCount, byStatus: scheduled.byStatus } : { configured: false },
      },
      bps: bps.map(metrics), approvals, coverage: Object.fromEntries(coverageEntries),
    });
  } catch (error) { return failure(error); }
});

server.tool("unifier_risk_center", "Centro de Riesgos Agentic de solo lectura. Coordina shell, Cost Sheet, Schedule Sheets y BPs de riesgo seleccionados; devuelve evidencia, riesgos clasificados y borradores de acción sin ejecutar ningún cambio.", {
  project_number: z.string().trim().min(1).max(100),
  risk_bps: z.array(z.object({ label: z.enum(["aprobaciones", "costes", "compromisos", "cambios", "facturas", "otro"]), bpname: z.string().trim().min(1).max(200), record_fields: z.string().optional() })).max(8).optional(),
}, async ({ project_number, risk_bps = [] }) => {
  try {
    const shell = await validateShell(project_number);
    const [costLock, workPackages, scheduleSheets, ...bpReads] = await Promise.all([
      optionalRead("Cost Sheet lock", async () => dataArray(await client.request("GET", "/ws/rest/service/v2/projectcostsheet/lockstatus", { project_number }), "El estado de Cost Sheet")),
      optionalRead("Work packages", async () => dataArray(await client.request("GET", "/ws/rest/service/v2/projectcostsheet/workpackage", { project_number }), "Los paquetes de trabajo")),
      optionalRead("Schedule Sheets", async () => dataArray(await client.request("GET", `/ws/rest/service/v1/schedule/${encodeURIComponent(project_number)}`), "Las Schedule Sheets")),
      ...risk_bps.map(bp => optionalRead(`BP ${bp.bpname}`, () => readBpRecords(project_number, bp.bpname, { record_fields: bp.record_fields }))),
    ]);
    const costLockItems = costLock.value ?? [];
    const workPackageItems = workPackages.value ?? [];
    const scheduleSheetItems = scheduleSheets.value ?? [];
    const risks: Array<{ level: "high" | "medium" | "low"; title: string; evidence: string; actionDraft: string }> = [];
    if (String(shell.status) !== "Active") risks.push({ level: "high", title: "Shell no activo", evidence: `Estado actual: ${String(shell.status)}.`, actionDraft: "Validar el motivo del estado antes de planificar nuevas operaciones." });
    if (costLockItems.some(item => String(item.locked).toLowerCase() === "true")) risks.push({ level: "medium", title: "Cost Sheet bloqueada", evidence: "La consulta de bloqueo devuelve locked=true.", actionDraft: "Revisar el bloqueo, su propietario y el impacto antes de solicitar el desbloqueo." });
    if (workPackageItems.length) {
      const inactive = workPackageItems.filter(item => String(item.status).toLowerCase() !== "active");
      if (inactive.length) risks.push({ level: "medium", title: "Paquetes de trabajo no activos", evidence: `${inactive.length} de ${workPackageItems.length} paquetes no están activos.`, actionDraft: "Revisar responsables, comentarios y dependencias de los paquetes no activos." });
    }
    if (scheduleSheetItems.length) {
      const locked = scheduleSheetItems.filter(item => String(item.sheet_lock).toLowerCase() === "true");
      if (locked.length) risks.push({ level: "low", title: "Schedule Sheets bloqueadas", evidence: `${locked.length} hojas de planificación están bloqueadas.`, actionDraft: "Confirmar si el bloqueo impide actualizaciones necesarias de planificación." });
    }
    const bpEvidence = risk_bps.map((bp, index) => {
      const read = bpReads[index];
      if (!read?.value) return { label: bp.label, bp: bp.bpname, unavailable: read?.error ?? "No disponible" };
      const summary = bpSummary(read.value);
      const pending = Object.entries(summary.byStatus).filter(([status]) => /(pending|open|hold|late)/i.test(status)).reduce((sum, [, count]) => sum + Number(count), 0);
      if (pending) risks.push({ level: "medium", title: `Registros pendientes en ${bp.bpname}`, evidence: `${pending} registros con estado pendiente, abierto, en espera o tardío.`, actionDraft: "Revisar responsables y antigüedad; preparar una ruta de escalado sin modificar los registros." });
      return { label: bp.label, bp: bp.bpname, ...summary };
    });
    return result({
      workflow: "agentic-risk-center", readOnly: true,
      steps: ["validate shell", "collect independent evidence", "classify deterministic signals", "prepare action drafts"],
      shell: { projectNumber: shell.projectnumber, projectName: shell.projectname, status: shell.status },
      evidence: {
        costSheet: costLock.value ? costLockItems.map(compactRecord) : { unavailable: costLock.error },
        workPackages: workPackages.value ? { total: workPackageItems.length, byStatus: countValues(workPackageItems.map(item => item.status)) } : { unavailable: workPackages.error },
        scheduleSheets: scheduleSheets.value ? { total: scheduleSheetItems.length, byStatus: countValues(scheduleSheetItems.map(item => item.status)) } : { unavailable: scheduleSheets.error },
        bps: bpEvidence,
      },
      risks: risks.sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.level] - { high: 0, medium: 1, low: 2 }[b.level])),
      actionPolicy: "Borradores exclusivamente. Ninguna acción se ejecuta sin solicitud y confirmación explícitas.",
    });
  } catch (error) { return failure(error); }
});

server.tool("unifier_approval_control", "Control de aprobaciones de solo lectura. Valida un shell, consulta un BP filtrado por estado y agrupa los registros por responsable para detectar carga pendiente.", {
  project_number: z.string().trim().min(1).max(100),
  bpname: z.string().trim().min(1).max(200),
  status: z.string().trim().min(1).max(100).default("Pending"),
  record_fields: z.string().optional(),
}, async ({ project_number, bpname, status, record_fields }) => {
  try {
    const shell = await validateShell(project_number);
    const records = await readBpRecords(project_number, bpname, { filter_condition: `status=${status}`, record_fields });
    return result({ workflow: "approval-control", readOnly: true, steps: ["validate shell", `read ${status} BP records`, "group by responsible"], shell: { projectNumber: shell.projectnumber, projectName: shell.projectname }, bp: bpname, requestedStatus: status, summary: bpSummary(records) });
  } catch (error) { return failure(error); }
});

server.tool("unifier_cost_sheet_budget", "Cost Sheet / presupuesto de solo lectura. Valida el shell y encadena estado de bloqueo, snapshots, paquetes de trabajo y BPs financieros opcionales para comparar los importes que exponga la configuración del cliente.", {
  project_number: z.string().trim().min(1).max(100),
  financial_bps: z.array(z.object({ label: z.enum(["presupuesto", "comprometido", "coste_real", "prevision", "otro"]), bpname: z.string().trim().min(1).max(200), record_fields: z.string().optional() })).max(8).optional(),
}, async ({ project_number, financial_bps = [] }) => {
  try {
    const shell = await validateShell(project_number);
    const [lockStatus, snapshots, workPackages, ...bpResponses] = await Promise.all([
      client.request("GET", "/ws/rest/service/v2/projectcostsheet/lockstatus", { project_number }),
      client.request("GET", "/ws/rest/service/v2/projectcostsheet/snapshot", { project_number }),
      client.request("GET", "/ws/rest/service/v2/projectcostsheet/workpackage", { project_number }),
      ...financial_bps.map(bp => readBpRecords(project_number, bp.bpname, { record_fields: bp.record_fields })),
    ]);
    const lock = dataArray(lockStatus, "El estado de Cost Sheet");
    const snapshotItems = dataArray(snapshots, "Los snapshots de Cost Sheet");
    const packages = dataArray(workPackages, "Los paquetes de trabajo");
    return result({ workflow: "cost-sheet-budget", readOnly: true, steps: ["validate shell", "read Cost Sheet lock", "read snapshots", "read work packages", "aggregate configured financial BPs"], shell: { projectNumber: shell.projectnumber, projectName: shell.projectname }, costSheet: { locked: lock.map(compactRecord), snapshots: snapshotItems.slice(0, 20).map(compactRecord), workPackages: { total: packages.length, byStatus: countValues(packages.map(item => item.status)) } }, financialComparison: financial_bps.map((bp, index) => ({ label: bp.label, bp: bp.bpname, ...bpSummary(bpResponses[index] as RecordData[]) })) });
  } catch (error) { return failure(error); }
});

server.tool("unifier_schedule_health", "Planificación de solo lectura. Valida el shell, consulta las Schedule Sheets y, si se facilita source_project_id, encadena la lectura de actividades para destacar vencidas, próximas e hitos disponibles.", {
  project_number: z.string().trim().min(1).max(100),
  source_project_id: z.string().trim().min(1).max(200).optional(),
  sheet_filter: z.object({ status: z.string().optional(), main_sheet: z.enum(["true", "false"]).optional(), sheet_lock: z.enum(["true", "false"]).optional(), name: z.string().optional() }).optional(),
}, async ({ project_number, source_project_id, sheet_filter }) => {
  try {
    const shell = await validateShell(project_number);
    const sheetsResponse = await client.request("GET", `/ws/rest/service/v1/schedule/${encodeURIComponent(project_number)}`, sheet_filter ? { filter: JSON.stringify({ filter: sheet_filter }) } : undefined);
    const sheets = dataArray(sheetsResponse, "Las Schedule Sheets");
    let activities: RecordData[] = [];
    if (source_project_id) {
      const activityResponse = await client.request("GET", "/ws/rest/service/v2/activity/sheet/activities", { project_number, source_project_id });
      activities = dataArray(activityResponse, "Las actividades de planificación");
    }
    return result({ workflow: "schedule-health", readOnly: true, steps: source_project_id ? ["validate shell", "read schedule sheets", "read system activities", "flag overdue activities"] : ["validate shell", "read schedule sheets"], shell: { projectNumber: shell.projectnumber, projectName: shell.projectname }, scheduleSheets: { total: sheets.length, items: sheets.slice(0, 20).map(compactRecord) }, activities: source_project_id ? scheduleSummary(activities) : { message: "Facilita source_project_id para consultar actividades del System Activity Sheet." } });
  } catch (error) { return failure(error); }
});

server.tool("unifier_search_documents", "Document Manager de solo lectura. Valida el shell, consulta los metadatos de una ruta y lista documentos bajo esa carpeta; puede filtrar localmente por nombre, autor o fecha sin descargar archivos.", {
  project_number: z.string().trim().min(1).max(100),
  parent_path: z.string().trim().min(1).max(1000),
  search_text: z.string().trim().min(1).max(200).optional(),
  node_type: z.enum(["Folder", "Document"]).optional(),
}, async ({ project_number, parent_path, search_text, node_type }) => {
  try {
    const shell = await validateShell(project_number);
    const query = { projectnumber: project_number, parentpath: parent_path, ...(node_type ? { nodetype: node_type } : {}) };
    const [metadataResponse, documentResponse] = await Promise.all([
      client.request("GET", "/ws/rest/service/v1/dm/node/properties", query),
      client.request("GET", "/ws/rest/service/v1/dm/document", { projectnumber: project_number, parentpath: parent_path, iszip: "no" }),
    ]);
    const metadata = dataArray(metadataResponse, "Los metadatos de Document Manager");
    const documents = dataArray(documentResponse, "Los documentos de Document Manager");
    const needle = search_text?.toLowerCase();
    const matching = needle ? documents.filter(document => JSON.stringify(document).toLowerCase().includes(needle)) : documents;
    return result({ workflow: "document-manager-search", readOnly: true, steps: ["validate shell", "read node metadata", "list documents", ...(needle ? ["filter metadata locally"] : [])], shell: { projectNumber: shell.projectnumber, projectName: shell.projectname }, path: parent_path, metadata: metadata.slice(0, 20).map(compactRecord), documents: { total: documents.length, matching: matching.length, items: matching.slice(0, 20).map(compactRecord) } });
  } catch (error) { return failure(error); }
});

server.tool("unifier_audit_inactive_shells", "Auditor de shells inactivos de solo lectura. Lista los shells inactivos y, opcionalmente, encadena la consulta de un BP común para aportar evidencia antes de recomendar una revisión de archivado.", {
  bpname: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(20).optional(),
}, async ({ bpname, limit = 10 }) => {
  try {
    const response = await client.request("GET", "/ws/rest/service/v1/admin/projectshell", { options: JSON.stringify({ status: "Inactive" }) });
    const shells = dataArray(response, "El listado de shells inactivos");
    const sample = shells.slice(0, limit);
    const bpEvidence = bpname ? await Promise.all(sample.map(async shell => {
      const projectNumber = String(shell.projectnumber);
      try { return { projectNumber, bp: bpname, ...bpSummary(await readBpRecords(projectNumber, bpname)) }; }
      catch (error) { return { projectNumber, bp: bpname, unavailable: error instanceof Error ? error.message : "No disponible" }; }
    })) : [];
    return result({ workflow: "inactive-shell-auditor", readOnly: true, steps: bpname ? ["list inactive shells", "read common BP for sample shells", "recommend review"] : ["list inactive shells", "recommend review"], total: shells.length, shells: sample.map(shell => ({ projectNumber: shell.projectnumber, projectName: shell.projectname, type: shell.type, status: shell.status, recommendation: "Revisar actividad, documentos y retención antes de archivar." })), bpEvidence });
  } catch (error) { return failure(error); }
});

server.tool("unifier_compare_projects", "Comparador de proyectos de solo lectura. Consulta varios shells, valida cada uno y cruza sus metadatos activos V2 para devolver una tabla compacta comparable.", {
  project_numbers: z.array(z.string().trim().min(1).max(100)).min(2).max(10),
}, async ({ project_numbers }) => {
  try {
    const shells = await Promise.all(project_numbers.map(validateShell));
    const detailsResponse = await client.request("GET", "/ws/rest/service/v2/admin/shell");
    const details = dataArray(detailsResponse, "Los metadatos de shells activos");
    const rows = shells.map(shell => {
      const detail = details.find(item => String(item.shell_number) === String(shell.projectnumber));
      const properties = detail?.uuu_shell_addl_props as RecordData | undefined;
      const currencies = Array.isArray(properties?.currency) ? properties.currency as RecordData[] : [];
      const cloud = Array.isArray(properties?.cloud) ? properties.cloud as RecordData[] : [];
      return { projectNumber: shell.projectnumber, projectName: shell.projectname, status: shell.status, type: shell.type, phase: detail?.shell_phase ?? null, location: detail?.shell_location ?? null, model: detail?.shell_model_name ?? null, projectCurrencies: currencies.filter(currency => String(currency.isProjectCurrency).toLowerCase() === "yes").map(currency => currency.currencyCode), cloudIntegrations: cloud.length };
    });
    return result({ workflow: "project-comparator", readOnly: true, steps: ["validate requested shells", "read active V2 metadata once", "build comparison"], projects: rows });
  } catch (error) { return failure(error); }
});

server.tool("unifier_bp_permissions", "Permisos de BP de solo lectura. Valida el shell y consulta quién puede ver, editar o administrar los registros de un BP, con opción de limitar la consulta a uno o varios record_no.", {
  project_number: z.string().trim().min(1).max(100),
  bpname: z.string().trim().min(1).max(200),
  record_no: z.union([z.string().trim().min(1).max(200), z.array(z.string().trim().min(1).max(200)).min(1).max(50)]).optional(),
  status: z.enum(["Active", "Inactive"]).optional(),
}, async ({ project_number, bpname, record_no, status }) => {
  try {
    const shell = await validateShell(project_number);
    const permissionResponse = await client.request("POST", `/ws/rest/service/v1/bp/record/permission/list/${encodeURIComponent(project_number)}`, undefined, { bpname, ...(record_no ? { record_no } : {}), ...(status ? { filter_condition: `status=${status}` } : {}) }, true);
    const records = dataObject(permissionResponse, "Los permisos de BP");
    const summary = Object.entries(records).map(([recordNo, value]) => {
      const entry = value as RecordData;
      const permissions = Array.isArray(entry.permissions) ? entry.permissions as RecordData[] : [];
      return { recordNo, recordStatus: entry.record_status, principals: permissions.map(permission => ({ name: permission.full_name ?? permission.group_name ?? permission.login_name, type: permission.type, view: (permission.permission as RecordData | undefined)?.view, editData: (permission.permission as RecordData | undefined)?.edit_data, modifyPermission: (permission.permission as RecordData | undefined)?.modify_permission })) };
    });
    return result({ workflow: "bp-permissions", readOnly: true, steps: ["validate shell", "read BP record permissions", "summarize principals"], shell: { projectNumber: shell.projectnumber, projectName: shell.projectname }, bp: bpname, records: summary });
  } catch (error) { return failure(error); }
});

server.tool("unifier_list_bp_records", "Obtiene registros de un Business Process para un shell mediante el endpoint V1 bp/records.", {
  project_number: z.string().min(1),
  bpname: z.string().min(1),
  record_fields: z.string().optional(),
  lineitem: z.enum(["yes", "no"]).optional(),
  lineitem_fields: z.string().optional(),
  filter_condition: z.string().optional(),
}, async ({ project_number, bpname, ...options }) => {
  try { return result(await client.request("POST", `/ws/rest/service/v1/bp/records/${encodeURIComponent(project_number)}`, undefined, { bpname, ...options }, true)); }
  catch (error) { return failure(error); }
});

server.tool("unifier_create_contract_with_attachments", "Crea un único registro de BP Contract con documentos e informes de revisión adjuntos en la misma operación REST. Requiere confirmed=true y UNIFIER_ALLOW_WRITE=true. Los campos deben usar los nombres técnicos configurados en uDesigner; el estado depende de la configuración del BP.", {
  project_number: z.string().trim().min(1).max(100),
  bpname: z.string().trim().min(1).max(200),
  record_fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  attachments: z.array(z.object({ name: z.string().trim().min(1).max(240), base64: z.string().min(1).max(15_000_000), title: z.string().trim().min(1).max(300).optional() })).min(1).max(8),
  confirmed: z.literal(true),
}, async ({ project_number, bpname, record_fields, attachments }) => {
  try {
    const seen = new Set<string>();
    const decoded = attachments.map(attachment => {
      if (!/^[A-Za-z0-9+/=\s]+$/.test(attachment.base64)) throw new Error(`El adjunto ${attachment.name} no contiene Base64 válido.`);
      if (seen.has(attachment.name.toLowerCase())) throw new Error(`No se pueden adjuntar dos archivos con el mismo nombre: ${attachment.name}.`);
      seen.add(attachment.name.toLowerCase());
      return { name: attachment.name, title: attachment.title ?? attachment.name.replace(/\.[^.]+$/, ""), content: Buffer.from(attachment.base64, "base64") };
    });
    const totalBytes = decoded.reduce((total, attachment) => total + attachment.content.length, 0);
    if (totalBytes > 25 * 1024 * 1024) throw new Error("Los adjuntos superan el máximo conjunto de 25 MB.");
    const zip = zipAttachments(decoded);
    const payload = {
      options: { bpname },
      data: [{ ...record_fields, _attachment: decoded.map(attachment => ({ file_name: attachment.name, title: attachment.title, revision_no: "1" })) }],
      _attachment: { zipped_file_name: "contract-attachments.zip", zipped_file_size: String(zip.length), zipped_file_content: zip.toString("base64") },
    };
    const response = await client.request("POST", `/ws/rest/service/v1/bp/record/file/${encodeURIComponent(project_number)}`, undefined, payload);
    return result({ workflow: "create-contract-with-attachments", writeExecuted: true, projectNumber: project_number, bpname, attachedFiles: decoded.map(file => file.name), response: response.data });
  } catch (error) { return failure(error); }
});

server.tool("unifier_rest_request", "Ejecuta un endpoint REST V1/V2 documentado. GET/HEAD están permitidos; POST/PUT/PATCH/DELETE exigen UNIFIER_ALLOW_WRITE=true.", {
  method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]),
  path: z.string().min(1),
  query: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
}, async ({ method, path, query, body }) => {
  try { return result(await client.request(method, path, query, body as Json | undefined)); }
  catch (error) { return failure(error); }
});

await server.connect(new StdioServerTransport());
