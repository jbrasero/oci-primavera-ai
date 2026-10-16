import { createServer } from "node:http";
import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildContractPublication } from './contract-decision-report.js';
import { localDateTime, ProjectAutopilotStore } from './project-autopilot.js';

const port = Number(process.env.PORT ?? 3000);
const root = fileURLToPath(new URL("../public/", import.meta.url));
const autopilotStore = new ProjectAutopilotStore(
  process.env.PROJECT_AUTOPILOT_STATE_PATH ? resolve(process.env.PROJECT_AUTOPILOT_STATE_PATH) : fileURLToPath(new URL('../data/project-autopilot.json', import.meta.url)),
  Math.max(0, Number(process.env.PROJECT_AUTOPILOT_AMOUNT_DELTA ?? '1000') || 1000),
);
const autopilotSchedule = {
  enabled: process.env.PROJECT_AUTOPILOT_SCHEDULER !== 'false',
  hour: Math.min(23, Math.max(0, Number(process.env.PROJECT_AUTOPILOT_HOUR ?? '8') || 0)),
  minute: Math.min(59, Math.max(0, Number(process.env.PROJECT_AUTOPILOT_MINUTE ?? '0') || 0)),
  timeZone: process.env.PROJECT_AUTOPILOT_TIMEZONE?.trim() || 'Europe/Madrid',
};
const authDisabled = process.env.APP_AUTH_DISABLED === 'true';
const authUsername = process.env.APP_AUTH_USERNAME?.trim() ?? '';
const authPassword = process.env.APP_AUTH_PASSWORD ?? '';
const authSessionSeconds = Math.max(900, Math.round((Number(process.env.APP_AUTH_SESSION_HOURS ?? '8') || 8) * 60 * 60));
const authSecureCookie = process.env.APP_AUTH_SECURE_COOKIE === 'true';
if (!authDisabled && (!authUsername || !authPassword)) throw new Error('Configura APP_AUTH_USERNAME y APP_AUTH_PASSWORD para proteger la interfaz.');
const authSessions = new Map<string, number>();
const authAttempts = new Map<string, { count: number; resetAt: number }>();
const systemPrompt = `Eres el Supervisor Agentic de Primavera Unifier, un asistente conversacional en español para Oracle Primavera Unifier.
Usa las herramientas MCP para obtener datos reales cuando la pregunta lo requiera. Explica el resultado en lenguaje claro y menciona brevemente el endpoint o herramienta usada.
Estructura las respuestas con Markdown legible: títulos breves, listas cuando enumeres elementos, negritas para conceptos clave y código en línea para endpoints, campos o valores. Para resultados tabulares, usa tablas Markdown con encabezados.
Cuando una herramienta devuelva \`total\`, \`summary\` e \`items\`, usa \`total\` como recuento exacto. Si hay más de 20 resultados, resume las cifras y muestra como máximo los 20 de \`items\` en una tabla; indica cuántos se muestran y ofrece consultar la página siguiente. Nunca vuelques todos los registros ni una secuencia larga de campos separados por barras verticales, salvo que el usuario pida expresamente la exportación completa.
Cuando te pidan una ficha, detalle o visión 360 de un proyecto/shell y faciliten el \`project_number\`, usa \`unifier_read_shell_360\`. Explica brevemente los dos pasos de lectura encadenados y distingue entre datos de V1 y metadatos activos de V2.
Prefiere los workflows de alto nivel cuando encajen: \`unifier_inspect_bp\` para inspeccionar un BP, \`unifier_find_bp_record\` para buscar un record_no en destinos indicados, \`unifier_project_health\` para salud de proyecto, \`unifier_project_autopilot_snapshot\` para una lectura comparable del Autopilot, \`unifier_risk_center\` para investigar riesgos con evidencia, \`unifier_approval_control\` para pendientes, \`unifier_cost_sheet_budget\` para presupuesto, \`unifier_schedule_health\` para planificación, \`unifier_search_documents\` para Document Manager, \`unifier_audit_inactive_shells\` para inactivos, \`unifier_compare_projects\` para comparar y \`unifier_bp_permissions\` para permisos. Si el flujo necesita un BP técnico, una ruta de Document Manager o source_project_id y el usuario no lo aporta, pide solo ese dato antes de consultar.
Para una misión de salud o riesgos, coordina los agentes especializados necesarios y presenta una sección de evidencia, riesgos y siguientes pasos. Para una pregunta de "qué pasaría si", realiza únicamente análisis hipotético: no inventes cambios ni ejecutes escrituras. Para una acción, prepara un borrador con impacto, campos y endpoints; solicita confirmación explícita antes de proponer cualquier mutación.
No inventes datos. No realices escrituras (POST, PUT, PATCH o DELETE) salvo que el usuario lo pida de forma explícita y la configuración del servidor las permita. Si falta información, pide exactamente el dato necesario.`;

const contractIntakeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    documentType: { type: "string" },
    summary: { type: "string" },
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          value: { type: ["string", "number", "null"] },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          evidence: { type: "string" },
        },
        required: ["id", "label", "value", "confidence", "evidence"],
      },
    },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          description: { type: "string" },
          quantity: { type: ["string", "number", "null"] },
          unit: { type: ["string", "null"] },
          unitPrice: { type: ["string", "number", "null"] },
          amount: { type: ["string", "number", "null"] },
          evidence: { type: "string" },
        },
        required: ["description", "quantity", "unit", "unitPrice", "amount", "evidence"],
      },
    },
    validations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { severity: { type: "string", enum: ["blocker", "warning", "info"] }, message: { type: "string" }, fieldIds: { type: "array", items: { type: "string" } } },
        required: ["severity", "message", "fieldIds"],
      },
    },
    readiness: {
      type: "object",
      additionalProperties: false,
      properties: { score: { type: "number" }, blockingFields: { type: "array", items: { type: "string" } }, recommendation: { type: "string" } },
      required: ["score", "blockingFields", "recommendation"],
    },
  },
  required: ["documentType", "summary", "fields", "lineItems", "validations", "readiness"],
} as const;

type ContractIntakeFile = { name: string; type: string; data: string };

type ContractDestination = { bpname?: string; fieldMap: Record<string, string> };

function contractDestination(): ContractDestination {
  const bpname = process.env.CONTRACT_BP_NAME?.trim();
  const rawMap = process.env.CONTRACT_FIELD_MAP_JSON?.trim();
  if (!rawMap) return { bpname, fieldMap: {} };
  try {
    const parsed = JSON.parse(rawMap) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    const fieldMap = Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0));
    return { bpname, fieldMap };
  } catch { throw new Error("CONTRACT_FIELD_MAP_JSON debe ser un objeto JSON que mapee IDs extraídos a nombres técnicos de uDesigner."); }
}

function contractRecordFields(values: unknown, destination: ContractDestination) {
  if (!destination.bpname) throw new Error("Falta CONTRACT_BP_NAME con el nombre técnico del BP Contract.");
  if (!Object.keys(destination.fieldMap).length) throw new Error("Falta CONTRACT_FIELD_MAP_JSON con el mapeo de campos técnicos del BP Contract.");
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("Los campos revisados del contrato no son válidos.");
  const source = values as Record<string, unknown>;
  const recordFields: Record<string, string | number | boolean | null> = {};
  for (const [sourceId, technicalName] of Object.entries(destination.fieldMap)) {
    const value = source[sourceId];
    if (value === undefined || value === "") continue;
    if (value === null || ["string", "number", "boolean"].includes(typeof value)) recordFields[technicalName] = value as string | number | boolean | null;
  }
  if (!Object.keys(recordFields).length) throw new Error("Ningún campo revisado coincide con CONTRACT_FIELD_MAP_JSON.");
  return recordFields;
}

function parseModelJson(value: string) {
  const trimmed = value.trim();
  try { return JSON.parse(trimmed); }
  catch {
    const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i) ?? trimmed.match(/(\{[\s\S]*\})/);
    if (!match) throw new Error("El modelo no devolvió un borrador estructurado válido.");
    return JSON.parse(match[1].trim());
  }
}

async function analyzeContract(files: ContractIntakeFile[], shell?: string) {
  const connection = await getModelConnection();
  const content: any[] = [
    {
      type: "input_text",
      text: `Analiza el contrato principal y los anexos adjuntos para preparar un BORRADOR de un Business Process Contract de Primavera Unifier.${shell ? ` El shell de destino propuesto es ${shell}.` : ""}
Extrae únicamente datos soportados por los documentos. No inventes valores: usa null y confianza low cuando falte un dato. Prioriza estas claves: title, contractNumber, owner, ownerAddress, vendor, vendorAddress, effectiveDate, amount, currency, contractType, priority, dueDate, originalCompletionDate, revisedCompletionDate, paymentTerms, retainage, shortDescription, detailedDescription y specSection. Extrae también los conceptos económicos. Contrasta contrato y anexos: señala discrepancias, importes sin cuadrar, fechas ausentes y anexos referenciados pero no aportados. La respuesta es para revisión humana, no crea ni modifica registros de Unifier.`,
    },
    ...files.map(file => ({ type: "input_file", filename: file.name, file_data: `data:${file.type};base64,${file.data}`, detail: "high" })),
  ];
  const response: any = await connection.client.responses.create({
    model: connection.model,
    input: [{ role: "user", content }],
    text: { format: { type: "json_schema", name: "unifier_contract_intake", strict: true, schema: contractIntakeSchema } },
    store: false,
  } as any);
  return { intake: parseModelJson(response.output_text || ""), provider: connection.provider, model: connection.model };
}

