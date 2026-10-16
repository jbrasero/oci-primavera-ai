import { createHash } from 'node:crypto';
import PDFDocument from 'pdfkit';
import { z } from 'zod';
import { historySchema } from './decision-history.js';

type SourceFile = { name: string; data: string };
type Fields = Record<string, string | number | boolean | null>;
const fieldsSchema = z.record(z.string().max(200), z.union([z.string().max(20000), z.number(), z.boolean(), z.null()]));
const resolutionsSchema = z.record(z.string(), z.object({
  type: z.enum(['confirmed', 'exception']), reason: z.string().trim().min(1).max(3000),
  actor: z.string().max(150).optional(), resolvedAt: z.string().datetime(),
}));
const labels: Record<string, string> = {
  extraction: 'Extracción documental', field_changed: 'Campo corregido', confirmed: 'Dato confirmado',
  exception: 'Excepción aceptada', evidence_added: 'Evidencia añadida', draft_prepared: 'Borrador preparado',
  publication_requested: 'Publicación solicitada', publication_response: 'Respuesta de Unifier', publication_uncertain: 'Publicación sin confirmar',
};

/** All output buffers are ephemeral: only Unifier receives persistent copies. */
export async function buildContractPublication(input: {
  history: unknown; shell: string; bpname: string; reviewedFields: unknown; recordFields: Fields;
  resolutions: unknown; files: SourceFile[];
}) {
  if (Buffer.byteLength(JSON.stringify(input.history) ?? '') > 2_000_000) throw new Error('El historial supera el límite de 2 MB. No se ha enviado a Unifier.');
  const parsed = historySchema.safeParse(input.history);
  if (!parsed.success) throw new Error('Falta un historial válido. Recarga la interfaz y analiza de nuevo antes de publicar.');
  const history = parsed.data;
  const ids = new Set<string>();
  for (const event of history.events) {
    if (event.dossierId !== history.dossierId || event.shell !== input.shell) throw new Error('El historial pertenece a otro expediente o shell. Reanaliza con el shell de destino activo.');
    if (ids.has(event.eventId)) throw new Error('El historial contiene eventos duplicados.');
    ids.add(event.eventId);
  }
  if (history.events.at(-1)?.kind !== 'publication_requested') throw new Error('Falta la solicitud de publicación en el historial.');
  const lastExtraction = history.events.filter(event => event.kind === 'extraction').at(-1);
  const documents = input.files.map(file => ({ name: file.name, sha256: createHash('sha256').update(Buffer.from(file.data, 'base64')).digest('hex') }));
  if (!lastExtraction || JSON.stringify([...documents].sort((a, b) => a.name.localeCompare(b.name))) !== JSON.stringify([...lastExtraction.documents].sort((a, b) => a.name.localeCompare(b.name)))) {
    throw new Error('Los documentos han cambiado desde el último análisis. Revalida antes de publicar.');
  }
  const reviewedFields = fieldsSchema.parse(input.reviewedFields);
  if (Object.keys(reviewedFields).length > 300) throw new Error('Demasiados campos revisados.');
  const report = {
    schemaVersion: 1,
    dossierId: history.dossierId,
    generatedAt: new Date().toISOString(),
    destination: { shell: input.shell, bpname: input.bpname },
    scope: 'Revisión previa al envío. No certifica la creación ni incluye la respuesta de esta publicación. No es el Audit Log nativo de Unifier.',
    attribution: 'Responsables y fechas de eventos declarados por la sesión del navegador; no autenticados ni certificados.',
    documents, reviewedFields, mappedFields: input.recordFields,
    resolutions: resolutionsSchema.parse(input.resolutions), events: history.events,
  };
  const json = Buffer.from(JSON.stringify(report, null, 2), 'utf8');
  if (json.length > 3_000_000) throw new Error('El informe supera el tamaño permitido. No se ha enviado a Unifier.');
  const pdf = await renderReport(report);
  const stem = `historial-decisiones-${history.dossierId}`;
  const reportNames = [`${stem}.pdf`, `${stem}.json`];
  const attachments = [...input.files.map(file => ({ name: file.name, base64: file.data })),
    { name: reportNames[0], base64: pdf.toString('base64') }, { name: reportNames[1], base64: json.toString('base64') }];
  if (new Set(attachments.map(file => file.name.toLowerCase())).size !== attachments.length) throw new Error('Un documento usa el mismo nombre que el informe de decisiones. Renómbralo y reanaliza.');
  if (attachments.reduce((total, file) => total + Buffer.from(file.base64, 'base64').length, 0) > 25 * 1024 * 1024) throw new Error('Los documentos y el historial superan el máximo conjunto de 25 MB. No se ha enviado a Unifier.');
  return { attachments, reportNames, dossierId: history.dossierId };
}

