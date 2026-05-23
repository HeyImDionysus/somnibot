import { NextResponse } from 'next/server';
import { requirePermission } from '@/lib/rbac';
import { createAdminSupabase } from '@/lib/supabase/admin';
import { notifyBot } from '@/lib/notify-bot';
import { z } from 'zod';

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
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, questions: data ?? [] });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 401 });
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const raw = await request.json();
    const parsed = triviaQuestionSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Validation failed' }, { status: 400 });
    }
    const body = parsed.data;
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
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await notifyBot('economy');
    return NextResponse.json({ success: true, question: data });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 401 });
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const raw = await request.json();
    const parsed = triviaQuestionSchema.extend({ id: z.string().uuid() }).safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Validation failed' }, { status: 400 });
    }
    const body = parsed.data;
    const supabase = createAdminSupabase();
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
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await notifyBot('economy');
    return NextResponse.json({ success: true, question: data });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 401 });
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requirePermission('dashboard.manage_economy');
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
    const supabase = createAdminSupabase();
    const { error } = await supabase
      .from('economy_trivia_questions')
      .delete()
      .eq('id', id)
      .eq('guild_id', ctx.guildId);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await notifyBot('economy');
    return NextResponse.json({ success: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 401 });
  }
}
