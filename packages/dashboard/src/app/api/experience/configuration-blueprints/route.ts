import { type NextRequest, NextResponse } from 'next/server';
import {
  ConfigurationBlueprintSchema,
  previewBlueprintApplication,
} from '@somnibot/shared';
import { z } from 'zod';
import { applyConfigurationBlueprint } from '@/lib/experience/configuration-blueprint-application';
import { operationRpc } from '@/lib/operations/repository';
import { authErrorResponse, requirePermission } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';

const environmentSchema = z.object({
  activeFeatures: z.array(z.string()),
  grantedPermissions: z.array(z.string()),
  readyProviders: z.array(z.string()),
  activeClaims: z.array(z.object({
    operationId: z.string().uuid(),
    feature: z.string(),
    resource: z.object({ kind: z.string(), id: z.string() }),
    access: z.enum(['shared', 'exclusive']),
  })),
}).strict();

const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('preview'),
    operationId: z.string().uuid(),
    blueprint: ConfigurationBlueprintSchema,
    currentConfiguration: z.record(z.unknown()),
    environment: environmentSchema,
  }).strict(),
  z.object({
    action: z.literal('apply'),
    operationId: z.string().uuid(),
    idempotencyKey: z.string().trim().min(1).max(200),
    blueprint: ConfigurationBlueprintSchema,
    currentConfiguration: z.record(z.unknown()),
    environment: environmentSchema,
  }).strict(),
]);

export async function POST(request: NextRequest) {
  try {
    const context = await requirePermission('dashboard.full_access');
    const body = requestSchema.safeParse(await request.json());
    if (!body.success) {
      return NextResponse.json({ error: 'Invalid configuration blueprint request.' }, { status: 400 });
    }
    if (body.data.action === 'preview') {
      return NextResponse.json({
        success: true,
        data: previewBlueprintApplication(body.data),
      });
    }

    const result = await applyConfigurationBlueprint(
      operationRpc(createAdminSupabase()),
      {
        ...body.data,
        guildId: context.guildId,
        actor: {
          type: context.isOwner ? 'owner' : 'administrator',
          id: context.discordId,
        },
      },
    );
    return NextResponse.json(
      { success: result.kind !== 'blocked', data: result },
      { status: result.kind === 'blocked' ? 409 : 200 },
    );
  } catch (error) {
    return authErrorResponse(error);
  }
}