async function commitContract(input: { shell: string; reviewedFields: unknown; files: ContractIntakeFile[]; unresolvedBlockers: unknown; confirmed: unknown; decisionHistory: unknown; resolutions: unknown }) {
  if (process.env.UNIFIER_ALLOW_WRITE !== "true") throw new Error("La escritura está desactivada. Configura UNIFIER_ALLOW_WRITE=true solo después de validar el flujo.");
  if (input.confirmed !== true) throw new Error("Confirma explícitamente la creación del borrador y sus adjuntos.");
  if (!Array.isArray(input.unresolvedBlockers) || input.unresolvedBlockers.length) throw new Error("No se puede guardar: aún hay bloqueos sin resolver o sin excepción documentada.");
  if (!input.shell?.trim()) throw new Error("Indica el shell de destino antes de guardar.");
  const destination = contractDestination();
  const recordFields = contractRecordFields(input.reviewedFields, destination);
  const publication = await buildContractPublication({ history: input.decisionHistory, shell: input.shell.trim(), bpname: destination.bpname!, reviewedFields: input.reviewedFields, recordFields, resolutions: input.resolutions, files: input.files });
  const client = await getMcp();
  const response: any = await client.callTool({ name: "unifier_create_contract_with_attachments", arguments: { project_number: input.shell.trim(), bpname: destination.bpname, record_fields: recordFields, attachments: publication.attachments, confirmed: true } });
  if (response.isError) throw new Error(response.content?.[0]?.text ?? "Unifier rechazó la creación del borrador.");
  const payload = JSON.parse(response.content?.[0]?.text ?? "{}");
  return { ...payload, decisionReport: { dossierId: publication.dossierId, files: publication.reportNames }, destination: { bpname: destination.bpname, mappedFieldCount: Object.keys(recordFields).length } };
}

let mcp: Client | undefined;
let tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = [];
const execFile = promisify(execFileCallback);

type ModelConnection = { client: OpenAI; model: string; provider: "OCI GenAI (API key)" | "OCI GenAI (IAM)" | "OpenAI" };

async function ociRegion(profile: string) {
  if (process.env.OCI_GENAI_REGION) return process.env.OCI_GENAI_REGION;
  try {
    const { stdout } = await execFile("oci", ["configure", "get", "region", "--profile", profile], { maxBuffer: 10_000 });
    if (stdout.trim()) return stdout.trim();
  } catch { /* The configuration error below explains the required value. */ }
  throw new Error("Falta OCI_GENAI_REGION y no se ha podido leer la región del perfil OCI.");
}

function ociIamFetch(profile: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    const requestHeaders = Object.fromEntries([...headers.entries()].filter(([name]) => !["content-length", "host"].includes(name.toLowerCase())));
    const method = init?.method ?? "GET";
    const rawBody = typeof init?.body === "string" ? init.body : undefined;
    const args = ["--profile", profile, "raw-request", "--target-uri", url, "--http-method", method, "--request-headers", JSON.stringify(requestHeaders)];
    if (rawBody) args.push("--request-body", rawBody);
    try {
      const { stdout } = await execFile("oci", args, { maxBuffer: 10 * 1024 * 1024 });
      const output = JSON.parse(stdout) as { data?: unknown; headers?: Record<string, string>; status?: string };
      const status = Number.parseInt(output.status?.split(" ")[0] ?? "500", 10);
      return new Response(JSON.stringify(output.data ?? null), { status: Number.isFinite(status) ? status : 500, headers: output.headers });
    } catch (error) {
      return new Response(JSON.stringify({ error: { message: error instanceof Error ? "OCI IAM request failed." : "OCI IAM request failed." } }), { status: 502, headers: { "content-type": "application/json" } });
    }
  }) as typeof fetch;
}

