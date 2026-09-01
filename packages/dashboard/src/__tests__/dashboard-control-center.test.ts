import { describe, expect, it } from 'vitest';
import {
  attentionForView,
  authorizedDynamicSearchKinds,
  authorizedDestinations,
  availableAttentionViews,
  parseDynamicSearchResults,
  searchStaticControlCenter,
  searchDestinations,
} from '@/lib/dashboard/control-center';
import {
  ADOPTION_TRACKS,
  adoptionStateErrors,
  defaultAdoptionMapState,
  normalizeAdoptionMapState,
} from '@/lib/dashboard/adoption-map';

describe('dashboard control-center authorization', () => {
  it('returns only destinations the delegated role may open', () => {
    const destinations = authorizedDestinations(['dashboard.manage_moderation', 'dashboard.manage_tickets']);

    expect(destinations.map((destination) => destination.id)).toContain('moderation');
    expect(destinations.map((destination) => destination.id)).toContain('tickets');
    expect(destinations.map((destination) => destination.id)).not.toContain('orders');
    expect(destinations.map((destination) => destination.id)).not.toContain('team');
  });

  it('organizes overlapping permissions into every applicable attention view', () => {
    const views = availableAttentionViews(['dashboard.manage_moderation', 'dashboard.manage_orders']);

    expect(views).toEqual(['moderator', 'finance']);
    expect(attentionForView('finance', ['dashboard.manage_orders']).map((item) => item.id)).toEqual(['finance-orders']);
  });

  it('searches only the already-authorized destination set', () => {
    const destinations = authorizedDestinations(['dashboard.manage_tickets']);

    expect(searchDestinations(destinations, 'support').map((destination) => destination.id)).toEqual(['tickets']);
    expect(searchDestinations(destinations, 'paypal')).toEqual([]);
  });

  it('authorizes dynamic providers independently for each staff role', () => {
    expect(authorizedDynamicSearchKinds(['dashboard.manage_customers'])).toEqual(['customers']);
    expect(authorizedDynamicSearchKinds(['dashboard.manage_incidents', 'dashboard.view_audit'])).toEqual(['incidents', 'audits']);
    expect(authorizedDynamicSearchKinds(['dashboard.full_access'])).toEqual(['products', 'customers', 'members', 'incidents', 'audits']);
  });

  it('filters malformed or unauthorized dynamic rows before rendering', () => {
    expect(parseDynamicSearchResults([
      { kind: 'customers', id: 'customer-1', label: 'Buyer', description: 'Customer', href: '/customers/customer-1' },
      { kind: 'products', id: 'product-1', label: 'Secret product', description: 'Product', href: '/store?productId=product-1' },
      { kind: 'customers', id: '', label: '', description: '', href: 'https://outside.invalid' },
    ], ['customers'])).toEqual([
      { kind: 'customers', id: 'customer-1', label: 'Buyer', description: 'Customer', href: '/customers/customer-1' },
    ]);
  });

  it('searches authorized features, settings, commands, documentation, and recovery actions', () => {
    const results = searchStaticControlCenter(['dashboard.full_access'], 'recovery');
    expect(new Set(results.map((result) => result.kind))).toEqual(new Set(['features', 'documentation', 'recovery']));
    expect(searchStaticControlCenter(['dashboard.manage_moderation'], 'ban').some((result) => result.kind === 'commands')).toBe(true);
  });
});

describe('owner adoption map', () => {
  it('normalizes malformed storage to a safe guided plan', () => {
    expect(normalizeAdoptionMapState({ mode: 'invalid' })).toEqual(defaultAdoptionMapState);
  });

  it('rejects activation without recorded verification or active dependencies', () => {
    const state = {
      ...defaultAdoptionMapState,
      selectedTrackIds: ['core', 'recovery', 'licensing'],
      trackStates: { licensing: 'active' as const },
    };

    expect(adoptionStateErrors(state)).toContain('licensing:verification_required');
    expect(adoptionStateErrors(state)).toContain('licensing:dependency:store');
  });

  it('rejects unknown and duplicate track identities before persistence', () => {
    const state = {
      ...defaultAdoptionMapState,
      selectedTrackIds: ['core', 'core', 'unknown'],
      verifiedTrackIds: ['unknown'],
      trackStates: { unknown: 'ready' as const },
    };

    expect(adoptionStateErrors(state)).toEqual(expect.arrayContaining([
      'selected_tracks:duplicate',
      'selected_tracks:unknown:unknown',
      'verified_tracks:unknown:unknown',
      'track_states:unknown:unknown',
    ]));
  });

  it('accepts an independently verified track after its dependencies are active', () => {
    const state = {
      ...defaultAdoptionMapState,
      selectedTrackIds: ['core', 'recovery', 'store', 'licensing'],
      verifiedTrackIds: ['core', 'recovery', 'store', 'licensing'],
      trackStates: { core: 'active' as const, recovery: 'active' as const, store: 'active' as const, licensing: 'active' as const },
    };

    expect(adoptionStateErrors(state)).toEqual([]);
    expect(ADOPTION_TRACKS.find((track) => track.id === 'licensing')?.dependencies).toEqual(['store']);
  });

  it('uses dashboard-safe core setup routes rather than reopening instance setup', () => {
    expect(ADOPTION_TRACKS.find((track) => track.id === 'core')).toEqual(expect.objectContaining({
      href: '/diagnostics',
      testHref: '/diagnostics',
    }));
  });
});
