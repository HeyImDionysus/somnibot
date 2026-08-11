import { describe, expect, it } from 'vitest';
import {
  ClientApiError,
  hasStringId,
  requireApiArray,
  requireApiSuccess,
  requireReadback,
} from '@/lib/client-api-result';

describe('requireApiSuccess', () => {
  it('rejects an HTTP failure with the API recovery message', async () => {
    const response = new Response(JSON.stringify({ success: false, error: 'Role is still assigned to 2 members.' }), {
      status: 409,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(requireApiSuccess(response, 'Could not delete role.')).rejects.toEqual(
      new ClientApiError('Role is still assigned to 2 members.', 409),
    );
  });

  it('rejects a 200 response whose API contract reports failure', async () => {
    const response = new Response(JSON.stringify({ success: false, error: 'Replay claim is active.' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(requireApiSuccess(response, 'Could not replay webhook.')).rejects.toThrow(
      'Replay claim is active.',
    );
  });

  it('returns a successful response for authoritative readback handling', async () => {
    const response = new Response(JSON.stringify({ success: true, data: { enabled: true } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

    await expect(requireApiSuccess(response, 'Could not save.')).resolves.toMatchObject({
      success: true,
      data: { enabled: true },
    });
  });

  it('rejects a malformed success payload at the client boundary', () => {
    expect(() => requireApiArray(
      { success: true, data: [{ id: 42 }] },
      'data',
      hasStringId,
      'Malformed readback',
    )).toThrow(new ClientApiError('Malformed readback', 502));
  });

  it('rejects a successful mutation whose authoritative readback is stale', () => {
    expect(() => requireReadback(false, 'Stale readback')).toThrow(new ClientApiError('Stale readback', 409));
  });
});