async function getModelConnection(): Promise<ModelConnection> {
  if (process.env.OCI_GENAI_API_KEY) {
    const region = await ociRegion(process.env.OCI_GENAI_PROFILE ?? "DEFAULT");
    const project = process.env.OCI_GENAI_PROJECT_OCID;
    const selectedModel = process.env.OCI_GENAI_MODEL;
    if (!region || !project || !selectedModel) throw new Error("Para OCI GenAI faltan OCI_GENAI_REGION, OCI_GENAI_PROJECT_OCID u OCI_GENAI_MODEL.");
    return {
      client: new OpenAI({ apiKey: process.env.OCI_GENAI_API_KEY, baseURL: process.env.OCI_GENAI_BASE_URL ?? `https://inference.generativeai.${region}.oci.oraclecloud.com/openai/v1`, project }),
      model: selectedModel,
      provider: "OCI GenAI (API key)",
    };
  }
  if (process.env.OCI_GENAI_PROJECT_OCID && process.env.OCI_GENAI_MODEL) {
    const profile = process.env.OCI_GENAI_PROFILE ?? "DEFAULT";
    const region = await ociRegion(profile);
    return {
      client: new OpenAI({ apiKey: "not-used", baseURL: process.env.OCI_GENAI_BASE_URL ?? `https://inference.generativeai.${region}.oci.oraclecloud.com/openai/v1`, project: process.env.OCI_GENAI_PROJECT_OCID, fetch: ociIamFetch(profile) }),
      model: process.env.OCI_GENAI_MODEL,
      provider: "OCI GenAI (IAM)",
    };
  }
  if (process.env.OPENAI_API_KEY) return { client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }), model: process.env.OPENAI_MODEL ?? "gpt-5", provider: "OpenAI" };
  throw new Error("Configura OCI GenAI (API key o IAM) u OPENAI_API_KEY.");
}

async function getMcp() {
  if (mcp) return mcp;
  const client = new Client({ name: "primavera-unifier-web", version: "0.1.0" });
  const serverPath = fileURLToPath(new URL("./index.js", import.meta.url));
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), stderr: "pipe" });
  await client.connect(transport);
  const response = await client.listTools();
  tools = response.tools.map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  mcp = client;
  return client;
}

const autopilotRuns = new Map<string, Promise<unknown>>();
async function runProjectAutopilot(shell: string, scheduledDate?: string) {
  if (autopilotRuns.has(shell)) return autopilotRuns.get(shell);
  const operation = (async () => {
    const state = await autopilotStore.read();
    const target = state.targets.find(item => item.shell === shell);
    if (!target) throw new Error(`Configura primero el Autopilot para ${shell}.`);
    try {
      const client = await getMcp();
      const response: any = await client.callTool({ name: 'unifier_project_autopilot_snapshot', arguments: {
        project_number: target.shell, bps: target.bps, approval_bps: target.approvalBps,
        ...(target.sourceProjectId ? { source_project_id: target.sourceProjectId } : {}),
      } });
      if (response.isError) throw new Error(response.content?.[0]?.text ?? 'No se pudo obtener el snapshot del proyecto.');
      const payload = JSON.parse(response.content?.[0]?.text ?? '{}');
      const local = localDateTime(autopilotSchedule.timeZone);
      const afterDailyTime = local.hour > autopilotSchedule.hour || (local.hour === autopilotSchedule.hour && local.minute >= autopilotSchedule.minute);
      const effectiveDate = scheduledDate ?? (afterDailyTime ? local.date : undefined);
      return await autopilotStore.recordSuccess(shell, payload, effectiveDate);
    } catch (error) {
      const local = localDateTime(autopilotSchedule.timeZone);
      const afterDailyTime = local.hour > autopilotSchedule.hour || (local.hour === autopilotSchedule.hour && local.minute >= autopilotSchedule.minute);
      const effectiveDate = scheduledDate ?? (afterDailyTime ? local.date : undefined);
      return await autopilotStore.recordFailure(shell, error instanceof Error ? error.message : 'Error desconocido', effectiveDate);
    }
  })().finally(() => autopilotRuns.delete(shell));
  autopilotRuns.set(shell, operation); return operation;
}

async function autopilotTick(now = new Date()) {
  const local = localDateTime(autopilotSchedule.timeZone, now);
  if (local.hour < autopilotSchedule.hour || (local.hour === autopilotSchedule.hour && local.minute < autopilotSchedule.minute)) return;
  const state = await autopilotStore.read();
  for (const target of state.targets.filter(item => item.enabled && item.lastScheduledDate !== local.date)) {
    await runProjectAutopilot(target.shell, local.date);
  }
}

if (autopilotSchedule.enabled) {
  setTimeout(() => void autopilotTick().catch(error => console.error('Autopilot:', error instanceof Error ? error.message : error)), 2_000).unref();
  setInterval(() => void autopilotTick().catch(error => console.error('Autopilot:', error instanceof Error ? error.message : error)), 60_000).unref();
}

const monitorIntervalMinutes = Number(process.env.AGENT_MONITOR_INTERVAL_MINUTES ?? "0");
let latestMonitor: { ranAt: string; inactiveShells?: number; error?: string } | undefined;

