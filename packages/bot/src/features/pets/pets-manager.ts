/**
 * PetsManager — virtual pet system with care, training, battles, and prestige.
 *
 * V36: Added schedulePetDecay() — periodic stat reduction based on
 * economy_pet_decay_rate. Pets become 'sick'/'sad' at low stats.
 * Optional DM notifications to owners.
 */
import {
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type User,
  type Client,
} from 'discord.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DbGuildConfig } from '@somnibot/shared';

let _manager: PetsManager | null = null;
export function registerPetsManager(mgr: PetsManager): void { _manager = mgr; }
export function invalidatePetsCache(): void { _manager?.clearCache(); }

const PET_TYPES: Record<string, { emoji: string; desc: string }> = {
  hunting: { emoji: '🐺', desc: 'Boosts hunt loot' },
  guard: { emoji: '🐕', desc: 'Reduces rob success against you' },
  foraging: { emoji: '🐿️', desc: 'Passive item finds' },
  lucky: { emoji: '🐈', desc: 'Slight gambling boost' },
};

const PET_PRICES: Record<string, number> = {
  hunting: 5000, guard: 5000, foraging: 5000, lucky: 7500,
};

const XP_PER_LEVEL = 100;
const MAX_LEVEL = 50;

export class PetsManager {
  private supabase: SupabaseClient;
  private client: Client | null = null;
  private configCache = new Map<string, DbGuildConfig>();
  private decayTimer: NodeJS.Timeout | null = null;

  constructor(supabase: SupabaseClient, client?: Client) {
    this.supabase = supabase as any;
    this.client = client ?? null;
  }

  clearCache(): void { this.configCache.clear(); }

  /** Start the pet decay timer. Call once at boot. */
  async schedulePetDecay(guildId: string): Promise<void> {
    if (this.decayTimer) { clearInterval(this.decayTimer); this.decayTimer = null; }

    // Read the configured interval from guild config
    const config = await this.getConfig(guildId);
    const intervalHours = config?.economy_pet_decay_interval_hours ?? 1;
    const intervalMs = intervalHours * 60 * 60 * 1000;

    // Initial decay after 5 minutes (let bot fully boot)
    setTimeout(() => {
      this.runDecayCycle(guildId).catch(console.error);
    }, 5 * 60 * 1000);

    this.decayTimer = setInterval(() => {
      this.runDecayCycle(guildId).catch(console.error);
    }, intervalMs);
  }

  stopDecayTimer(): void {
    if (this.decayTimer) { clearInterval(this.decayTimer); this.decayTimer = null; }
  }

