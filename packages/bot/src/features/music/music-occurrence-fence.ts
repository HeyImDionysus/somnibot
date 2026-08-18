import type { SupabaseClient } from '@supabase/supabase-js';
import type { PlatformEventBus } from '../../services/event-bus.js';
import {
  claimDiscordOccurrence,
  completeDiscordOccurrence,
  failDiscordOccurrence,
  type DiscordOperationOccurrence,
} from '../../services/occurrence-fence.js';

export type MusicInteractionAction =
  | 'play'
  | 'pause'
  | 'skip'
  | 'stop'
  | 'shuffle'
  | 'loop'
  | 'volume';

export type MusicOccurrenceExecution<T> = {
  readonly interactionId: string;
  readonly userId: string;
  readonly action: MusicInteractionAction;
  readonly mutate: () => Promise<T>;
};

export type MusicOccurrenceOutcome<T> =
  | { readonly kind: 'applied'; readonly value: T }
  | { readonly kind: 'replayed'; readonly message: string }
  | { readonly kind: 'unavailable'; readonly message: string }
  | { readonly kind: 'indeterminate'; readonly message: string };

export class MusicOccurrenceSettlementError extends Error {
  constructor(
    readonly mutationError: Error,
    readonly settlementError: Error,
  ) {
    super('Music mutation failed and its durable failure could not be recorded');
    this.name = 'MusicOccurrenceSettlementError';
  }
}

export class MusicInteractionOccurrenceFence {
  constructor(
    private readonly supabase: SupabaseClient,
    private readonly eventBus: PlatformEventBus,
    private readonly guildId: string,
  ) {}

  async execute<T>(execution: MusicOccurrenceExecution<T>): Promise<MusicOccurrenceOutcome<T>> {
    const occurrence = await this.claim(execution);
    if (!occurrence) {
      return {
        kind: 'unavailable',
        message: '❌ I could not verify this interaction. Nothing was changed; please retry.',
      };
    }

    if (occurrence.status !== 'claimed') return this.replay(execution, occurrence);

    const began = await this.begin(execution, occurrence);
    if (began === null) {
      return {
        kind: 'unavailable',
        message: '❌ I could not verify this interaction. Nothing was changed; please retry.',
      };
    }
    if (!began) return this.replay(execution, occurrence);

    let value: T;
    try {
      value = await execution.mutate();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      await this.recordFailure(execution, occurrence, error);
      throw error;
    }

    try {
      await completeDiscordOccurrence(
        this.supabase,
        occurrence.id,
        execution.interactionId,
        { state: 'applied', action: execution.action, userId: execution.userId },
      );
    } catch {
      return {
        kind: 'indeterminate',
        message: '⚠️ The action may have completed, but confirmation failed. Automatic retry is blocked; check the current music state before trying a new command.',
      };
    }
    return { kind: 'applied', value };
  }

  private async claim(
    execution: MusicOccurrenceExecution<unknown>,
  ): Promise<DiscordOperationOccurrence | null> {
    try {
      const claim = await claimDiscordOccurrence(
        this.supabase,
        this.guildId,
        'music_interaction',
        execution.interactionId,
        { state: 'claimed', action: execution.action, userId: execution.userId },
      );
      return claim.occurrence;
    } catch (error) {
      if (error instanceof Error) return null;
      throw error;
    }
  }

  private async begin(
    execution: MusicOccurrenceExecution<unknown>,
    occurrence: DiscordOperationOccurrence,
  ): Promise<boolean | null> {
    try {
      const { data, error } = await this.supabase.rpc('begin_music_interaction_mutation', {
        p_occurrence_id: occurrence.id,
        p_guild_id: this.guildId,
        p_occurrence_key: execution.interactionId,
        p_action: execution.action,
        p_user_id: execution.userId,
      });
      if (error) throw new Error(`Unable to begin music interaction mutation: ${error.message}`);
      return data === true;
    } catch (error) {
      if (error instanceof Error) return null;
      throw error;
    }
  }

  private replay(
    execution: MusicOccurrenceExecution<unknown>,
    occurrence: DiscordOperationOccurrence,
  ): MusicOccurrenceOutcome<never> {
    this.eventBus.emit('music.replay_ignored', this.guildId, {
      userId: execution.userId,
      action: execution.action,
      occurrenceId: execution.interactionId,
      originalStatus: occurrence.status,
    });
    return {
      kind: 'replayed',
      message: `ℹ️ Interaction ${execution.interactionId} was already received; this delivery did not change music state.`,
    };
  }

  private async recordFailure(
    execution: MusicOccurrenceExecution<unknown>,
    occurrence: DiscordOperationOccurrence,
    mutationError: Error,
  ): Promise<void> {
    try {
      await failDiscordOccurrence(
        this.supabase,
        occurrence.id,
        mutationError.message,
        execution.interactionId,
        { state: 'failed', action: execution.action, userId: execution.userId },
      );
    } catch (error) {
      if (error instanceof Error) {
        throw new MusicOccurrenceSettlementError(mutationError, error);
      }
      throw error;
    }
  }
}