async function runPortfolioMonitor() {
  try {
    const client = await getMcp();
    const response = await client.callTool({ name: "unifier_audit_inactive_shells", arguments: { limit: 20 } });
    const monitorResponse = response as any;
    if (monitorResponse.isError) throw new Error(monitorResponse.content[0]?.text ?? "El auditor devolvió un error.");
    const payload = JSON.parse(monitorResponse.content[0]?.text ?? "{}") as { total?: number };
    latestMonitor = { ranAt: new Date().toISOString(), inactiveShells: payload.total ?? 0 };
  } catch (error) {
    latestMonitor = { ranAt: new Date().toISOString(), error: error instanceof Error ? error.message : "Error al ejecutar el monitor." };
  }
  return latestMonitor;
}

if (Number.isFinite(monitorIntervalMinutes) && monitorIntervalMinutes > 0) {
  void runPortfolioMonitor();
  setInterval(() => { void runPortfolioMonitor(); }, monitorIntervalMinutes * 60_000).unref();
}

type AgentActivity = {
  id: string;
  stage: "intent" | "model" | "orchestration" | "tool" | "synthesis" | "complete";
  title: string;
  detail: string;
  status: "running" | "done" | "error";
  tool?: string;
  durationMs?: number;
  at: string;
};

type ActivityEmitter = (event: AgentActivity) => void;

const agentNames: Record<string, string> = {
  unifier_read_shell_360: "Agente Ficha 360",
  unifier_list_shells: "Agente Inventario",
  unifier_audit_inactive_shells: "Agente Revisión de inactivos",
  unifier_inspect_bp: "Agente Inspector BP",
  unifier_find_bp_record: "Agente Buscador de registros",
  unifier_project_health: "Agente Salud de proyecto",
  unifier_risk_center: "Centro de Riesgos Agentic",
  unifier_approval_control: "Agente Aprobaciones",
  unifier_cost_sheet_budget: "Agente Cost Sheet",
  unifier_schedule_health: "Agente Planificación",
  unifier_search_documents: "Agente Document Manager",
  unifier_compare_projects: "Agente Comparador",
  unifier_bp_permissions: "Agente Permisos BP",
  unifier_project_autopilot_snapshot: "Autopilot de proyecto",
};

function activity(stage: AgentActivity["stage"], title: string, detail: string, status: AgentActivity["status"] = "running", extra: Partial<AgentActivity> = {}): AgentActivity {
  return { id: `${stage}-${Date.now()}-${randomBytes(3).toString("hex")}`, stage, title, detail, status, at: new Date().toISOString(), ...extra };
}

async function answer(message: string, previousResponseId?: string, emit: ActivityEmitter = () => {}) {
  emit(activity("intent", "Intención recibida", previousResponseId ? "Continúa la conversación y recupera su contexto." : "Analiza la petición y crea una nueva misión."));
  const setupStarted = Date.now();
  const client = await getMcp();
  const connection = await getModelConnection();
  emit(activity("intent", "Intención analizada", "Contexto conversacional y catálogo de herramientas preparados.", "done", { durationMs: Date.now() - setupStarted }));
  const openai = connection.client;
  const openAiTools: any[] = tools.map(tool => ({ type: "function" as const, name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false }));
  if (process.env.OCI_VECTOR_STORE_ID) openAiTools.push({ type: "file_search", vector_store_ids: [process.env.OCI_VECTOR_STORE_ID] });
  const firstModelStarted = Date.now();
  emit(activity("model", "Consulta a OCI GenAI", `El supervisor interpreta la intención con ${connection.model}.`));
  let response: any = await openai.responses.create({ model: connection.model, instructions: systemPrompt, input: message, tools: openAiTools, tool_choice: "auto", previous_response_id: previousResponseId, store: true });
  emit(activity("model", "Plan del supervisor recibido", "El modelo ha decidido si necesita agentes especializados.", "done", { durationMs: Date.now() - firstModelStarted }));
  const calls: string[] = [];
  const trace: Array<{ stage: string; detail: string }> = [{ stage: "Supervisor", detail: "Analiza la misión y decide qué especialistas necesita." }];
  let previousAgent = "Supervisor Agentic";

  for (let attempt = 0; attempt < 6; attempt++) {
    const functionCalls = response.output.filter((item: any) => item.type === "function_call");
    if (!functionCalls.length) break;
    emit(activity("orchestration", "Orquestación de especialistas", `${functionCalls.length} ${functionCalls.length === 1 ? "agente seleccionado" : "agentes seleccionados"} para este paso.`));
    const outputs = [];
    for (const call of functionCalls) {
      calls.push(call.name);
      trace.push({ stage: "MCP", detail: `Ejecuta ${call.name}.` });
      const toolStarted = Date.now();
      const currentAgent = agentNames[call.name] ?? "Agente MCP especializado";
      emit(activity("tool", currentAgent, `${previousAgent} entrega el contexto; consulta Unifier mediante MCP.`, "running", { tool: call.name }));
      let toolResult: unknown;
      try {
        toolResult = await client.callTool({ name: call.name, arguments: JSON.parse(call.arguments) });
        trace.push({ stage: "Resultado", detail: `Finaliza ${call.name}.` });
        emit(activity("tool", `${currentAgent} completado`, "Devuelve evidencia estructurada al supervisor para el siguiente paso.", "done", { tool: call.name, durationMs: Date.now() - toolStarted }));
      } catch (error) {
        toolResult = { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
        trace.push({ stage: "Resultado", detail: `No pudo completar ${call.name}.` });
        emit(activity("tool", `${currentAgent} no completado`, "El supervisor recibe un error controlado, sin exponer datos sensibles.", "error", { tool: call.name, durationMs: Date.now() - toolStarted }));
      }
      previousAgent = currentAgent;
      outputs.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(toolResult) });
    }
    emit(activity("orchestration", "Evidencia encadenada", `${previousAgent} devuelve su resultado al Supervisor Agentic.`, "done"));
    const modelStarted = Date.now();
    emit(activity("model", "OCI GenAI evalúa la evidencia", "Decide si debe invocar otro agente o redactar la respuesta."));
    response = await openai.responses.create({ model: connection.model, instructions: systemPrompt, input: outputs as any, tools: openAiTools, tool_choice: "auto", previous_response_id: response.id, store: true });
    emit(activity("model", "Decisión de orquestación recibida", "El supervisor continúa con el siguiente paso del flujo.", "done", { durationMs: Date.now() - modelStarted }));
  }
  emit(activity("synthesis", "Síntesis final", "Combina la evidencia, valida coherencia y redacta el resultado."));
  trace.push({ stage: "Supervisor", detail: "Sintetiza evidencia, riesgos y siguientes pasos." });
  const result = { answer: response.output_text || "No he podido generar una respuesta.", responseId: response.id, calls, trace, ragEnabled: Boolean(process.env.OCI_VECTOR_STORE_ID) };
  emit(activity("complete", "Resultado entregado", `Misión completada con ${calls.length} ${calls.length === 1 ? "operación MCP" : "operaciones MCP"}.`, "done"));
  return result;
}

