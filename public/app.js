const messages = document.querySelector('#messages');
const form = document.querySelector('#composer');
const question = document.querySelector('#question');
const send = document.querySelector('#send');
const clear = document.querySelector('#clear');
const status = document.querySelector('#status');
const activityToggle = document.querySelector('#activity-toggle');
const activityDrawer = document.querySelector('#activity-drawer');
const activityClose = document.querySelector('#activity-close');
const activityState = document.querySelector('#activity-state');
const activityEvents = document.querySelector('#activity-events');
const missionShell = document.querySelector('#mission-shell');
const missionMemory = document.querySelector('#mission-memory');
const missionFocusField = missionShell.closest('.mission-focus');
const missionShellFeedback = document.createElement('small');
missionShellFeedback.className = 'mission-shell-feedback';
missionShellFeedback.hidden = true;
missionShellFeedback.setAttribute('role', 'alert');
missionShellFeedback.textContent = 'Añade aquí el shell activo para usar este agente (por ejemplo, P-0001).';
missionShell.insertAdjacentElement('afterend', missionShellFeedback);
const contractIntake = document.querySelector('#contract-intake');
const intakeToggle = document.querySelector('#intake-toggle');
const intakeWorkspace = document.querySelector('#intake-workspace');
const contractFilesInput = document.querySelector('#contract-files');
const intakeAnalyze = document.querySelector('#intake-analyze');
const intakeFilesLabel = document.querySelector('#intake-files');
const intakeResult = document.querySelector('#intake-result');
let missionFocus = localStorage.getItem('unifierMissionFocus') || '';
let responseIds = {};
try { responseIds = JSON.parse(localStorage.getItem('unifierMissionResponseIds') || '{}'); } catch { responseIds = {}; }
let previousResponseId = responseIds[missionFocus || 'general'] || localStorage.getItem('unifierPreviousResponseId') || '';
let selectedAgentCard = null;
let agentProgressTimer = null;
let intakeFiles = [];
let intakeProgressTimer = null;
let latestIntake = null;
let intakeNeedsRevalidation = false;
let intakePublished = false;
let resolutionChoices = {};
let contractDestinationConfig = { writeEnabled: false, bpConfigured: false, mappingConfigured: false, mappedFieldCount: 0 };
const decisions = window.DecisionHistory;
const autopilotPanel = document.querySelector('#project-autopilot');
const autopilotBps = document.querySelector('#autopilot-bps');
const autopilotApprovals = document.querySelector('#autopilot-approvals');
const autopilotSourceProject = document.querySelector('#autopilot-source-project');
const autopilotEnable = document.querySelector('#autopilot-enable');
const autopilotRun = document.querySelector('#autopilot-run');
const autopilotPause = document.querySelector('#autopilot-pause');
const autopilotStatus = document.querySelector('#autopilot-status');
const autopilotGuide = document.querySelector('.autopilot-guide');
let autopilotState = { schedule: { enabled: true, hour: 8, minute: 0, timeZone: 'Europe/Madrid' }, targets: [], alerts: [], coverage: {} };
let autopilotRenderedShell = null;

function setActivityOpen(open) {
  activityToggle.checked = open;
  activityDrawer.classList.toggle('is-open', open);
  activityDrawer.setAttribute('aria-hidden', String(!open));
  localStorage.setItem('unifierShowAgentActivity', String(open));
}
setActivityOpen(localStorage.getItem('unifierShowAgentActivity') === 'true');
activityToggle.addEventListener('change', () => setActivityOpen(activityToggle.checked));
activityClose.addEventListener('click', () => setActivityOpen(false));

function activityStatus(statusName, label) {
  activityState.className = `activity-state is-${statusName}`;
  activityState.querySelector('span:last-child').textContent = label;
}

function resetActivity() {
  activityEvents.innerHTML = '';
  activityStatus('running', 'Misión en curso');
}

function addActivityEvent(event) {
  const running = [...activityEvents.querySelectorAll('li.is-running')].reverse().find(item => item.dataset.stage === event.stage && (!event.tool || item.dataset.tool === event.tool));
  const item = event.status !== 'running' && running ? running : document.createElement('li');
  item.className = `is-${event.status}`;
  item.dataset.stage = event.stage || '';
  item.dataset.tool = event.tool || '';
  const duration = Number.isFinite(event.durationMs) ? `<small>${event.durationMs < 1000 ? `${event.durationMs} ms` : `${(event.durationMs / 1000).toFixed(1)} s`}</small>` : '';
  const tool = event.tool ? `<code>${escapeHtml(event.tool)}</code>` : '';
  item.innerHTML = `<strong>${escapeHtml(event.title || 'Actividad')}</strong><span>${escapeHtml(event.detail || '')}</span>${tool}${duration}`;
  if (!item.parentNode) activityEvents.append(item);
  if (event.stage === 'complete') {
    activityEvents.querySelectorAll('li.is-running').forEach(entry => { entry.classList.remove('is-running'); entry.classList.add('is-done'); });
    activityStatus('complete', 'Misión completada');
  } else if (event.status === 'error') activityStatus('error', 'Incidencia controlada');
  else activityStatus('running', 'Misión en curso · recibiendo eventos');
  activityEvents.scrollTop = activityEvents.scrollHeight;
}

