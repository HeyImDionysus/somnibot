import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../supabase/migrations/20260823120100_team_invitation_atomic_acceptance.sql'),
  'utf8',
);

describe('team invitation atomic acceptance migration', () => {
  it('locks the invitation and commits the role grant with the accepted state', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.accept_team_invitation_atomic');
    expect(migration).toContain('FOR UPDATE');
    expect(migration).toMatch(/INSERT INTO public\.dashboard_user_roles[\s\S]+UPDATE public\.team_invitations/);
    expect(migration).toMatch(/UPDATE public\.team_invitations[\s\S]+INSERT INTO public\.audit_logs/);
    expect(migration).toContain("'team.invite_accepted'");
    expect(migration).toContain("invitation.status = 'pending'");
  });

  it('keeps the identity-bound function unavailable to browser roles', () => {
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.accept_team_invitation_atomic(uuid, text) FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.accept_team_invitation_atomic(uuid, text) TO service_role');
  });
});
