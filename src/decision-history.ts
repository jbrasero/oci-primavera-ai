import { z } from 'zod';

const value = z.union([z.string().max(20000), z.number(), z.boolean(), z.null()]);
export const decisionSchema = z.object({
  eventId: z.string().uuid(), dossierId: z.string().uuid(), shell: z.string().max(100),
  recordedAt: z.string().datetime(),
  kind: z.enum(['extraction', 'field_changed', 'confirmed', 'exception', 'evidence_added', 'draft_prepared', 'publication_requested', 'publication_response', 'publication_uncertain']),
  actor: z.string().trim().min(1).max(150), reason: z.string().max(3000),
  subject: z.string().max(4000), evidence: z.string().max(20000),
  changes: z.array(z.object({ field: z.string().max(200), before: value, after: value })).max(300),
  documents: z.array(z.object({ name: z.string().max(240), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).max(6),
}).strict();
export const historySchema = z.object({ dossierId: z.string().uuid(), events: z.array(decisionSchema).min(1).max(1000) }).strict();
export type Decision = z.infer<typeof decisionSchema>;