  private async runDecayCycle(guildId: string): Promise<void> {
    try {
      const config = await this.getConfig(guildId);
      if (!config?.economy_pets_enabled) return;

      const decayRate = config.economy_pet_decay_rate ?? 5;
      const threshold = config.economy_pet_low_stat_threshold ?? 20;
      const shouldNotify = config.economy_pet_notify_owner ?? true;

      // Get all pets for this guild
      const { data: pets } = await (this.supabase as any)
        .from('economy_pets')
        .select('id, guild_id, user_id, name, hunger, happiness, energy, status')
        .eq('guild_id', guildId);

      if (!pets || pets.length === 0) return;

      for (const pet of pets) {
        const newHunger = Math.max(0, pet.hunger - decayRate);
        const newHappiness = Math.max(0, pet.happiness - Math.floor(decayRate * 0.8));
        const newEnergy = Math.min(100, pet.energy + Math.floor(decayRate * 0.5)); // Energy recovers slowly

        // Determine status
        let newStatus: string;
        if (newHunger === 0 || newHappiness === 0) {
          newStatus = 'sick';
        } else if (newHunger <= threshold || newHappiness <= threshold) {
          newStatus = 'sad';
        } else {
          newStatus = 'happy';
        }

        await (this.supabase as any).from('economy_pets').update({
          hunger: newHunger,
          happiness: newHappiness,
          energy: newEnergy,
          status: newStatus,
          updated_at: new Date().toISOString(),
        }).eq('id', pet.id);

        // Notify owner if pet is getting low and wasn't already sad/sick
        if (shouldNotify && this.client && pet.status === 'happy' && (newStatus === 'sad' || newStatus === 'sick')) {
          try {
            const user = await this.client.users.fetch(pet.user_id).catch(() => null);
            if (user) {
              const emoji = newStatus === 'sick' ? '🤒' : '😢';
              await user.send({
                embeds: [new EmbedBuilder()
                  .setTitle(`${emoji} ${pet.name} needs attention!`)
                  .setDescription(
                    `Your pet is feeling **${newStatus}**!\n\n` +
                    `🍖 Hunger: **${newHunger}/100**\n` +
                    `😄 Happiness: **${newHappiness}/100**\n\n` +
                    `Use \`/pet feed\` and \`/pet play\` to cheer them up!`
                  )
                  .setColor(newStatus === 'sick' ? 0xED4245 : 0xFEE75C)],
              }).catch(() => {}); // Ignore DM failures (user may have DMs disabled)
            }
          } catch {
            // Ignore notification failures
          }
        }
      }

      console.log(`[PetDecay] Processed ${pets.length} pets (decay=${decayRate}, guild=${guildId})`);
    } catch (err) {
      console.error('[PetDecay] Decay cycle error:', err);
    }
  }

  private async getConfig(guildId: string): Promise<DbGuildConfig | null> {
    const cached = this.configCache.get(guildId);
    if (cached) return cached;
    const { data } = await (this.supabase as any).from('guild_config').select('*').eq('guild_id', guildId).single();
    if (data) this.configCache.set(guildId, data);
    return data;
  }

  private async getPet(guildId: string, userId: string): Promise<any> {
    const { data } = await (this.supabase as any)
      .from('economy_pets').select('*').eq('guild_id', guildId).eq('user_id', userId).single();
    return data;
  }

  private async ensureEnabled(interaction: ChatInputCommandInteraction): Promise<boolean> {
    const config = await this.getConfig(interaction.guildId!);
    if (!config?.economy_pets_enabled) {
      await interaction.reply({ content: '🚫 Pets are not enabled on this server.', ephemeral: true });
      return false;
    }
    return true;
  }

