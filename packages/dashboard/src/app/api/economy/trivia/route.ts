import { NextResponse, type NextRequest } from 'next/server';
import { requirePermission, authErrorResponse } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';
import { checkAdminRateLimit } from '@/lib/api/admin-rate-limit';
import { parseBody } from '@/lib/api/validation';
import { dbError } from '@/lib/api/response';
import { BUILT_IN_TRIVIA_QUESTIONS } from '@somnibot/shared';
import { readRowBefore, recordCrudChange } from '@/lib/admin-changes';

// The bot serves these alongside the guild's custom pack (see shared/constants/
// trivia.ts). Mapped once at module scope into the page's row shape — synthetic
// ids are stable because the bank is a fixed ordered constant.
const BUILT_IN_ROWS = BUILT_IN_TRIVIA_QUESTIONS.map((q, i) => ({
  id: `built-in-${i}`,
  category: q.category,
  difficulty: q.difficulty,
  question: q.question,
  correct_answer: q.correct,
  wrong_answers: q.wrong,
  builtIn: true as const,
}));

const triviaQuestionSchema = z.object({
  id: z.string().uuid().optional(),
  category: z.string().min(1).max(64).optional().default('general'),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional().default('medium'),
  question: z.string().min(1).max(500),
  correct_answer: z.string().min(1).max(256),
  wrong_answers: z.array(z.string().min(1).max(256)).min(1).max(5).optional().default([]),
});

export async function GET() {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const supabase = createAdminSupabase();
    const { data, error } = await supabase
      .from('economy_trivia_questions')
      .select('*')
      .eq('guild_id', ctx.guildId)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) return dbError(error, 'economy/trivia');
    return NextResponse.json({ success: true, questions: data ?? [], builtIn: BUILT_IN_ROWS });
  } catch (e) {
    return authErrorResponse(e);
  }
}

export async function POST(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const result = await parseBody(request, triviaQuestionSchema);
    if (!result.ok) return result.response;
    const body = result.data;
    const supabase = createAdminSupabase();
    const { data, error } = await supabase
      .from('economy_trivia_questions')
      .insert({
        guild_id: ctx.guildId,
        category: body.category,
        difficulty: body.difficulty,
        question: body.question,
        correct_answer: body.correct_answer,
        wrong_answers: body.wrong_answers,
      })
      .select()
      .single();
    if (error) return dbError(error, 'economy/trivia');
    await notifyBot(ctx.guildId, 'economy');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'created',
      action: 'economy.trivia_question_created',
      table: 'economy_trivia_questions',
      targetType: 'trivia question',
      targetId: (data as { id?: string } | null)?.id ?? null,
      label: undefined,
      after: data as Record<string, unknown> | null,
    }, supabase);
    return NextResponse.json({ success: true, question: data });
  } catch (e) {
    return authErrorResponse(e);
  }
}

export async function PUT(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const putSchema = triviaQuestionSchema.extend({ id: z.string().uuid() });
    const result = await parseBody(request, putSchema);
    if (!result.ok) return result.response;
    const body = result.data;
    const supabase = createAdminSupabase();
    const before = await readRowBefore(supabase, 'economy_trivia_questions', { id: body.id, guild_id: ctx.guildId });

    const { data, error } = await supabase
      .from('economy_trivia_questions')
      .update({
        category: body.category,
        difficulty: body.difficulty,
        question: body.question,
        correct_answer: body.correct_answer,
        wrong_answers: body.wrong_answers,
        updated_at: new Date().toISOString(),
      })
      .eq('id', body.id)
      .eq('guild_id', ctx.guildId)
      .select()
      .single();
    if (error) return dbError(error, 'economy/trivia');
    await notifyBot(ctx.guildId, 'economy');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'updated',
      action: 'economy.trivia_question_updated',
      table: 'economy_trivia_questions',
      targetType: 'trivia question',
      targetId: body.id,
      label: (before?.question as string | undefined),
      before,
      after: {
        category: body.category,
        difficulty: body.difficulty,
        question: body.question,
        correct_answer: body.correct_answer,
        wrong_answers: body.wrong_answers,
      },
      match: { id: body.id, guild_id: ctx.guildId },
    }, supabase);
    return NextResponse.json({ success: true, question: data });
  } catch (e) {
    return authErrorResponse(e);
  }
}

export async function DELETE(request: NextRequest) {
  const rateLimited = await checkAdminRateLimit(request, 'write');
  if (rateLimited) return rateLimited;

  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    const supabase = createAdminSupabase();
    const before = await readRowBefore(supabase, 'economy_trivia_questions', { id: id, guild_id: ctx.guildId });

    const { error } = await supabase
      .from('economy_trivia_questions')
      .delete()
      .eq('id', id)
      .eq('guild_id', ctx.guildId);
    if (error) return dbError(error, 'economy/trivia');
    await notifyBot(ctx.guildId, 'economy');

    await recordCrudChange({
      guildId: ctx.guildId,
      actorId: ctx.discordId,
      operation: 'deleted',
      action: 'economy.trivia_question_deleted',
      table: 'economy_trivia_questions',
      targetType: 'trivia question',
      targetId: id,
      label: (before?.question as string | undefined),
      before,
      blastRadius: 'medium',
    }, supabase);
    return NextResponse.json({ success: true });
  } catch (e) {
    return authErrorResponse(e);
  }
}
