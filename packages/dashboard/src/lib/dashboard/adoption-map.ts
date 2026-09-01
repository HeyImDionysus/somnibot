import { z } from 'zod';

export const adoptionTrackStateSchema = z.enum(['not_started', 'in_progress', 'ready', 'active', 'paused', 'skipped']);
export type AdoptionTrackState = z.infer<typeof adoptionTrackStateSchema>;

export const adoptionMapStateSchema = z.object({
  mode: z.enum(['guided', 'expert']),
  tutorialVisible: z.boolean(),
  selectedTrackIds: z.array(z.string().min(1)).max(32),
  verifiedTrackIds: z.array(z.string().min(1)).max(32),
  trackStates: z.record(z.string(), adoptionTrackStateSchema),
});
export type AdoptionMapState = z.infer<typeof adoptionMapStateSchema>;

export const adoptionMapMutationSchema = adoptionMapStateSchema.omit({ verifiedTrackIds: true }).strict();
export type AdoptionMapMutation = z.infer<typeof adoptionMapMutationSchema>;

export interface AdoptionTrack {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly href: string;
  readonly testHref: string;
  readonly required: boolean;
  readonly dependencies: readonly string[];
}

export const ADOPTION_TRACKS: readonly AdoptionTrack[] = [
  { id: 'core', label: 'Core bot connection', description: 'Connect Discord, verify permissions, and observe a live heartbeat.', href: '/diagnostics', testHref: '/diagnostics', required: true, dependencies: [] },
  { id: 'structure', label: 'Server structure', description: 'Prepare roles and channels with a safe preview.', href: '/server-setup', testHref: '/sync', required: false, dependencies: ['core'] },
  { id: 'moderation', label: 'Moderation', description: 'Configure rules, staff actions, appeals, and audit behavior.', href: '/moderation', testHref: '/moderation/rules', required: false, dependencies: ['core'] },
  { id: 'welcome', label: 'Welcome and onboarding', description: 'Choose member entry, welcome, and returning-member behavior.', href: '/onboarding', testHref: '/welcome', required: false, dependencies: ['core'] },
  { id: 'community', label: 'Community features', description: 'Enable levels, reaction roles, giveaways, and scheduled content.', href: '/levels', testHref: '/giveaways', required: false, dependencies: ['core'] },
  { id: 'economy', label: 'Coin economy', description: 'Connect progression, rewards, shops, and crafting.', href: '/economy', testHref: '/economy/analytics', required: false, dependencies: ['core'] },
  { id: 'games', label: 'Mini-games and lottery', description: 'Configure mini-games and lottery controls, then confirm their authoritative settings readback.', href: '/economy/games', testHref: '/economy/games', required: false, dependencies: ['core'] },
  { id: 'music', label: 'Music', description: 'Verify voice permissions, playback, queue control, and recovery.', href: '/music', testHref: '/music', required: false, dependencies: ['core'] },
  { id: 'automation', label: 'Automation', description: 'Build triggers and actions with conflict and recursion safety.', href: '/automations', testHref: '/workflows', required: false, dependencies: ['core'] },
  { id: 'store', label: 'Store and PayPal', description: 'Prepare product policy, sandbox payment, fulfillment, and reversal.', href: '/store', testHref: '/store/orders', required: false, dependencies: ['core'] },
  { id: 'licensing', label: 'Project licensing', description: 'Generate, integrate, and verify a SomniBot SDK contract.', href: '/sdk', testHref: '/licenses', required: false, dependencies: ['store'] },
  { id: 'staff', label: 'Staff access', description: 'Assign dashboard roles and verify each role-specific work surface.', href: '/settings/team', testHref: '/audit', required: false, dependencies: ['core'] },
  { id: 'recovery', label: 'Deployment and recovery', description: 'Confirm deployment identity, backups, upgrade safety, and recovery actions.', href: '/diagnostics', testHref: '/incidents', required: true, dependencies: ['core'] },
];

export const defaultAdoptionMapState: AdoptionMapState = {
  mode: 'guided',
  tutorialVisible: true,
  selectedTrackIds: ['core', 'recovery'],
  verifiedTrackIds: [],
  trackStates: {},
};

export function blockedDependencies(track: AdoptionTrack, state: AdoptionMapState): readonly string[] {
  return track.dependencies.filter((dependencyId) => state.trackStates[dependencyId] !== 'active');
}

export function normalizeAdoptionMapState(input: unknown): AdoptionMapState {
  const parsed = adoptionMapStateSchema.safeParse(input);
  if (!parsed.success) return defaultAdoptionMapState;
  const knownIds = new Set(ADOPTION_TRACKS.map((track) => track.id));
  return {
    ...parsed.data,
    selectedTrackIds: parsed.data.selectedTrackIds.filter((id) => knownIds.has(id)),
    verifiedTrackIds: parsed.data.verifiedTrackIds.filter((id) => knownIds.has(id)),
    trackStates: Object.fromEntries(Object.entries(parsed.data.trackStates).filter(([id]) => knownIds.has(id))),
  };
}

export function adoptionMapMutationFromState(state: AdoptionMapState): AdoptionMapMutation {
  return {
    mode: state.mode,
    tutorialVisible: state.tutorialVisible,
    selectedTrackIds: state.selectedTrackIds,
    trackStates: state.trackStates,
  };
}

export function withVerifiedTracks(
  desired: AdoptionMapMutation,
  verifiedTrackIds: readonly string[],
): AdoptionMapState {
  return normalizeAdoptionMapState({ ...desired, verifiedTrackIds });
}

export function adoptionStateErrors(state: AdoptionMapState, previous?: AdoptionMapState): readonly string[] {
  const selectedIds = new Set(state.selectedTrackIds);
  const verifiedIds = new Set(state.verifiedTrackIds);
  const knownIds = new Set(ADOPTION_TRACKS.map((track) => track.id));
  const errors: string[] = [];
  if (selectedIds.size !== state.selectedTrackIds.length) errors.push('selected_tracks:duplicate');
  if (verifiedIds.size !== state.verifiedTrackIds.length) errors.push('verified_tracks:duplicate');
  for (const id of selectedIds) if (!knownIds.has(id)) errors.push(`selected_tracks:unknown:${id}`);
  for (const id of verifiedIds) if (!knownIds.has(id)) errors.push(`verified_tracks:unknown:${id}`);
  for (const id of Object.keys(state.trackStates)) if (!knownIds.has(id)) errors.push(`track_states:unknown:${id}`);
  for (const track of ADOPTION_TRACKS) {
    const trackState = state.trackStates[track.id] ?? 'not_started';
    if (track.required && !selectedIds.has(track.id)) errors.push(`${track.id}:required`);
    if (track.required && trackState === 'skipped') errors.push(`${track.id}:cannot_skip`);
    if (trackState === 'active' && previous?.trackStates[track.id] !== 'active' && !verifiedIds.has(track.id)) errors.push(`${track.id}:verification_required`);
    if (trackState === 'active') {
      for (const dependencyId of track.dependencies) {
        if (state.trackStates[dependencyId] !== 'active') errors.push(`${track.id}:dependency:${dependencyId}`);
      }
    }
  }
  return errors;
}