async function streamChat(message, previousResponseId) {
  const response = await fetch('/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, previousResponseId: previousResponseId || undefined }) });
  if (!response.ok) {
    let failure = {};
    try { failure = await response.json(); } catch { /* HTTP status below is enough. */ }
    throw new Error(failure.error || `No se ha podido completar la consulta (${response.status}).`);
  }
  if (!response.body) throw new Error('El navegador no permite recibir la actividad en tiempo real.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = ''; let result;
  const consume = line => {
    if (!line.trim()) return;
    const packet = JSON.parse(line);
    if (packet.type === 'activity') addActivityEvent(packet.event);
    else if (packet.type === 'result') result = packet.data;
    else if (packet.type === 'error') throw new Error(packet.error || 'La misión no se ha podido completar.');
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    const lines = buffer.split('\n'); buffer = lines.pop() || '';
    for (const line of lines) consume(line);
    if (done) break;
  }
  consume(buffer);
  if (!result) throw new Error('El flujo terminó sin devolver un resultado.');
  return result;
}

function memoryBucket() { return missionFocus || 'general'; }
function updateMissionMemory() { missionMemory.textContent = missionFocus ? `Memoria y contexto activos para ${missionFocus}` : 'Memoria de conversación general'; }
function setMissionFocus(value) {
  missionFocus = value.trim();
  localStorage.setItem('unifierMissionFocus', missionFocus);
  previousResponseId = responseIds[memoryBucket()] || '';
  updateMissionMemory();
}
missionShell.value = missionFocus; updateMissionMemory();

function clearShellRequest() {
  missionFocusField.classList.remove('needs-shell');
  missionShell.removeAttribute('aria-invalid');
  missionShellFeedback.hidden = true;
  updateMissionMemory();
}
function requireActiveShell() {
  const shell = missionShell.value.trim();
  if (shell) { clearShellRequest(); setMissionFocus(shell); return shell; }
  missionFocusField.classList.add('needs-shell');
  missionShell.setAttribute('aria-invalid', 'true');
  missionShellFeedback.hidden = false;
  missionMemory.textContent = 'Selecciona primero el proyecto: escribe su número en «Shell activo».';
  missionFocusField.scrollIntoView({ behavior: 'smooth', block: 'center' });
  missionShell.focus();
  return '';
}

function bpList(value) {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))].map(bpname => ({ label: bpname, bpname }));
}
function formatValue(value) {
  if (value === null || value === undefined) return 'sin dato';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
function currentAutopilotTarget() { const shell = selectedShell(); return autopilotState.targets.find(target => target.shell === shell); }
function autopilotCoverageLabel(name) {
  if (name.startsWith('bp:')) return `BP «${name.slice(3)}»`;
  return ({ shell: 'datos del proyecto', cost: 'costes', schedule: 'hojas de planificación', activities: 'actividades', workPackages: 'paquetes de trabajo', approvals: 'aprobaciones' })[name] || name;
}
function renderAutopilot() {
  const shell = selectedShell(); const target = currentAutopilotTarget();
  const alerts = autopilotState.alerts.filter(alert => !shell || alert.shell === shell);
  const open = alerts.filter(alert => !alert.acknowledgedAt);
  const badge = document.querySelector('#autopilot-badge');
  const summary = document.querySelector('#autopilot-summary');
  const count = document.querySelector('#autopilot-alert-count');
  badge.textContent = open.length ? `${open.length} alerta${open.length === 1 ? '' : 's'}` : target?.enabled ? 'Vigilando' : 'Inactivo';
  badge.className = `autopilot-badge ${open.length ? 'alert' : target?.enabled ? 'active' : ''}`;
  summary.textContent = target
    ? `${target.enabled ? 'Activo' : 'Pausado'} para ${target.shell} · diario ${String(autopilotState.schedule.hour).padStart(2, '0')}:${String(autopilotState.schedule.minute).padStart(2, '0')} ${autopilotState.schedule.timeZone}`
    : shell ? `Configura la vigilancia diaria de ${shell}` : 'Selecciona primero un shell activo';
  count.textContent = `${open.length} abierta${open.length === 1 ? '' : 's'}`;
  autopilotEnable.textContent = target ? 'Guardar configuración y ejecutar' : 'Activar y crear línea base';
  autopilotRun.disabled = !target?.enabled; autopilotPause.disabled = !target?.enabled;
  if (autopilotRenderedShell !== shell && document.activeElement !== autopilotBps && document.activeElement !== autopilotApprovals && document.activeElement !== autopilotSourceProject) {
    autopilotBps.value = target?.bps.map(bp => bp.bpname).join(', ') || '';
    autopilotApprovals.value = target?.approvalBps.map(bp => bp.bpname).join(', ') || '';
    autopilotSourceProject.value = target?.sourceProjectId || '';
    autopilotRenderedShell = shell;
  }
  const unavailable = Object.entries(autopilotState.coverage?.[shell] || {}).filter(([, value]) => value !== 'available').map(([name]) => autopilotCoverageLabel(name));
  if (target?.lastError) autopilotStatus.textContent = `Última revisión con error: ${target.lastError}`;
  else if (target?.lastRunAt && unavailable.length) autopilotStatus.textContent = `Última revisión: ${new Date(target.lastRunAt).toLocaleString('es-ES')}. Cobertura incompleta: ${unavailable.join(', ')}.`;
  else if (target?.lastRunAt) autopilotStatus.textContent = `Última revisión: ${new Date(target.lastRunAt).toLocaleString('es-ES')}.`;
  else autopilotStatus.textContent = target ? 'Activo. Pendiente de crear la línea base.' : 'Esperando configuración.';
  const list = document.querySelector('#autopilot-alert-list');
  const alertHtml = alert => `<article class="autopilot-alert ${escapeHtml(alert.severity)} ${alert.acknowledgedAt ? 'acknowledged' : ''}"><div class="autopilot-alert-head"><div><strong>${escapeHtml(alert.title)}</strong><small>${new Date(alert.openedAt).toLocaleString('es-ES')} · ${escapeHtml(alert.shell)}</small></div><button type="button" data-autopilot-ack="${escapeHtml(alert.id)}" ${alert.acknowledgedAt ? 'disabled' : ''}>${alert.acknowledgedAt ? 'Revisada' : 'Marcar revisada'}</button></div><ul>${alert.changes.slice(0, 12).map(change => `<li><span>${escapeHtml(change.label)}</span><span><strong>${escapeHtml(formatValue(change.before))}</strong> → <strong>${escapeHtml(formatValue(change.after))}</strong></span></li>`).join('')}</ul></article>`;
  const reviewed = alerts.filter(alert => alert.acknowledgedAt);
  list.innerHTML = `${open.length ? open.slice(0, 20).map(alertHtml).join('') : '<p class="autopilot-empty">Sin alertas abiertas. El proyecto continúa bajo vigilancia.</p>'}${reviewed.length ? `<details class="reviewed-alerts"><summary>Ver alertas revisadas (${reviewed.length})</summary>${reviewed.slice(0, 20).map(alertHtml).join('')}</details>` : ''}`;
  list.querySelectorAll('[data-autopilot-ack]').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try { await fetch(`/api/autopilot/alerts/${encodeURIComponent(button.dataset.autopilotAck)}/ack`, { method: 'POST' }).then(async response => { if (!response.ok) throw new Error((await response.json()).error); }); await refreshAutopilot(); }
    catch (error) { autopilotStatus.textContent = `No se pudo actualizar la alerta: ${error.message}`; button.disabled = false; }
  }));
}
async function refreshAutopilot() {
  try { const response = await fetch('/api/autopilot'); const data = await response.json(); if (!response.ok) throw new Error(data.error); autopilotState = data; renderAutopilot(); }
  catch (error) { autopilotStatus.textContent = `Autopilot no disponible: ${error.message || 'error desconocido'}`; }
}
async function configureAutopilot() {
  const shell = selectedShell(); if (!shell) { autopilotStatus.textContent = 'Indica el shell activo antes de activar el Autopilot.'; missionShell.focus(); return; }
  const controls = [autopilotEnable, autopilotRun, autopilotPause]; controls.forEach(button => { button.disabled = true; });
  autopilotStatus.textContent = `Configurando ${shell} y creando la línea base…`;
  try {
    const configResponse = await fetch(`/api/autopilot/targets/${encodeURIComponent(shell)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true, bps: bpList(autopilotBps.value), approvalBps: bpList(autopilotApprovals.value), sourceProjectId: autopilotSourceProject.value.trim() || undefined }) });
    const config = await configResponse.json(); if (!configResponse.ok) throw new Error(config.error || 'Configuración no válida.');
    const runResponse = await fetch(`/api/autopilot/targets/${encodeURIComponent(shell)}/run`, { method: 'POST' }); const run = await runResponse.json(); if (!runResponse.ok) throw new Error(run.error || 'No se pudo ejecutar.');
    const missing = Object.entries(run.snapshot?.coverage || {}).filter(([, value]) => value !== 'available').map(([name]) => autopilotCoverageLabel(name));
    autopilotStatus.textContent = run.status === 'baseline_created' ? `Línea base creada para ${shell}; no se ha abierto ninguna alerta.${missing.length ? ` Cobertura incompleta: ${missing.join(', ')}.` : ''}` : run.status === 'alert_opened' ? 'Se ha abierto una alerta por cambios relevantes.' : run.status === 'no_relevant_changes' ? 'Revisión completa: sin cambios relevantes.' : `Revisión finalizada: ${run.status}.`;
    await refreshAutopilot();
  } catch (error) { autopilotStatus.textContent = `No se pudo activar: ${error.message || 'error desconocido'}`; }
  finally { renderAutopilot(); }
}
autopilotEnable.addEventListener('click', configureAutopilot);
autopilotRun.addEventListener('click', async () => {
  const shell = selectedShell(); autopilotRun.disabled = true; autopilotStatus.textContent = `Revisando ${shell}…`;
  try { const response = await fetch(`/api/autopilot/targets/${encodeURIComponent(shell)}/run`, { method: 'POST' }); const data = await response.json(); if (!response.ok) throw new Error(data.error); autopilotStatus.textContent = data.status === 'alert_opened' ? 'Cambio relevante detectado: alerta abierta.' : data.status === 'baseline_created' ? 'Línea base creada sin alerta.' : 'Sin cambios relevantes.'; await refreshAutopilot(); }
  catch (error) { autopilotStatus.textContent = `La revisión falló: ${error.message}`; }
  finally { renderAutopilot(); }
});
autopilotPause.addEventListener('click', async () => {
  const shell = selectedShell(); autopilotPause.disabled = true;
  try { const response = await fetch(`/api/autopilot/targets/${encodeURIComponent(shell)}/pause`, { method: 'POST' }); const data = await response.json(); if (!response.ok) throw new Error(data.error); await refreshAutopilot(); autopilotStatus.textContent = `Autopilot pausado para ${shell}.`; }
  catch (error) { autopilotStatus.textContent = `No se pudo pausar: ${error.message}`; }
  finally { renderAutopilot(); }
});
autopilotPanel.addEventListener('toggle', () => { if (autopilotPanel.open) void refreshAutopilot(); });
autopilotGuide.addEventListener('toggle', () => { autopilotGuide.querySelector('.autopilot-guide-open').textContent = autopilotGuide.open ? '' : 'Ver ayuda'; });
void refreshAutopilot();

function setIntakeOpen(open) {
  contractIntake.classList.toggle('is-collapsed', !open);
  intakeWorkspace.hidden = !open;
  intakeToggle.setAttribute('aria-expanded', String(open));
  intakeToggle.innerHTML = open ? 'Cerrar agente <span>×</span>' : 'Abrir agente <span>↗</span>';
}
function openIntake() {
  setIntakeOpen(true);
  window.setTimeout(() => contractIntake.scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
}
setIntakeOpen(false);
intakeToggle.addEventListener('click', () => setIntakeOpen(intakeWorkspace.hidden));

function resetIntakeProgress() {
  if (intakeProgressTimer) window.clearInterval(intakeProgressTimer);
  intakeProgressTimer = null;
  contractIntake.querySelectorAll('.intake-flow span').forEach(step => step.classList.remove('is-active', 'is-done'));
}

function startIntakeProgress() {
  const steps = [...contractIntake.querySelectorAll('.intake-flow span')];
  resetIntakeProgress();
  let current = 0;
  const show = () => steps.forEach((step, index) => { step.classList.toggle('is-active', index === current); step.classList.toggle('is-done', index < current); });
  show();
  intakeProgressTimer = window.setInterval(() => { current = (current + 1) % steps.length; show(); }, 900);
  return completed => {
    if (intakeProgressTimer) window.clearInterval(intakeProgressTimer);
    intakeProgressTimer = null;
    steps.forEach(step => { step.classList.remove('is-active'); step.classList.toggle('is-done', completed); });
  };
}

function fileSize(bytes) { return `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 1 : 0)} MB`; }
function renderIntakeFiles() {
  intakeAnalyze.disabled = !intakeFiles.length;
  if (!intakeAnalyze.disabled) intakeAnalyze.innerHTML = `${latestIntake && intakeNeedsRevalidation ? 'Revalidar documentos' : 'Analizar documentos'} <span>↗</span>`;
  intakeFilesLabel.innerHTML = intakeFiles.length
    ? intakeFiles.map((file, index) => `<span class="intake-file">${index ? 'Anexo' : 'Contrato'} · ${escapeHtml(file.name)} <em>${fileSize(file.size)}</em></span>`).join('')
    : 'Aún no hay documentos seleccionados.';
}
function selectedShell() { return missionShell.value.trim(); }
async function refreshContractDestination() {
  try { contractDestinationConfig = await fetch('/api/intake/config').then(response => response.json()); }
  catch { contractDestinationConfig = { writeEnabled: false, bpConfigured: false, mappingConfigured: false, mappedFieldCount: 0, error: 'No se pudo leer la configuración de destino.' }; }
}
function confidence(value) { return ['high', 'medium', 'low'].includes(value) ? value : 'low'; }
function printable(value) { return value === null || value === undefined || value === '' ? 'Pendiente de validar' : String(value); }
function htmlValue(value) { return escapeHtml(value === null || value === undefined ? '' : String(value)); }
function validationFields(validation) { return Array.isArray(validation.fieldIds) ? validation.fieldIds.filter(Boolean) : []; }
function unresolvedBlockers() {
  return (Array.isArray(latestIntake?.validations) ? latestIntake.validations : [])
    .map((validation, index) => ({ validation, index }))
    .filter(({ validation, index }) => validation.severity === 'blocker' && !resolutionChoices[index]);
}
function resolutionLabel(choice) { return choice?.type === 'exception' ? 'Excepción documentada' : choice?.type === 'confirmed' ? 'Dato confirmado' : 'Pendiente'; }

function renderIntakeResult(result, provider, model) {
  latestIntake = result;
  const fields = Array.isArray(result.fields) ? result.fields : [];
  const warnings = Array.isArray(result.validations) ? result.validations : [];
  const lines = Array.isArray(result.lineItems) ? result.lineItems : [];
  const readiness = result.readiness || {};
  const score = Math.max(0, Math.min(100, Number(readiness.score) || 0));
  const state = readiness.blockingFields?.length ? 'blocked' : score < 75 ? 'low' : '';
  const resolutionCards = warnings.map((validation, index) => {
    const severity = validation.severity || 'info';
    if (severity !== 'blocker') return '';
    const choice = resolutionChoices[index];
    const fieldIds = validationFields(validation);
    return `<article class="resolution-card ${choice ? 'is-resolved' : ''}" data-resolution-card="${index}"><div class="resolution-card-head"><span class="resolution-number">${index + 1}</span><div><strong>${escapeHtml(validation.message || 'Bloqueo pendiente')}</strong><small>${fieldIds.length ? `Campos: ${fieldIds.map(escapeHtml).join(', ')}` : 'Aporta evidencia o registra una excepción.'}</small></div><span class="resolution-state ${choice?.type || ''}">${resolutionLabel(choice)}</span></div><div class="resolution-actions"><button type="button" data-resolution-action="review" data-resolution-index="${index}">Revisar campo</button><button type="button" data-resolution-action="confirm" data-resolution-index="${index}">Confirmar dato</button><button type="button" data-resolution-action="evidence" data-resolution-index="${index}">Añadir evidencia</button><button type="button" class="exception-action" data-resolution-action="exception" data-resolution-index="${index}">Excepción</button></div><div class="resolution-exception" data-resolution-exception="${index}" hidden><input type="text" maxlength="500" placeholder="Motivo de la excepción y responsable"><button type="button" data-resolution-action="save-exception" data-resolution-index="${index}">Documentar excepción</button></div></article>`;
  }).filter(Boolean).join('');
  const destinationReady = !intakePublished && contractDestinationConfig.writeEnabled && contractDestinationConfig.bpConfigured && contractDestinationConfig.mappingConfigured;
  const destinationMessage = intakePublished ? 'Este expediente ya se publicó. Consulta el registro y su historial en Unifier.' : destinationReady
    ? `Destino técnico configurado · ${contractDestinationConfig.mappedFieldCount} campos mapeados · ${intakeFiles.length} documentos + historial PDF y JSON`
    : contractDestinationConfig.error || 'Falta habilitar escritura, el BP técnico o CONTRACT_FIELD_MAP_JSON.';
  const commitGate = `<section class="intake-section commit-gate"><div class="commit-gate-head"><div><h5>Publicar contrato e historial</h5><p>${escapeHtml(destinationMessage)}</p></div><span class="commit-lock ${destinationReady ? 'ready' : ''}">${destinationReady ? 'Configurado' : 'Bloqueado'}</span></div><button id="open-unifier-commit" type="button" ${destinationReady ? '' : 'disabled'}>Revisar publicación en Unifier</button><div id="unifier-commit-confirmation" class="unifier-commit-confirmation" hidden><p>Se creará <strong>un único registro Contract BP</strong> en el shell <code>${escapeHtml(selectedShell() || 'sin seleccionar')}</code> con ${intakeFiles.length} PDF(s) originales y <strong>2 adjuntos de historial: PDF + JSON</strong>. El historial recoge las decisiones previas al envío, con responsable, motivo y evidencia. El estado del registro dependerá de la configuración del BP.</p><label><input id="unifier-commit-check" type="checkbox"> Confirmo el envío a Unifier de los datos, documentos e historial de revisión.</label><button id="commit-unifier-draft" type="button" disabled>Publicar contrato e historial</button></div></section>`;
  intakeResult.hidden = false;
  intakeResult.innerHTML = `<div class="intake-result-head"><div><h4>Borrador de ${escapeHtml(result.documentType || 'Contrato')} para revisión</h4><p>${escapeHtml(provider)} · ${escapeHtml(model)} · no se ha enviado ningún dato a Unifier</p></div><span class="readiness ${state}">${score}%</span></div>
    <section class="intake-section"><h5>Lectura del agente</h5><p class="intake-summary">${escapeHtml(result.summary || 'Sin resumen disponible.')}</p></section>
    <section class="intake-section"><h5>Campos extraídos · edítalos antes de preparar el alta</h5><div class="intake-fields">${fields.map((field, index) => { const level = confidence(field.confidence); const fieldId = field.id || `field_${index}`; return `<div class="intake-field" data-intake-field-card="${escapeHtml(fieldId)}"><label for="intake-field-${index}">${escapeHtml(field.label || fieldId)} <span class="confidence ${level}">${level}</span></label><input id="intake-field-${index}" data-intake-field="${escapeHtml(fieldId)}" value="${htmlValue(field.value)}" placeholder="Pendiente de validar"><small>${escapeHtml(field.evidence || 'Sin evidencia localizada')}</small></div>`; }).join('') || '<p class="intake-summary">No se extrajeron campos.</p>'}</div></section>
    ${lines.length ? `<section class="intake-section"><h5>Conceptos económicos</h5><table class="intake-line-items"><thead><tr><th>Descripción</th><th>Cant.</th><th>Unidad</th><th>Precio</th><th>Importe</th></tr></thead><tbody>${lines.map(line => `<tr><td title="${escapeHtml(line.evidence || '')}">${escapeHtml(printable(line.description))}</td><td>${escapeHtml(printable(line.quantity))}</td><td>${escapeHtml(printable(line.unit))}</td><td>${escapeHtml(printable(line.unitPrice))}</td><td>${escapeHtml(printable(line.amount))}</td></tr>`).join('')}</tbody></table></section>` : ''}
    <section class="intake-section"><h5>Validaciones</h5><ul class="intake-alerts">${warnings.map(item => `<li class="${escapeHtml(item.severity || 'info')}"><strong>${escapeHtml((item.severity || 'info').toUpperCase())}:</strong> ${escapeHtml(item.message || '')}</li>`).join('') || '<li>Sin incidencias detectadas por el agente.</li>'}</ul></section>
    ${resolutionCards ? `<section class="intake-section resolution-desk"><div class="resolution-title"><div><h5>Resolver bloqueos antes de guardar</h5><p>La IA propone; la decisión, evidencia y excepción quedan bajo control humano.</p></div><span>${unresolvedBlockers().length} pendientes</span></div>${resolutionCards}</section>` : ''}
    ${commitGate}
    <section class="intake-section intake-review-actions"><button id="prepare-unifier-draft" type="button">Preparar borrador para Unifier</button><button id="copy-intake-json" class="secondary" type="button">Copiar JSON revisado</button><span id="intake-review-status" class="intake-review-status">${escapeHtml(readiness.recommendation || 'Revisa los campos antes de continuar.')}</span></section>`;
  document.querySelector('#prepare-unifier-draft').addEventListener('click', () => {
    syncReviewedFields();
    const status = document.querySelector('#intake-review-status');
    const shell = selectedShell();
    const pending = unresolvedBlockers();
    if (pending.length) { status.textContent = `No se puede preparar el borrador: quedan ${pending.length} bloqueos sin resolver ni excepción documentada.`; return; }
    decisions.record('draft_prepared', `Borrador preparado para ${shell || 'shell sin seleccionar'}.`);
    status.textContent = `Borrador preparado${shell ? ` para ${shell}` : ''}. Sigue sin enviarse ni crear registros en Unifier.`;
  });
  document.querySelector('#copy-intake-json').addEventListener('click', async () => {
    const status = document.querySelector('#intake-review-status');
    const draft = reviewedIntakeDraft();
    try { await navigator.clipboard.writeText(JSON.stringify(draft, null, 2)); status.textContent = 'Borrador JSON revisado copiado. No se ha enviado a Unifier.'; }
    catch { status.textContent = 'No se pudo copiar automáticamente; el borrador permanece disponible en pantalla.'; }
  });
  document.querySelector('#open-unifier-commit').addEventListener('click', () => {
    syncReviewedFields();
    const pending = unresolvedBlockers();
    const status = document.querySelector('#intake-review-status');
    if (pending.length) { status.textContent = `Resuelve o documenta los ${pending.length} bloqueos antes de publicar.`; return; }
    if (!selectedShell()) { status.textContent = 'Indica el shell activo antes de publicar.'; return; }
    if (intakeNeedsRevalidation || decisions.context()?.shell !== selectedShell()) { status.textContent = 'Revalida los documentos con el shell de destino activo antes de publicar.'; return; }
    document.querySelector('#unifier-commit-confirmation').hidden = false;
  });
  document.querySelector('#unifier-commit-check').addEventListener('change', event => { document.querySelector('#commit-unifier-draft').disabled = !event.target.checked; });
  document.querySelector('#commit-unifier-draft').addEventListener('click', async () => {
    const status = document.querySelector('#intake-review-status');
    const button = document.querySelector('#commit-unifier-draft');
    const draft = reviewedIntakeDraft();
    if (intakePublished) { status.textContent = 'Este expediente ya se publicó. Consulta el contrato en Unifier.'; return; }
    if (draft.unresolvedBlockers.length) { status.textContent = 'No se puede publicar mientras queden bloqueos pendientes.'; return; }
    if (intakeNeedsRevalidation || decisions.context()?.shell !== selectedShell()) { status.textContent = 'Revalida los documentos con el shell de destino activo antes de publicar.'; return; }
    if (!document.querySelector('#unifier-commit-check').checked) return;
    const publicationShell = selectedShell();
    const publicationFiles = [...intakeFiles];
    const locked = [...contractIntake.querySelectorAll('input, button'), missionShell].map(control => ({ control, disabled: control.disabled }));
    locked.forEach(({ control }) => { control.disabled = true; });
    let published = false;
    button.disabled = true; button.textContent = 'Creando en Unifier…';
    try {
      decisions.record('publication_requested', `Solicitud de publicación al shell ${publicationShell} con documentos e historial PDF + JSON.`);
      const decisionHistory = decisions.snapshot();
      const files = await Promise.all(publicationFiles.map(async file => ({ name: file.name, type: file.type || 'application/pdf', data: await readFileBase64(file) })));
      const response = await fetch('/api/intake/contract/commit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shell: publicationShell, reviewedFields: draft.reviewedFields, unresolvedBlockers: draft.unresolvedBlockers, resolutions: draft.resolutions, decisionHistory, files, confirmed: true }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unifier rechazó la creación.');
      const serialized = JSON.stringify(data.response || data);
      const recordNo = serialized.match(/"record_no"\s*:\s*"([^"]+)"/)?.[1];
      decisions.record('publication_response', `Respuesta recibida de Unifier${recordNo ? ` · ${recordNo}` : ''}.`, [], '', 'Consultar el registro en Unifier para verificar su estado y adjuntos.');
      decisions.published(); published = true; intakePublished = true;
      status.textContent = `Unifier confirmó la creación${recordNo ? ` del registro ${recordNo}` : ''} con ${files.length} documento(s) y el historial PDF + JSON. Abre sus adjuntos en Unifier para consultar el historial. Revisa el estado y escaneo antivirus antes de enviarlo a aprobación.`;
      document.querySelector('#unifier-commit-confirmation').hidden = true;
    } catch (error) { decisions.record('publication_uncertain', 'La operación no pudo confirmarse.', [], '', 'Revisar Unifier antes de volver a intentar.'); status.textContent = `No se pudo confirmar la publicación: ${error.message || 'error desconocido'}. El historial sigue en esta pestaña. Revisa Unifier antes de reintentar para evitar duplicados.`; }
    finally {
      locked.forEach(({ control, disabled }) => { control.disabled = disabled; });
      button.disabled = published; button.textContent = published ? 'Publicado con historial' : 'Publicar contrato e historial';
      if (published) document.querySelector('#open-unifier-commit').disabled = true;
    }
  });
  intakeResult.querySelectorAll('[data-resolution-action]').forEach(button => button.addEventListener('click', () => {
    const index = Number(button.dataset.resolutionIndex);
    const validation = warnings[index];
    if (!validation) return;
    const fieldIds = validationFields(validation);
    const status = document.querySelector('#intake-review-status');
    if (button.dataset.resolutionAction === 'review') {
      intakeResult.querySelectorAll('.intake-field.is-target').forEach(field => field.classList.remove('is-target'));
      const targets = fieldIds.map(id => intakeResult.querySelector(`[data-intake-field-card="${CSS.escape(id)}"]`)).filter(Boolean);
      if (!targets.length) { status.textContent = 'No hay un campo directo para este bloqueo. Añade evidencia o documenta una excepción.'; return; }
      targets.forEach(target => target.classList.add('is-target'));
      targets[0].scrollIntoView({ behavior: 'smooth', block: 'center' }); targets[0].querySelector('input')?.focus();
      status.textContent = 'Revisa los campos resaltados y confirma el dato cuando esté validado.';
    }
    if (button.dataset.resolutionAction === 'confirm') {
      syncReviewedFields();
      if (!fieldIds.length) { status.textContent = 'Este bloqueo requiere evidencia o una excepción; no tiene campos asociados que confirmar.'; return; }
      if (decisions.actor() === 'Usuario sin identificar' || !decisions.reason()) { status.textContent = 'Indica responsable y motivo de revisión arriba antes de confirmar.'; return; }
      const unresolved = fieldIds.filter(id => !latestIntake.fields?.find(field => field.id === id && field.value !== null && String(field.value).trim()));
      if (unresolved.length) { status.textContent = `Falta un valor confirmado para: ${unresolved.join(', ')}.`; return; }
      decisions.record('confirmed', validation.message, fieldIds.map(id => ({ field: id, before: latestIntake.fields.find(field => field.id === id)?.value, after: latestIntake.fields.find(field => field.id === id)?.value })), fieldIds.map(id => latestIntake.fields.find(field => field.id === id)?.evidence || '').join('\n'));
      resolutionChoices[index] = { type: 'confirmed', resolvedAt: new Date().toISOString(), actor: decisions.actor(), reason: decisions.reason() }; renderIntakeResult(latestIntake, provider, model);
    }
    if (button.dataset.resolutionAction === 'evidence') {
      syncReviewedFields(); intakeNeedsRevalidation = true; contractFilesInput.click();
    }
    if (button.dataset.resolutionAction === 'exception') {
      const form = intakeResult.querySelector(`[data-resolution-exception="${index}"]`); form.hidden = !form.hidden;
    }
    if (button.dataset.resolutionAction === 'save-exception') {
      const form = intakeResult.querySelector(`[data-resolution-exception="${index}"]`);
      const reason = form.querySelector('input').value.trim();
      if (!reason) { form.querySelector('input').focus(); return; }
      if (decisions.actor() === 'Usuario sin identificar') { status.textContent = 'Indica el responsable de revisión antes de documentar la excepción.'; return; }
      decisions.record('exception', validation.message, [], fieldIds.map(id => latestIntake.fields.find(field => field.id === id)?.evidence || '').join('\n'), reason);
      syncReviewedFields(); resolutionChoices[index] = { type: 'exception', actor: decisions.actor(), reason, resolvedAt: new Date().toISOString() }; renderIntakeResult(latestIntake, provider, model);
    }
  }));
  intakeResult.querySelectorAll('[data-intake-field]').forEach(input => input.addEventListener('change', syncReviewedFields));
}

function syncReviewedFields() {
  if (!latestIntake || !Array.isArray(latestIntake.fields)) return;
  const edits = Object.fromEntries([...intakeResult.querySelectorAll('[data-intake-field]')].map(input => [input.dataset.intakeField, input.value.trim() || null]));
  latestIntake.fields = latestIntake.fields.map(field => {
    const next = Object.prototype.hasOwnProperty.call(edits, field.id) ? edits[field.id] : field.value;
    if (String(field.value ?? '') === String(next ?? '')) return field;
    decisions.record('field_changed', `Corrección de ${field.label || field.id}`, [{ field: field.id, before: field.value, after: next }], field.evidence || '');
    (latestIntake.validations || []).forEach((validation, index) => {
      if (validationFields(validation).includes(field.id)) {
        delete resolutionChoices[index];
        const badge = intakeResult.querySelector(`[data-resolution-card="${index}"] .resolution-state`);
        if (badge) { badge.textContent = 'Pendiente de reconfirmar'; badge.className = 'resolution-state'; }
      }
    });
    return { ...field, value: next };
  });
}

function reviewedIntakeDraft() {
  syncReviewedFields();
  const edits = Object.fromEntries([...intakeResult.querySelectorAll('[data-intake-field]')].map(input => [input.dataset.intakeField, input.value.trim() || null]));
  return { workflow: 'contract-document-intake', shell: selectedShell() || null, historyContext: decisions.context(), mode: 'draft_only', extracted: latestIntake, reviewedFields: edits, resolutions: resolutionChoices, unresolvedBlockers: unresolvedBlockers().map(({ index, validation }) => ({ index, message: validation.message, fieldIds: validationFields(validation) })), writesExecuted: false };
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onerror = () => reject(new Error(`No se pudo leer ${file.name}.`)); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(file); });
}

contractFilesInput.addEventListener('change', () => {
  const selected = [...contractFilesInput.files];
  if (!selected.length) return;
  setIntakeOpen(true);
  if (latestIntake) {
    decisions.record('evidence_added', `Archivos añadidos o reemplazados: ${selected.map(file => file.name).join(', ')}`, [], '', 'Los hashes actualizados se registrarán al revalidar.');
    const byName = new Map(intakeFiles.map(file => [file.name, file])); selected.forEach(file => byName.set(file.name, file)); intakeFiles = [...byName.values()];
    intakeNeedsRevalidation = true;
    const status = document.querySelector('#intake-review-status');
    if (status) status.textContent = 'Evidencia añadida. Pulsa «Revalidar documentos» para contrastarla con el borrador.';
  } else {
    intakeFiles = selected; resolutionChoices = {}; intakeNeedsRevalidation = false;
    intakeResult.hidden = true; intakeResult.innerHTML = ''; resetIntakeProgress();
  }
  contractFilesInput.value = ''; renderIntakeFiles();
});
intakeAnalyze.addEventListener('click', async () => {
  if (!intakeFiles.length) return;
  syncReviewedFields();
  const analysisShell = selectedShell();
  const analysisFiles = [...intakeFiles];
  const previousExtraction = latestIntake ? structuredClone(latestIntake) : null;
  const agentCard = document.querySelector('[data-intake-agent]');
  const finishCard = agentCard ? startAgentProgress(agentCard) : () => {};
  const finishIntake = startIntakeProgress();
  intakeAnalyze.disabled = true; intakeAnalyze.textContent = 'Analizando…';
  contractFilesInput.disabled = true;
  try {
    const files = await Promise.all(analysisFiles.map(async file => ({ name: file.name, type: file.type || 'application/pdf', data: await readFileBase64(file) })));
    const response = await fetch('/api/intake/contract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ files, shell: analysisShell || undefined }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || 'No se pudo analizar el contrato.');
    await decisions.begin(analysisShell, analysisFiles, previousExtraction, data.intake, data.model);
    intakeNeedsRevalidation = false; intakePublished = false; resolutionChoices = {}; finishIntake(true); finishCard(true); renderIntakeResult(data.intake, data.provider, data.model);
  } catch (error) {
    finishIntake(false); finishCard(false); intakeResult.hidden = false; intakeResult.innerHTML = `<div class="intake-result-head"><div><h4>No se pudo completar el análisis</h4><p>${escapeHtml(error.message || 'Error desconocido.')}</p></div></div>`;
  } finally { contractFilesInput.disabled = false; intakeAnalyze.textContent = 'Analizar documentos ↗'; renderIntakeFiles(); }
});

function resetAgentProgress() {
  if (agentProgressTimer) window.clearInterval(agentProgressTimer);
  agentProgressTimer = null;
  document.querySelectorAll('.agent-card').forEach(card => {
    card.classList.remove('is-prepared', 'is-running', 'is-complete', 'is-error');
    card.querySelectorAll('.agent-flow span').forEach(step => step.classList.remove('is-active', 'is-done'));
  });
}

function prepareAgent(card) {
  resetAgentProgress();
  selectedAgentCard = card;
  card.classList.add('is-prepared');
}

function startAgentProgress(card) {
  const steps = [...card.querySelectorAll('.agent-flow span')];
  if (!steps.length) return () => {};
  resetAgentProgress(); selectedAgentCard = card; card.classList.add('is-running');
  let current = 0;
  const showStep = () => steps.forEach((step, index) => {
    step.classList.toggle('is-active', index === current);
    step.classList.toggle('is-done', index < current);
  });
  showStep();
  agentProgressTimer = window.setInterval(() => { current = (current + 1) % steps.length; showStep(); }, 850);
  return (completed) => {
    if (agentProgressTimer) window.clearInterval(agentProgressTimer);
    agentProgressTimer = null;
    card.classList.remove('is-running');
    card.classList.toggle('is-complete', completed);
    card.classList.toggle('is-error', !completed);
    steps.forEach(step => { step.classList.remove('is-active'); step.classList.toggle('is-done', completed); });
  };
}

function escapeHtml(value) { const node = document.createElement('div'); node.textContent = value; return node.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

function renderInline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
}

function renderMarkdown(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const html = []; let paragraph = []; let list = []; let code = []; let inCode = false;
  const flushParagraph = () => { if (paragraph.length) { html.push(`<p>${renderInline(paragraph.join(' '))}</p>`); paragraph = []; } };
  const flushList = () => { if (list.length) { html.push(`<ul>${list.map(item => `<li>${renderInline(item)}</li>`).join('')}</ul>`); list = []; } };
  const flushCode = () => { if (code.length) { html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`); code = []; } };
  const isTableDivider = line => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  const tableCells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^```/.test(line)) { if (inCode) flushCode(); else { flushParagraph(); flushList(); } inCode = !inCode; continue; }
    if (inCode) { code.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      flushParagraph(); flushList();
      const headers = tableCells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) { rows.push(tableCells(lines[index])); index += 1; }
      index -= 1;
      html.push(`<div class="table-wrap"><table><thead><tr>${headers.map(cell => `<th>${renderInline(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${headers.map((_, cell) => `<td>${renderInline(row[cell] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { flushParagraph(); flushList(); html.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`); continue; }
    const item = line.match(/^\s*[-*+]\s+(.+)$/);
    if (item) { flushParagraph(); list.push(item[1]); continue; }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) { flushParagraph(); list.push(ordered[1]); continue; }
    paragraph.push(line.trim());
  }
  if (inCode) flushCode(); flushParagraph(); flushList();
  return html.join('');
}

function addMessage(role, text, calls = [], trace = []) {
  const article = document.createElement('article'); article.className = `message ${role}`;
  const label = role === 'user' ? 'Usuario' : 'Agente Unifier';
  const callsHtml = calls.length ? `<p class="tool">MCP: ${calls.map(escapeHtml).join(', ')}</p>` : '';
  const traceHtml = trace.length ? `<details class="agent-trace"><summary>Ver trazabilidad agentic (${trace.length} pasos)</summary><ol>${trace.map(item => `<li><strong>${escapeHtml(item.stage)}:</strong> ${escapeHtml(item.detail)}</li>`).join('')}</ol></details>` : '';
  const body = role === 'assistant' ? renderMarkdown(text) : `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
  article.innerHTML = `<div class="avatar">${role === 'user' ? 'TÚ' : 'U'}</div><div class="bubble"><p class="sender">${label}</p><div class="markdown">${body}</div>${traceHtml}${callsHtml}</div>`;
  messages.append(article); messages.scrollTop = messages.scrollHeight;
}
function reset() { messages.innerHTML = ''; messages.append(document.querySelector('#welcome').content.cloneNode(true)); previousResponseId = ''; delete responseIds[memoryBucket()]; localStorage.setItem('unifierMissionResponseIds', JSON.stringify(responseIds)); localStorage.removeItem('unifierPreviousResponseId'); selectedAgentCard = null; resetAgentProgress(); question.focus(); }
document.querySelector('#welcome').content && reset();

fetch('/api/health').then(r => r.json()).then(data => { status.textContent = data.configured ? `${data.provider} · ${data.model}` : data.error; status.classList.toggle('problem', !data.configured); }).catch(() => { status.textContent = 'Servidor no disponible'; status.classList.add('problem'); });
void refreshContractDestination();
clear.addEventListener('click', reset);
missionShell.addEventListener('change', () => { setMissionFocus(missionShell.value); clearShellRequest(); renderAutopilot(); });
missionShell.addEventListener('input', () => { clearShellRequest(); if (!missionShell.value.trim()) setMissionFocus(''); });
document.querySelectorAll('[data-mission]').forEach(button => button.addEventListener('click', () => {
  const shell = requireActiveShell();
  if (!shell) return;
  if (button.dataset.mission === 'autopilot') {
    autopilotPanel.open = true; autopilotPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); void refreshAutopilot(); return;
  }
  if (button.dataset.mission === 'intake') {
    openIntake();
    window.setTimeout(() => contractFilesInput.focus(), 250);
    return;
  }
  const missionTools = { health: 'unifier_project_health', risk: 'unifier_risk_center', scenario: 'unifier_project_health', draft: 'unifier_read_shell_360' };
  const missionCard = document.querySelector(`[data-tool="${missionTools[button.dataset.mission]}"]`);
  if (missionCard) prepareAgent(missionCard);
  const prompts = {
    health: `Ejecuta una misión de salud para el shell ${shell}. Reúne evidencia de Cost Sheet, paquetes de trabajo y BPs que estén disponibles; separa riesgos y próximos pasos.`,
    risk: `Investiga los riesgos del shell ${shell}. Coordina los agentes de salud, planificación, aprobaciones y documentos que correspondan; cita la evidencia disponible.`,
    scenario: `Qué pasaría si se retrasa un hito o se bloquea un paquete de trabajo en el shell ${shell}? Haz solo un análisis hipotético basado en los datos disponibles, sin realizar cambios.`,
    draft: `Prepara un borrador de acción para el shell ${shell}. Describe datos necesarios, impacto y endpoint, pero no ejecutes ninguna escritura hasta que yo confirme explícitamente.`,
  };
  question.value = prompts[button.dataset.mission]; question.dispatchEvent(new Event('input')); question.focus(); question.setSelectionRange(question.value.length, question.value.length);
}));
const additionalAgents = [
  { icon: 'AUTO', name: 'Autopilot de proyecto', description: 'Vigila cambios relevantes cada mañana y abre alertas.', tool: 'unifier_project_autopilot_snapshot', autopilot: true, flow: ['Lee', 'Compara', 'Decide', 'Alerta'] },
  { icon: 'AI', name: 'Agente Document Intake', description: 'Extrae y valida contratos antes de crear un borrador BP.', tool: 'contract_document_intake', intake: true, flow: ['PDFs', 'Extrae', 'Contrasta', 'Revisa'] },
  { icon: 'BP', name: 'Agente Inspector BP', description: 'Resume estado, importes y responsables de un BP.', tool: 'unifier_inspect_bp', prompt: 'Inspecciona el BP [nombre técnico] del shell ', flow: ['Shell', 'Consulta BP', 'Analiza', 'Resume'] },
  { icon: '#', name: 'Agente Buscador de registros', description: 'Busca un record_no en los destinos que indiques.', tool: 'unifier_find_bp_record', prompt: 'Busca el record_no [número] en el BP [nombre técnico] del shell ', flow: ['Record no.', 'Busca BP', 'Coincide', 'Ficha'] },
  { icon: '♥', name: 'Agente Salud de proyecto', description: 'Cruza shell, Cost Sheet y BPs financieros.', tool: 'unifier_project_health', prompt: 'Dame la salud del proyecto ', flow: ['Shell', 'Cost Sheet', 'BPs', 'Alertas'] },
  { icon: '!', name: 'Centro de Riesgos Agentic', description: 'Ejemplo: P-0001 con Vendors, Purchase Orders, Change Commit e Invoices. Sustituye shell y BPs por los de tu entorno.', tool: 'unifier_risk_center', prompt: 'Ejecuta el Centro de Riesgos Agentic para el shell [P-0001].\nAnaliza los BPs: [Vendors], [Purchase Orders], [Change Commit] e [Invoices].', flow: ['Evidencia', 'Clasifica', 'Riesgos', 'Borradores'] },
  { icon: '✓', name: 'Agente Aprobaciones', description: 'Agrupa pendientes por responsable.', tool: 'unifier_approval_control', prompt: 'Revisa aprobaciones pendientes del BP [nombre técnico] del shell ', flow: ['Shell', 'Pendientes', 'Agrupa', 'Informa'] },
  { icon: '€', name: 'Agente Cost Sheet', description: 'Revisa bloqueo, snapshots y paquetes.', tool: 'unifier_cost_sheet_budget', prompt: 'Analiza el Cost Sheet y presupuesto del proyecto ', flow: ['Shell', 'Cost Sheet', 'Compara', 'Balance'] },
  { icon: '⌁', name: 'Agente Planificación', description: 'Destaca actividades vencidas e hitos.', tool: 'unifier_schedule_health', prompt: 'Revisa la planificación del shell ', flow: ['Shell', 'Schedule', 'Fechas', 'Hitos'] },
  { icon: 'DM', name: 'Agente Document Manager', description: 'Busca metadatos sin descargar archivos.', tool: 'unifier_search_documents', prompt: 'Busca documentos en el shell [número] dentro de la ruta [carpeta] ', flow: ['Shell', 'Ruta DM', 'Filtra', 'Documentos'] },
  { icon: '↔', name: 'Agente Comparador', description: 'Compara varios proyectos de forma compacta.', tool: 'unifier_compare_projects', prompt: 'Compara los shells [P-0001] y [P-0002] ', flow: ['Shells', 'Valida', 'Cruza V2', 'Compara'] },
  { icon: '🔐', name: 'Agente Permisos BP', description: 'Muestra quién ve, edita o administra.', tool: 'unifier_bp_permissions', prompt: 'Revisa los permisos del BP [nombre técnico] en el shell ', flow: ['Shell', 'Permisos', 'Principales', 'Resumen'] },
];

const additionalAgentCards = document.createElement('div');
additionalAgentCards.className = 'agent-cards extra-agent-cards';
additionalAgentCards.innerHTML = additionalAgents.map(agent => `<button type="button" class="agent-card" data-tool="${agent.tool}" ${agent.intake ? 'data-intake-agent="true"' : agent.autopilot ? 'data-autopilot-agent="true"' : `data-prompt="${agent.prompt}"`}><span class="agent-card-head"><span class="agent-icon">${agent.icon}</span><span class="agent-copy"><strong>${agent.name}</strong><small>${agent.description}</small></span><span class="agent-status">${agent.intake ? 'Revisión' : agent.autopilot ? 'Programado' : 'Solo lectura'}</span></span><span class="agent-flow" aria-label="Pasos del agente">${agent.flow.map((step, index) => `${index ? '<i>→</i>' : ''}<span>${step}</span>`).join('')}</span><span class="agent-action">${agent.intake ? 'Abrir agente' : agent.autopilot ? 'Configurar' : 'Preparar pregunta'} <b>↗</b></span></button>`).join('');
document.querySelector('.agent-catalog').append(additionalAgentCards);

function prepareAgentPrompt(card) {
  const shellIndependentTools = new Set(['unifier_list_shells', 'unifier_audit_inactive_shells']);
  const requiresShell = !shellIndependentTools.has(card.dataset.tool);
  const activeShell = requiresShell ? requireActiveShell() : missionShell.value.trim();
  if (requiresShell && !activeShell) return;
  prepareAgent(card);
  let prompt = card.dataset.prompt || '';
  if (activeShell) {
    const replaced = prompt.replaceAll('[P-0001]', activeShell).replaceAll('[número de shell]', activeShell).replaceAll('[número]', activeShell);
    prompt = replaced === prompt && /\s$/.test(prompt) ? `${prompt}${activeShell}` : replaced;
  }
  question.value = prompt;
  question.dispatchEvent(new Event('input'));
  question.focus();
  question.setSelectionRange(question.value.length, question.value.length);
}

document.querySelectorAll('[data-prompt]').forEach(card => card.addEventListener('click', () => prepareAgentPrompt(card)));
document.querySelectorAll('[data-intake-agent]').forEach(card => card.addEventListener('click', () => {
  if (!requireActiveShell()) return;
  prepareAgent(card); openIntake(); window.setTimeout(() => contractFilesInput.focus(), 250);
}));
document.querySelectorAll('[data-autopilot-agent]').forEach(card => card.addEventListener('click', () => {
  if (!requireActiveShell()) return;
  prepareAgent(card); autopilotPanel.open = true; autopilotPanel.scrollIntoView({ behavior: 'smooth', block: 'start' }); void refreshAutopilot();
}));
question.addEventListener('input', () => { question.style.height = 'auto'; question.style.height = `${Math.min(question.scrollHeight, 160)}px`; });
question.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
form.addEventListener('submit', async event => {
  event.preventDefault(); const text = question.value.trim(); if (!text) return;
  const progressCard = selectedAgentCard; const finishProgress = progressCard ? startAgentProgress(progressCard) : () => {};
  resetActivity(); addMessage('user', text); question.value = ''; question.style.height = 'auto'; send.disabled = true; send.textContent = 'Consultando…';
  try { const data = await streamChat(text, previousResponseId); previousResponseId = data.responseId; responseIds[memoryBucket()] = previousResponseId; localStorage.setItem('unifierMissionResponseIds', JSON.stringify(responseIds)); localStorage.setItem('unifierPreviousResponseId', previousResponseId); finishProgress(data.calls?.includes(progressCard?.dataset.tool)); addMessage('assistant', data.answer, data.calls, data.trace); }
  catch (error) { activityStatus('error', 'La misión terminó con un error'); activityEvents.querySelectorAll('li.is-running').forEach(entry => { entry.classList.remove('is-running'); entry.classList.add('is-error'); }); finishProgress(false); addMessage('assistant', `No he podido completar la consulta: ${error.message}`); }
  finally { send.disabled = false; send.innerHTML = 'Enviar <span>↗</span>'; question.focus(); }
});