function json(res: any, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

async function body(req: any, maxLength = 100_000) {
  let data = "";
  for await (const chunk of req) {
    data += chunk;
    if (data.length > maxLength) throw new Error("La solicitud supera el tamaño permitido.");
  }
  return JSON.parse(data || "{}");
}

function decodedBase64Bytes(value: string) {
  return Math.floor(value.replace(/\s/g, "").length * 3 / 4);
}

function contractFiles(input: unknown): ContractIntakeFile[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 6) throw new Error("Adjunta entre uno y seis documentos PDF.");
  const maxFileBytes = Number(process.env.CONTRACT_INTAKE_MAX_FILE_MB ?? "8") * 1024 * 1024;
  const files = input.map((item): ContractIntakeFile => {
    if (!item || typeof item !== "object") throw new Error("Uno de los adjuntos no es válido.");
    const file = item as Record<string, unknown>;
    if (typeof file.name !== "string" || !file.name.toLowerCase().endsWith(".pdf") || file.name.length > 240) throw new Error("Solo se admiten PDF con un nombre de archivo válido.");
    if (file.type !== "application/pdf" || typeof file.data !== "string" || !/^[A-Za-z0-9+/=\s]+$/.test(file.data)) throw new Error(`El archivo ${file.name} no es un PDF válido.`);
    if (decodedBase64Bytes(file.data) > maxFileBytes) throw new Error(`El archivo ${file.name} supera el máximo de ${Math.round(maxFileBytes / 1024 / 1024)} MB.`);
    return { name: file.name, type: file.type, data: file.data.replace(/\s/g, "") };
  });
  if (files.reduce((total, file) => total + decodedBase64Bytes(file.data), 0) > 25 * 1024 * 1024) throw new Error("Los adjuntos superan el máximo conjunto de 25 MB.");
  return files;
}

function safeCredentialEqual(received: string, expected: string) {
  const left = createHash('sha256').update(received).digest();
  const right = createHash('sha256').update(expected).digest();
  return timingSafeEqual(left, right);
}

