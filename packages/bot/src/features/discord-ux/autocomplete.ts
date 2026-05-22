/**
 * Autocomplete Handlers — Provide suggestions for slash command options.
 *
 * Supports:
 * - /play → YouTube/SoundCloud search results
 * - /store → Product names
 * - Custom commands → Argument suggestions
 */
import type { AutocompleteInteraction } from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Shoukaku } from 'shoukaku';

/**
 * Route autocomplete interactions to the correct handler.
 */
export async function handleAutocomplete(
  interaction: AutocompleteInteraction,
  supabase: SupabaseClient,
  shoukaku: Shoukaku,
  guildId: string,
): Promise<void> {
  const command = interaction.commandName;
  const focused = interaction.options.getFocused(true);

  try {
    switch (command) {
      case 'play':
        await handlePlayAutocomplete(interaction, shoukaku, focused.value);
        break;
      case 'store':
        await handleStoreAutocomplete(interaction, supabase, guildId, focused.value);
        break;
      case 'remove':
        await handleQueueAutocomplete(interaction, focused.value);
        break;
      default:
        await interaction.respond([]);
    }
  } catch {
    await interaction.respond([]).catch(() => { /* interaction may have expired */ });
  }
}

async function handlePlayAutocomplete(
  interaction: AutocompleteInteraction,
  shoukaku: Shoukaku,
  query: string,
): Promise<void> {
  if (!query || query.length < 2) {
    await interaction.respond([]);
    return;
  }

  // If it's a URL, don't autocomplete
  if (query.startsWith('http://') || query.startsWith('https://')) {
    await interaction.respond([{ name: query.slice(0, 100), value: query }]);
    return;
  }

  const node = shoukaku.nodes.get('main') ?? [...shoukaku.nodes.values()][0];
  if (!node) {
    await interaction.respond([]);
    return;
  }

  try {
    const result = await node.rest.resolve(`ytsearch:${query}`);
    if (!result || result.loadType !== 'search' || !result.data?.length) {
      await interaction.respond([]);
      return;
    }

    const choices = result.data.slice(0, 10).map((track) => ({
      name: `${track.info.title} — ${track.info.author}`.slice(0, 100),
      value: track.info.uri ?? `ytsearch:${track.info.title}`,
    }));

    await interaction.respond(choices);
  } catch {
    await interaction.respond([]);
  }
}

async function handleStoreAutocomplete(
  interaction: AutocompleteInteraction,
  supabase: SupabaseClient,
  guildId: string,
  query: string,
): Promise<void> {
  const { data: products } = await supabase
    .from('products')
    .select('id, name, price_cents, currency')
    .eq('guild_id', guildId)
    .eq('active', true)
    .ilike('name', `%${query}%`)
    .limit(25);

  const choices = (products ?? []).map((p) => ({
    name: `${p.name} — $${(p.price_cents / 100).toFixed(2)} ${p.currency}`.slice(0, 100),
    value: p.id,
  }));

  await interaction.respond(choices);
}

async function handleQueueAutocomplete(
  interaction: AutocompleteInteraction,
  query: string,
): Promise<void> {
  // Queue-based autocomplete would need access to the queue manager
  // For now, return empty — the queue position is a number
  await interaction.respond([]);
}
