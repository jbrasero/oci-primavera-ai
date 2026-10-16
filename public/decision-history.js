/* History is deliberately independent of model output rendering and chat resets. */
window.DecisionHistory = (() => {
  const labels = { extraction: 'Extracción documental', field_changed: 'Campo corregido', confirmed: 'Dato confirmado', exception: 'Excepción aceptada', evidence_added: 'Evidencia añadida', draft_prepared: 'Borrador preparado', publication_requested: 'Publicación solicitada', publication_response: 'Respuesta de Unifier', publication_uncertain: 'Publicación sin confirmar' };
  const panel = document.querySelector('#decision-history');
  const results = document.querySelector('#decision-events');
  const status = document.querySelector('#decision-save-status');
  let context = null;
  const events = [];
  const pendingDossiers = new Set();
  const publishedDossiers = new Set();
  const scalar = value => value === undefined ? null : value;
  const element = (tag, text, className) => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
  const actor = () => document.querySelector('#decision-reviewer').value.trim() || 'Usuario sin identificar';
  const reason = () => document.querySelector('#decision-reason').value.trim();
  const shell = () => document.querySelector('#mission-shell').value.trim();
  async function refresh() {
      const query = document.querySelector('#decision-search').value.toLocaleLowerCase();
      const matches = events.filter(event => event.shell === shell() && (!query || JSON.stringify(event).toLocaleLowerCase().includes(query)));
      const data = { events: matches.slice(-200).reverse(), total: matches.length };
      results.replaceChildren();
      document.querySelector('#decision-count').textContent = `${data.total} eventos · ${shell() || 'sin shell'}`;
      if (!data.events.length) results.append(element('p', 'Sin decisiones en esta sesión para este shell. Los historiales publicados están en los adjuntos del contrato en Unifier.', 'history-empty'));
      if (data.total > data.events.length) results.append(element('p', `Mostrando los últimos ${data.events.length} eventos. Usa la búsqueda para acotar.`, 'history-empty'));
      for (const event of data.events) {
        const card = element('article', '', 'history-event');
        card.append(element('strong', labels[event.kind] || event.kind));
        card.append(element('small', `${new Date(event.recordedAt).toLocaleString('es-ES')} · ${event.actor} · identidad declarada`));
        card.append(element('p', event.subject));
        if (event.reason) card.append(element('p', `Motivo: ${event.reason}`));
        for (const change of event.changes) card.append(element('p', `${change.field}: ${change.before ?? 'Sin dato'} → ${change.after ?? 'Sin dato'}`, 'history-change'));
        const detail = element('details', ''); detail.append(element('summary', 'Ver evidencia y expediente'));
        detail.append(element('p', event.evidence || 'Sin evidencia documental indicada.'));
        for (const doc of event.documents) detail.append(element('p', `${doc.name} · SHA-256 ${doc.sha256}`));
        detail.append(element('p', `Expediente ${event.dossierId} · Evento ${event.eventId}`));
        card.append(detail); results.append(card);
      }
  }
  function record(kind, subject, changes = [], evidence = '', explicitReason) {
    if (!context) return;
    events.push({ eventId: crypto.randomUUID(), recordedAt: new Date().toISOString(), ...structuredClone(context), kind, actor: actor(), reason: explicitReason ?? (reason() || 'Sin motivo indicado'), subject, evidence, changes: changes.map(change => ({ field: change.field, before: scalar(change.before), after: scalar(change.after) })) });
    pendingDossiers.add(context.dossierId);
    status.textContent = 'Historial pendiente de publicar. Se adjuntará al contrato como PDF y JSON; se pierde al cerrar o recargar esta pestaña.';
    if (panel.open) void refresh();
  }
  async function begin(destination, files, previous, result, model) {
    const documents = await Promise.all(files.map(async file => ({ name: file.name, sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('') })));
    context = { dossierId: previous && context?.shell === destination && !publishedDossiers.has(context.dossierId) ? context.dossierId : crypto.randomUUID(), shell: destination, documents };
    record('extraction', previous ? 'Revalidación: nuevas propuestas del modelo; decisiones anteriores conservadas en el historial.' : 'Primer análisis del contrato.',
      (result.fields || []).map(field => ({ field: field.id, before: previous?.fields?.find(old => old.id === field.id)?.value ?? null, after: field.value })),
      (result.fields || []).map(field => `${field.id}: ${field.evidence || 'Sin evidencia'}`).join('\n'), `Propuesta de IA · ${model}`);
  }
  panel.addEventListener('toggle', () => { if (panel.open) void refresh(); });
  document.querySelector('#decision-refresh').addEventListener('click', refresh);
  document.querySelector('#decision-search').addEventListener('input', refresh);
  document.querySelector('#mission-shell').addEventListener('change', () => { if (panel.open) void refresh(); });
  window.addEventListener('beforeunload', event => { if (pendingDossiers.size) { event.preventDefault(); event.returnValue = ''; } });
  return { begin, record, actor, reason, context: () => context ? structuredClone(context) : null,
    snapshot: () => context ? { dossierId: context.dossierId, events: structuredClone(events.filter(event => event.dossierId === context.dossierId)) } : null,
    published: () => { if (context) { pendingDossiers.delete(context.dossierId); publishedDossiers.add(context.dossierId); } status.textContent = 'Historial previo al envío adjuntado al contrato en Unifier (PDF + JSON). Consulta allí la copia persistente; las respuestas posteriores al envío solo se muestran en esta sesión.'; },
  };
})();