type Report = {
  dossierId: string; generatedAt: string; destination: { shell: string; bpname: string }; scope: string; attribution: string;
  documents: { name: string; sha256: string }[]; reviewedFields: Fields; mappedFields: Fields;
  resolutions: z.infer<typeof resolutionsSchema>; events: z.infer<typeof historySchema>['events'];
};

function renderReport(report: Report): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: 'Historial de decisiones del contrato', Author: 'Primavera Agentica' } });
    const chunks: Buffer[] = [];
    doc.on('data', chunk => chunks.push(chunk)); doc.on('error', reject); doc.on('end', () => resolve(Buffer.concat(chunks)));
    // Standard PDF fonts cover Spanish/Western text. JSON retains all Unicode verbatim.
    const text = (value: unknown) => String(value ?? 'Sin dato').replace(/[\u2010-\u2015]/g, '-').replace(/→/g, ' -> ').replace(/€/g, 'EUR').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[^\x20-\x7e\xa0-\xff\n\r\t]/g, '?');
    const section = (title: string) => {
      if (doc.y > 700) doc.addPage();
      doc.moveDown(0.7).font('Helvetica-Bold').fontSize(13).fillColor('#123b64').text(title).moveDown(0.5);
    };
    const paragraph = (value: unknown, muted = false) => {
      doc.font('Helvetica').fontSize(9).fillColor(muted ? '#536479' : '#233549').text(text(value), { lineGap: 3 }).moveDown(0.4);
    };
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#39705c').text('PRIMAVERA AGENTICA / REVISIÓN DOCUMENTAL');
    doc.moveDown().fontSize(23).fillColor('#123b64').text('Historial de decisiones');
    doc.moveDown(0.5);
    paragraph(`Shell: ${report.destination.shell}   |   BP: ${report.destination.bpname}`);
    paragraph(`Expediente: ${report.dossierId}\nGenerado: ${report.generatedAt}`, true);
    paragraph(report.scope, true); paragraph(report.attribution, true);
    paragraph('El JSON adjunto contiene el texto Unicode original completo. Este PDF utiliza tipografía occidental.', true);
    section('Documentos de origen');
    for (const file of report.documents) { paragraph(file.name); paragraph(`SHA-256: ${file.sha256}`, true); }
    section('Valores revisados al publicar');
    for (const [key, value] of Object.entries(report.reviewedFields)) paragraph(`${key}: ${value ?? 'Sin dato'}`);
    section('Campos técnicos enviados al BP');
    for (const [key, value] of Object.entries(report.mappedFields)) paragraph(`${key}: ${value ?? 'Sin dato'}`);
    section('Resolución de bloqueos');
    if (!Object.keys(report.resolutions).length) paragraph('Sin resoluciones de bloqueos registradas.');
    for (const [key, resolution] of Object.entries(report.resolutions)) paragraph(`${key} | ${resolution.type === 'exception' ? 'Excepción' : 'Confirmación'} | ${resolution.actor ?? 'Ver evento de decisión'}\n${resolution.reason}\n${resolution.resolvedAt}`);
    section(`Secuencia de decisiones (${report.events.length})`);
    for (const [index, event] of report.events.entries()) {
      if (doc.y > 660) doc.addPage();
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#123b64').text(text(`${index + 1}. ${labels[event.kind] || event.kind}`));
      paragraph(`${event.recordedAt} | ${event.actor}`, true);
      paragraph(event.subject); paragraph(`Motivo: ${event.reason}`);
      for (const change of event.changes) paragraph(`${change.field}: ${change.before ?? 'Sin dato'} -> ${change.after ?? 'Sin dato'}`);
      if (event.evidence) paragraph(`Evidencia: ${event.evidence}`, true);
      for (const file of event.documents) paragraph(`${file.name} | SHA-256: ${file.sha256}`, true);
      paragraph(`Evento: ${event.eventId}`, true);
    }
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(8).fillColor('#536479').text(`Revisión previa al envío | ${i + 1} / ${pages.count}`, 48, 811, { lineBreak: false });
    }
    doc.end();
  });
}