  async viewPet(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.ensureEnabled(interaction))) return;
    const target = interaction.options.getUser('user') ?? interaction.user;
    const pet = await this.getPet(interaction.guildId!, target.id);

    if (!pet) {
      await interaction.reply({ content: `${target.id === interaction.user.id ? 'You don\'t' : 'They don\'t'} have a pet! Use \`/pet buy\` to get one.`, ephemeral: true });
      return;
    }

    const info = PET_TYPES[pet.pet_type] ?? { emoji: '🐾', desc: 'Unknown' };
    const statusEmoji = pet.status === 'happy' ? '😊' : pet.status === 'sad' ? '😢' : '😐';

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`${info.emoji} ${pet.name}`)
        .setDescription(`*${info.desc}*`)
        .addFields(
          { name: 'Level', value: `${pet.level}/${MAX_LEVEL} (${pet.xp} XP)`, inline: true },
          { name: 'Prestige', value: `⭐ ${pet.prestige}`, inline: true },
          { name: 'Status', value: `${statusEmoji} ${pet.status}`, inline: true },
          { name: '❤️ Health', value: `${pet.health}`, inline: true },
          { name: '⚔️ Attack', value: `${pet.attack}`, inline: true },
          { name: '🛡️ Defense', value: `${pet.defense}`, inline: true },
          { name: '💨 Speed', value: `${pet.speed}`, inline: true },
          { name: '🍖 Hunger', value: `${pet.hunger}/100`, inline: true },
          { name: '😄 Happiness', value: `${pet.happiness}/100`, inline: true },
          { name: '⚡ Energy', value: `${pet.energy}/100`, inline: true },
        )
        .setColor(pet.status === 'happy' ? 0x57F287 : 0xED4245)
        .setFooter({ text: `Type: ${pet.pet_type} • Owner: ${target.username}` })],
    });
  }

  async buyPet(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.ensureEnabled(interaction))) return;
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;
    const petType = interaction.options.getString('type') ?? 'hunting';

    const existing = await this.getPet(guildId, userId);
    if (existing) {
      await interaction.reply({ content: '❌ You already have a pet! One pet per person.', ephemeral: true });
      return;
    }

    const price = PET_PRICES[petType] ?? 5000;
    const { data: wallet } = await (this.supabase as any)
      .from('economy_wallets').select('wallet').eq('guild_id', guildId).eq('user_id', userId).single();

    if (!wallet || wallet.wallet < price) {
      await interaction.reply({ content: `❌ You need **${price.toLocaleString()}** coins. Check your /balance.`, ephemeral: true });
      return;
    }

    await (this.supabase as any).rpc('economy_subtract_balance', {
      p_guild_id: guildId, p_user_id: userId, p_amount: price,
    }).catch(() => {});

    const info = PET_TYPES[petType] ?? { emoji: '🐾', desc: '' };
    await (this.supabase as any).from('economy_pets').insert({
      guild_id: guildId, user_id: userId, pet_type: petType, name: `${info.emoji} Pet`,
    });

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`${info.emoji} New Pet!`)
        .setDescription(`You bought a **${petType}** pet for **${price.toLocaleString()}** coins!\nUse \`/pet rename\` to name it.`)
        .setColor(0x57F287)],
    });
  }

  async feedPet(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.ensureEnabled(interaction))) return;
    const guildId = interaction.guildId!;
    const config = await this.getConfig(guildId);
    const cost = config?.economy_pet_feed_cost ?? 50;
    const pet = await this.getPet(guildId, interaction.user.id);

    if (!pet) { await interaction.reply({ content: '❌ You don\'t have a pet!', ephemeral: true }); return; }
    if (pet.hunger >= 100) { await interaction.reply({ content: '🍖 Your pet is already full!', ephemeral: true }); return; }

    // Check balance before deducting
    const { data: feedWallet } = await (this.supabase as any)
      .from('economy_wallets').select('wallet')
      .eq('guild_id', guildId).eq('user_id', interaction.user.id).single();

    if (!feedWallet || feedWallet.wallet < cost) {
      await interaction.reply({ content: `❌ You need **${cost.toLocaleString()}** coins to feed your pet.`, ephemeral: true });
      return;
    }

    await (this.supabase as any).rpc('economy_subtract_balance', {
      p_guild_id: guildId, p_user_id: interaction.user.id, p_amount: cost,
    }).catch(() => {});

    const newHunger = Math.min(100, pet.hunger + 30);
    const newStatus = newHunger > 30 && pet.happiness > 30 ? 'happy' : 'sad';
    await (this.supabase as any).from('economy_pets')
      .update({ hunger: newHunger, status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', pet.id);

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🍖 Pet Fed!')
        .setDescription(`${pet.name} ate happily! Hunger: ${pet.hunger} → ${newHunger}/100\nCost: **${cost}** coins`)
        .setColor(0x57F287)],
    });
  }

  async playWithPet(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.ensureEnabled(interaction))) return;
    const pet = await this.getPet(interaction.guildId!, interaction.user.id);
    if (!pet) { await interaction.reply({ content: '❌ You don\'t have a pet!', ephemeral: true }); return; }

    const newHappiness = Math.min(100, pet.happiness + 25);
    const newEnergy = Math.max(0, pet.energy - 10);
    const newStatus = pet.hunger > 30 && newHappiness > 30 ? 'happy' : 'sad';
    await (this.supabase as any).from('economy_pets')
      .update({ happiness: newHappiness, energy: newEnergy, status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', pet.id);

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('🎾 Playtime!')
        .setDescription(`${pet.name} loved playing! Happiness: ${pet.happiness} → ${newHappiness}/100`)
        .setColor(0x57F287)],
    });
  }

  async trainPet(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.ensureEnabled(interaction))) return;
    const guildId = interaction.guildId!;
    const config = await this.getConfig(guildId);
    const cost = config?.economy_pet_train_cost ?? 100;
    const pet = await this.getPet(guildId, interaction.user.id);

    if (!pet) { await interaction.reply({ content: '❌ You don\'t have a pet!', ephemeral: true }); return; }
    if (pet.energy < 20) { await interaction.reply({ content: '⚡ Your pet needs more energy! Wait or play with it.', ephemeral: true }); return; }
    if (pet.level >= MAX_LEVEL) { await interaction.reply({ content: '🎓 Your pet is at max level! Try `/pet prestige`.', ephemeral: true }); return; }

    // Check balance before deducting
    const { data: trainWallet } = await (this.supabase as any)
      .from('economy_wallets').select('wallet')
      .eq('guild_id', guildId).eq('user_id', interaction.user.id).single();

    if (!trainWallet || trainWallet.wallet < cost) {
      await interaction.reply({ content: `❌ You need **${cost.toLocaleString()}** coins to train your pet.`, ephemeral: true });
      return;
    }

    await (this.supabase as any).rpc('economy_subtract_balance', {
      p_guild_id: guildId, p_user_id: interaction.user.id, p_amount: cost,
    }).catch(() => {});

    const xpGain = 20 + Math.floor(Math.random() * 15);
    const newXp = pet.xp + xpGain;
    const newLevel = Math.min(MAX_LEVEL, Math.floor(newXp / XP_PER_LEVEL) + 1);
    const leveledUp = newLevel > pet.level;

    const updates: Record<string, any> = {
      xp: newXp,
      level: newLevel,
      energy: Math.max(0, pet.energy - 20),
      updated_at: new Date().toISOString(),
    };

    // Auto-assign stat point every 5 levels
    if (leveledUp && newLevel % 5 === 0) {
      const stats = ['attack', 'defense', 'speed', 'health'];
      const stat = stats[Math.floor(Math.random() * stats.length)];
      updates[stat] = pet[stat] + 1;
    }

    await (this.supabase as any).from('economy_pets').update(updates).eq('id', pet.id);

    let desc = `${pet.name} trained hard! +${xpGain} XP (${newXp} total)\nCost: **${cost}** coins`;
    if (leveledUp) desc += `\n🎉 *Level up! Now level ${newLevel}!*`;

    await interaction.reply({
      embeds: [new EmbedBuilder().setTitle('💪 Training Complete!').setDescription(desc).setColor(0x57F287)],
    });
  }

  async renamePet(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.ensureEnabled(interaction))) return;
    const name = interaction.options.getString('name')!;
    const pet = await this.getPet(interaction.guildId!, interaction.user.id);
    if (!pet) { await interaction.reply({ content: '❌ You don\'t have a pet!', ephemeral: true }); return; }

    await (this.supabase as any).from('economy_pets')
      .update({ name, updated_at: new Date().toISOString() }).eq('id', pet.id);

    await interaction.reply({ content: `✅ Your pet is now named **${name}**!` });
  }

  async battlePet(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.ensureEnabled(interaction))) return;
    const guildId = interaction.guildId!;
    const config = await this.getConfig(guildId);
    if (!config?.economy_pet_battle_enabled) {
      await interaction.reply({ content: '🚫 Pet battles are not enabled.', ephemeral: true });
      return;
    }
    const opponent = interaction.options.getUser('user')!;
    if (opponent.id === interaction.user.id) {
      await interaction.reply({ content: '❌ You can\'t battle yourself!', ephemeral: true }); return;
    }

    const myPet = await this.getPet(guildId, interaction.user.id);
    const theirPet = await this.getPet(guildId, opponent.id);

    if (!myPet) { await interaction.reply({ content: '❌ You don\'t have a pet!', ephemeral: true }); return; }
    if (!theirPet) { await interaction.reply({ content: '❌ They don\'t have a pet!', ephemeral: true }); return; }
    if (myPet.status === 'sad' || myPet.status === 'sick') {
      const emoji = myPet.status === 'sick' ? '🤒' : '😢';
      await interaction.reply({ content: `${emoji} Your pet is too ${myPet.status} to battle! Take care of it first.`, ephemeral: true });
      return;
    }

    // Simple battle calc
    const myPower = myPet.attack * 2 + myPet.speed + myPet.health + Math.random() * 10;
    const theirPower = theirPet.attack * 2 + theirPet.speed + theirPet.health + Math.random() * 10;
    const iWin = myPower > theirPower;
    const reward = 100 + myPet.level * 10;

    await (this.supabase as any).from('economy_pet_battles').insert({
      guild_id: guildId,
      challenger_id: interaction.user.id,
      defender_id: opponent.id,
      winner_id: iWin ? interaction.user.id : opponent.id,
      challenger_dmg: Math.floor(myPower),
      defender_dmg: Math.floor(theirPower),
      reward,
    });

    const battleWinnerId = iWin ? interaction.user.id : opponent.id;
    await (this.supabase as any).rpc('economy_add_balance', {
      p_guild_id: guildId, p_user_id: battleWinnerId, p_amount: reward,
    }).catch(() => {});

    // XP for both
    for (const [pet, uid] of [[myPet, interaction.user.id], [theirPet, opponent.id]] as const) {
      await (this.supabase as any).from('economy_pets')
        .update({ xp: (pet as any).xp + 10, updated_at: new Date().toISOString() })
        .eq('guild_id', guildId).eq('user_id', uid);
    }

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle('⚔️ Pet Battle!')
        .setDescription(
          `**${myPet.name}** (Lv.${myPet.level}) vs **${theirPet.name}** (Lv.${theirPet.level})\n\n` +
          `${iWin ? `🏆 **${myPet.name}** wins!` : `💀 **${theirPet.name}** wins!`}\n` +
          (iWin ? `+**${reward}** coins to ${interaction.user}` : `+**${reward}** coins to ${opponent}`)
        )
        .setColor(iWin ? 0x57F287 : 0xED4245)],
    });
  }

  async prestigePet(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!(await this.ensureEnabled(interaction))) return;
    const guildId = interaction.guildId!;
    const config = await this.getConfig(guildId);
    if (!config?.economy_pet_prestige_enabled) {
      await interaction.reply({ content: '❌ Pet prestige is not enabled.', ephemeral: true }); return;
    }

    const pet = await this.getPet(guildId, interaction.user.id);
    if (!pet) { await interaction.reply({ content: '❌ You don\'t have a pet!', ephemeral: true }); return; }
    if (pet.level < MAX_LEVEL) {
      await interaction.reply({ content: `❌ Your pet must be level ${MAX_LEVEL} to prestige.`, ephemeral: true }); return;
    }

    const newPrestige = pet.prestige + 1;
    await (this.supabase as any).from('economy_pets').update({
      level: 1, xp: 0, prestige: newPrestige,
      attack: pet.attack + 1, defense: pet.defense + 1,
      speed: pet.speed + 1, health: pet.health + 2,
      updated_at: new Date().toISOString(),
    }).eq('id', pet.id);

    await interaction.reply({
      embeds: [new EmbedBuilder()
        .setTitle(`⭐ Pet Prestige ${newPrestige}!`)
        .setDescription(`${pet.name} has been reborn stronger!\nLevel reset to 1, but permanent stat bonuses applied.\n+1 ATK, +1 DEF, +1 SPD, +2 HP`)
        .setColor(0xF1C40F)],
    });
  }
}