function cookieValue(req: { headers: { cookie?: string } }, name: string) {
  for (const item of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = item.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

const directSessionCookie = 'unifier_session';
const embeddedSessionCookie = '__Host-unifier_embed_session';

function embeddedAuthRequest(req: { headers: Record<string, string | string[] | undefined> }) {
  const marker = req.headers['x-unifier-embed'];
  return (Array.isArray(marker) ? marker[0] : marker) === '1';
}

function authenticated(req: { headers: { cookie?: string } }) {
  if (authDisabled) return true;
  const tokens = [cookieValue(req, directSessionCookie), cookieValue(req, embeddedSessionCookie)].filter((token): token is string => Boolean(token));
  for (const token of tokens) {
    const expiresAt = authSessions.get(token);
    if (expiresAt && expiresAt > Date.now()) return true;
    authSessions.delete(token);
  }
  return false;
}

function sessionCookie(token: string, maxAge: number, embedded = false) {
  if (embedded) return `${embeddedSessionCookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAge}`;
  return `${directSessionCookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${authSecureCookie ? '; Secure' : ''}`;
}

function allowedOrigin(req: { headers: Record<string, string | string[] | undefined> }) {
  if (!req.headers.origin) return true;
  const forwarded = req.headers['x-forwarded-proto'];
  const protocol = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim() || 'http';
  return req.headers.origin === `${protocol}://${req.headers.host}`;
}

function allowLoginAttempt(address: string) {
  const now = Date.now(); const current = authAttempts.get(address);
  if (!current || current.resetAt <= now) { authAttempts.set(address, { count: 1, resetAt: now + 60_000 }); return true; }
  current.count += 1; return current.count <= 5;
}

const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  try {
    const route = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && route.pathname === '/api/auth/session') {
      return json(res, 200, { authenticated: authenticated(req), enabled: !authDisabled });
    }
    if (req.method === 'POST' && route.pathname === '/api/auth/login') {
      if (authDisabled) return json(res, 200, { authenticated: true });
      if (!allowedOrigin(req)) return json(res, 403, { error: 'Origen no permitido.' });
      const address = req.socket.remoteAddress ?? 'local';
      if (!allowLoginAttempt(address)) return json(res, 429, { error: 'Demasiados intentos. Espera un minuto antes de volver a probar.' });
      const input = await body(req, 10_000);
      const username = typeof input.username === 'string' ? input.username : '';
      const password = typeof input.password === 'string' ? input.password : '';
      if (!safeCredentialEqual(username, authUsername) || !safeCredentialEqual(password, authPassword)) return json(res, 401, { error: 'Usuario o contraseña incorrectos.' });
      authAttempts.delete(address);
      const token = randomBytes(32).toString('base64url');
      authSessions.set(token, Date.now() + authSessionSeconds * 1000);
      const embedded = embeddedAuthRequest(req);
      res.setHeader('Set-Cookie', sessionCookie(token, authSessionSeconds, embedded));
      return json(res, 200, { authenticated: true, username: authUsername, embedded });
    }
    if (req.method === 'POST' && route.pathname === '/api/auth/logout') {
      if (!allowedOrigin(req)) return json(res, 403, { error: 'Origen no permitido.' });
      const embedded = embeddedAuthRequest(req);
      const token = cookieValue(req, embedded ? embeddedSessionCookie : directSessionCookie);
      if (token) authSessions.delete(token);
      res.setHeader('Set-Cookie', sessionCookie('', 0, embedded));
      return json(res, 200, { authenticated: false });
    }
    if (route.pathname.startsWith('/api/') && !authenticated(req)) return json(res, 401, { error: 'Inicia sesión para continuar.' });
    if (route.pathname === '/api/decisions') {
      return json(res, 410, { error: 'El historial ya no se guarda localmente. Recarga la interfaz; se adjuntará al contrato al publicarlo.' });
    }
    if (req.method === "GET" && req.url === "/api/health") {
      try { const connection = await getModelConnection(); return json(res, 200, { configured: true, provider: connection.provider, model: connection.model }); }
      catch (error) { return json(res, 200, { configured: false, error: error instanceof Error ? error.message : "Configuración de modelo incompleta." }); }
    }
    if (req.method === "GET" && req.url === "/api/intake/config") {
      try {
        const destination = contractDestination();
        return json(res, 200, { writeEnabled: process.env.UNIFIER_ALLOW_WRITE === "true", bpConfigured: Boolean(destination.bpname), mappingConfigured: Object.keys(destination.fieldMap).length > 0, mappedFieldCount: Object.keys(destination.fieldMap).length });
      } catch (error) { return json(res, 200, { writeEnabled: process.env.UNIFIER_ALLOW_WRITE === "true", bpConfigured: false, mappingConfigured: false, mappedFieldCount: 0, error: error instanceof Error ? error.message : "Configuración Contract BP no válida." }); }
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      const input = await body(req);
      if (typeof input.message !== "string" || !input.message.trim()) return json(res, 400, { error: "Escribe una pregunta." });
      if (input.previousResponseId !== undefined && typeof input.previousResponseId !== "string") return json(res, 400, { error: "Identificador de conversación no válido." });
      return json(res, 200, await answer(input.message.trim(), input.previousResponseId));
    }
    if (req.method === "POST" && req.url === "/api/chat/stream") {
      const input = await body(req);
      if (typeof input.message !== "string" || !input.message.trim()) return json(res, 400, { error: "Escribe una pregunta." });
      if (input.previousResponseId !== undefined && typeof input.previousResponseId !== "string") return json(res, 400, { error: "Identificador de conversación no válido." });
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      });
      const writeEvent = (value: unknown) => { if (!res.writableEnded) res.write(`${JSON.stringify(value)}\n`); };
      try {
        const result = await answer(input.message.trim(), input.previousResponseId, event => writeEvent({ type: "activity", event }));
        writeEvent({ type: "result", data: result });
      } catch (error) {
        writeEvent({ type: "error", error: error instanceof Error ? error.message : "Error interno." });
      }
      return res.end();
    }
    if (req.method === "POST" && req.url === "/api/intake/contract") {
      const input = await body(req, 35_000_000);
      const files = contractFiles(input.files);
      if (input.shell !== undefined && (typeof input.shell !== "string" || input.shell.length > 100)) return json(res, 400, { error: "Shell no válido." });
      return json(res, 200, await analyzeContract(files, input.shell?.trim() || undefined));
    }
    if (req.method === "POST" && req.url === "/api/intake/contract/commit") {
      const input = await body(req, 40_000_000);
      const files = contractFiles(input.files);
      return json(res, 200, await commitContract({ shell: typeof input.shell === "string" ? input.shell : "", reviewedFields: input.reviewedFields, files, unresolvedBlockers: input.unresolvedBlockers, confirmed: input.confirmed, decisionHistory: input.decisionHistory, resolutions: input.resolutions }));
    }
    if (req.method === 'GET' && route.pathname === '/api/autopilot') {
      const state = await autopilotStore.read();
      const coverage = Object.fromEntries(state.targets.map(target => [target.shell, (state.snapshots[target.shell] as { coverage?: unknown } | undefined)?.coverage ?? null]));
      return json(res, 200, { schedule: autopilotSchedule, targets: state.targets, alerts: state.alerts, coverage });
    }
    const targetRoute = route.pathname.match(/^\/api\/autopilot\/targets\/([^/]+)(?:\/(run|pause))?$/);
    if (targetRoute && ['PUT', 'POST'].includes(req.method ?? '')) {
      if (!allowedOrigin(req)) return json(res, 403, { error: 'Origen no permitido.' });
      const shell = decodeURIComponent(targetRoute[1]);
      if (req.method === 'PUT' && !targetRoute[2]) {
        const input = await body(req, 100_000);
        return json(res, 200, await autopilotStore.configure({ shell, enabled: input.enabled !== false, bps: input.bps ?? [], approvalBps: input.approvalBps ?? [], sourceProjectId: input.sourceProjectId || undefined }));
      }
      if (req.method === 'POST' && targetRoute[2] === 'run') return json(res, 200, await runProjectAutopilot(shell));
      if (req.method === 'POST' && targetRoute[2] === 'pause') {
        const state = await autopilotStore.read(); const target = state.targets.find(item => item.shell === shell);
        if (!target) return json(res, 404, { error: 'El proyecto no está configurado.' });
        return json(res, 200, await autopilotStore.configure({ shell, enabled: false, bps: target.bps, approvalBps: target.approvalBps, sourceProjectId: target.sourceProjectId }));
      }
    }
    const alertRoute = route.pathname.match(/^\/api\/autopilot\/alerts\/([^/]+)\/ack$/);
    if (req.method === 'POST' && alertRoute) {
      if (!allowedOrigin(req)) return json(res, 403, { error: 'Origen no permitido.' });
      return json(res, 200, await autopilotStore.acknowledge(decodeURIComponent(alertRoute[1])));
    }
    if (req.method === "GET" && req.url === "/api/monitor") return json(res, 200, { enabled: monitorIntervalMinutes > 0, intervalMinutes: monitorIntervalMinutes || null, latest: latestMonitor });
    if (req.method === "POST" && req.url === "/api/monitor/run") return json(res, 200, await runPortfolioMonitor());
    if (req.method === "GET") {
      const requestPath = req.url === "/" ? "/index.html" : (req.url ?? "/").split("?")[0];
      const file = normalize(join(root, requestPath));
      if (!file.startsWith(root)) return json(res, 403, { error: "Ruta no permitida." });
      const content = await readFile(file);
      res.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream" });
      return res.end(content);
    }
    return json(res, 404, { error: "No encontrado." });
  } catch (error) {
    return json(res, 500, { error: error instanceof Error ? error.message : "Error interno." });
  }
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  console.error(`Unifier Chat disponible en http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`);
});
