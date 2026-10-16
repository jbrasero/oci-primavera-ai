// Synthetic QA only; never reads credentials or contacts Unifier.
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { buildContractPublication } from '../dist/contract-decision-report.js';

const dossierId = randomUUID();
const data = Buffer.from('Synthetic source for report QA').toString('base64');
const documents = [{ name: 'contrato-demo.pdf', sha256: createHash('sha256').update(Buffer.from(data, 'base64')).digest('hex') }];
const common = { dossierId, shell: 'P-DEMO', actor: 'Revisor de demostración', recordedAt: '2026-09-18T10:00:00.000Z', reason: 'Anexo 2, página 3: revisión humana.', evidence: 'Importe confirmado según el documento firmado.', documents };
const result = await buildContractPublication({ shell: 'P-DEMO', bpname: 'Contract', files: [{ name: documents[0].name, data }],
  reviewedFields: { amount: 1250000, vendor: 'Compañía de Ferrocarriles', title: 'Suministro de vehículos y repuestos' },
  recordFields: { uuu_title: 'Suministro de vehículos y repuestos', amount: 1250000 },
  resolutions: { 0: { type: 'exception', actor: common.actor, reason: 'Se documenta una excepción de prueba.', resolvedAt: common.recordedAt } },
  history: { dossierId, events: [
    { ...common, eventId: randomUUID(), kind: 'extraction', subject: 'Primera extracción de contrato y anexos.', changes: [{ field: 'amount', before: null, after: 1200000 }] },
    { ...common, eventId: randomUUID(), kind: 'field_changed', subject: 'Importe corregido por el revisor.', changes: [{ field: 'amount', before: 1200000, after: 1250000 }] },
    { ...common, eventId: randomUUID(), kind: 'exception', subject: 'Excepción de prueba.', changes: [], evidence: 'El anexo identifica una especificación técnica no aportada. '.repeat(50) },
    { ...common, eventId: randomUUID(), kind: 'publication_requested', subject: 'Publicar contrato e historial.', changes: [] },
  ] },
});
await mkdir('tmp/pdfs', { recursive: true });
await writeFile('tmp/pdfs/decision-report-qa.pdf', Buffer.from(result.attachments.at(-2).base64, 'base64'));
console.log('Synthetic report: tmp/pdfs/decision-report-qa.pdf');
