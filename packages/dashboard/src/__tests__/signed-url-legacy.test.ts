/**
 * Round 12: rolling-deployment compatibility for signed download links.
 *
 * An old application instance keeps minting the PREVIOUS release's link
 * format (sig/exp/cid/gid/nonce — no eid) for up to the five-minute link
 * lifetime. The new verifier must accept that format for its remaining
 * life — still nonce-bound — and report entitlementId null so the route
 * selects the entitlement at delivery time. 401ing freshly issued links
 * mid-deploy is a customer-facing outage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'crypto';

vi.hoisted(() => {
  process.env.DOWNLOAD_SIGNING_SECRET = 'test-download-signing-secret';
});

import {
  generateSignedDownloadUrl,
  verifySignedDownloadUrl,
} from '@/lib/api/signed-url';

const SECRET = 'test-download-signing-secret';
const PRODUCT = 'prod-1';
const FILE = 'file-1';
const CID = 'cust-1';
const GID = 'guild-1';
const EID = 'ent-1';

function legacySign(exp: number, nonce: string): string {
  // The exact payload the previous release signed: no entitlement id.
  return createHmac('sha256', SECRET)
    .update(`${PRODUCT}:${FILE}:${CID}:${GID}:${exp}:${nonce}`)
    .digest('hex');
}

describe('verifySignedDownloadUrl — current and legacy formats', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('verifies a freshly generated current-format link end to end', () => {
    const url = generateSignedDownloadUrl({
      productId: PRODUCT,
      fileId: FILE,
      customerId: CID,
      guildId: GID,
      entitlementId: EID,
    });
    const params = new URL(`http://localhost${url}`).searchParams;
    const verified = verifySignedDownloadUrl(
      PRODUCT,
      FILE,
      params.get('sig')!,
      params.get('exp')!,
      params.get('cid')!,
      params.get('gid')!,
      params.get('eid')!,
      params.get('nonce')!,
    );
    expect(verified).toEqual({
      customerId: CID,
      guildId: GID,
      entitlementId: EID,
      nonce: params.get('nonce'),
    });
  });

  it('verifies a legacy no-eid link for its remaining lifetime with entitlementId null', () => {
    const exp = Math.floor(Date.now() / 1000) + 120;
    const nonce = 'legacy-nonce-1';
    const verified = verifySignedDownloadUrl(
      PRODUCT,
      FILE,
      legacySign(exp, nonce),
      String(exp),
      CID,
      GID,
      null,
      nonce,
    );
    expect(verified).toEqual({
      customerId: CID,
      guildId: GID,
      entitlementId: null,
      nonce,
    });
  });

  it('rejects a tampered legacy signature', () => {
    const exp = Math.floor(Date.now() / 1000) + 120;
    const nonce = 'legacy-nonce-2';
    const sig = legacySign(exp, nonce);
    const tampered = sig.slice(0, -1) + (sig.endsWith('0') ? '1' : '0');
    expect(
      verifySignedDownloadUrl(PRODUCT, FILE, tampered, String(exp), CID, GID, null, nonce),
    ).toBeNull();
    // A legacy signature must not verify for a DIFFERENT customer either.
    expect(
      verifySignedDownloadUrl(PRODUCT, FILE, sig, String(exp), 'cust-2', GID, null, nonce),
    ).toBeNull();
  });

  it('still requires a nonce and an unexpired timestamp in both formats', () => {
    const exp = Math.floor(Date.now() / 1000) + 120;
    expect(
      verifySignedDownloadUrl(PRODUCT, FILE, legacySign(exp, 'n'), String(exp), CID, GID, null),
    ).toBeNull();
    const past = Math.floor(Date.now() / 1000) - 5;
    expect(
      verifySignedDownloadUrl(
        PRODUCT, FILE, legacySign(past, 'n'), String(past), CID, GID, null, 'n',
      ),
    ).toBeNull();
  });

  it('does not let a legacy signature validate as a current-format link for a chosen eid', () => {
    // An attacker holding a legacy link must not be able to attach an
    // arbitrary entitlement id and have the same signature accepted.
    const exp = Math.floor(Date.now() / 1000) + 120;
    const nonce = 'legacy-nonce-3';
    expect(
      verifySignedDownloadUrl(
        PRODUCT, FILE, legacySign(exp, nonce), String(exp), CID, GID, 'ent-forged', nonce,
      ),
    ).toBeNull();
  });
});
