import { z } from 'zod';
import { ADOPTION_TRACKS } from './adoption-map';

export const adoptionVerificationSchema = z.object({
  trackId: z.string().refine((id) => ADOPTION_TRACKS.some((track) => track.id === id)),
  result: z.enum(['pass', 'fail', 'unknown']),
  eligible: z.boolean(),
  checkedAt: z.string().datetime({ offset: true }).nullable(),
  expiresAt: z.string().datetime({ offset: true }).nullable(),
  reason: z.string(),
  evidenceIds: z.array(z.string()).max(20),
});
export type AdoptionVerification = z.infer<typeof adoptionVerificationSchema>;

export function currentVerifiedTrackIds(rows: unknown, nowMs: number): readonly string[] {
  const parsed = z.array(adoptionVerificationSchema).max(13).safeParse(rows);
  if (!parsed.success) return [];
  const ids = parsed.data.map((row) => row.trackId);
  if (new Set(ids).size !== ids.length) return [];
  return parsed.data.filter((row) => row.result === 'pass' && row.eligible
    && row.checkedAt !== null && Date.parse(row.checkedAt) <= nowMs
    && row.expiresAt !== null && Date.parse(row.expiresAt) > nowMs).map((row) => row.trackId);
}
