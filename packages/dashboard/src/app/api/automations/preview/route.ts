import { NextRequest, NextResponse } from 'next/server';
import { requireGuildOwner } from '@/lib/api/require-owner';
import { parseBody, schemas } from '@/lib/api/validation';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { automationPreviewHash, automationPreviewSummary } from '@/lib/automation-preview';

const previewSchema = schemas.automation.create;

/** Return a side-effect-free dry-run summary and the approval hash. */
export async function POST(req: NextRequest) {
  const rateLimited = await checkAdminRateLimit(req, 'write');
  if (rateLimited) return rateLimited;
  const auth = await requireGuildOwner();
  if (!auth.ok) return auth.response;
  const parsed = await parseBody(req, previewSchema);
  if (!parsed.ok) return parsed.response;
  const definition = parsed.data;
  const preview_hash = automationPreviewHash(definition);
  return NextResponse.json({
    success: true,
    preview_hash,
    preview: automationPreviewSummary(definition),
  });
}
