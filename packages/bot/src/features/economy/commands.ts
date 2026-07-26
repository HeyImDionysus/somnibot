/**
 * Economy slash commands — all fake-economy interactions.
 *
 * Commands: /balance, /daily, /weekly, /monthly, /work, /crime, /beg, /search,
 * /deposit, /withdraw, /pay, /rob, /passive, /shop, /buy, /sell, /inventory,
 * /use, /economy-leaderboard
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type SlashCommandSubcommandBuilder,
} from 'discord.js';
import type { SomniClient } from '../../client.js';
import type { EconomyManager } from './economy-manager.js';
import { applyBrand, defaultBrandKit, resolveBrandKit, type BrandKit } from '../branding/index.js';

const COLLECT_INCOME_RPC_TIMEOUT_MS = 8_000;

/** Resolve the guild's white-label brand kit for an economy reply (cached). */
async function brandKitFor(interaction: ChatInputCommandInteraction): Promise<BrandKit> {
  // Decoration must never break the command: resolveBrandKit swallows read
  // failures, but the client/supabase deref has to be guarded too.
  const client = interaction.client as SomniClient | undefined;
  const supabase = client?.supabase;
  if (!supabase) return defaultBrandKit(interaction.guild?.name);
  return resolveBrandKit(supabase, interaction.guildId!, {
    fallbackName: interaction.guild?.name,
  });
}

type RoleIncomeRpcResult = {
  status: 'credited' | 'cooldown' | 'no_eligible_roles' | 'verification_unavailable';
  amount_cents: number;
  balance_cents: number | null;
  credited_role_ids: string[];
  blocked_role_ids: string[];
  next_available_at: string | null;
};

function isRoleIncomeRpcResult(value: unknown): value is RoleIncomeRpcResult {
  if (!value || typeof value !== 'object') return false;

  const result = value as Partial<RoleIncomeRpcResult>;
  return (
    result.status !== undefined
    && ['credited', 'cooldown', 'no_eligible_roles', 'verification_unavailable'].includes(result.status)
    && typeof result.amount_cents === 'number'
    && Number.isFinite(result.amount_cents)
    && (result.balance_cents === null
      || (typeof result.balance_cents === 'number' && Number.isFinite(result.balance_cents)))
    && Array.isArray(result.credited_role_ids)
    && result.credited_role_ids.every((roleId) => typeof roleId === 'string')
    && Array.isArray(result.blocked_role_ids)
    && result.blocked_role_ids.every((roleId) => typeof roleId === 'string')
    && (result.next_available_at === null || typeof result.next_available_at === 'string')
  );
}

// ── Command builders ──────────────────────────────────────

export function buildEconomyCommands() {
  const balanceCmd = new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Check your wallet and bank balance')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('User to check (leave empty for yourself)').setRequired(false),
    );

  const dailyCmd = new SlashCommandBuilder()
    .setName('daily')
    .setDescription('Claim your daily reward');

  const weeklyCmd = new SlashCommandBuilder()
    .setName('weekly')
    .setDescription('Claim your weekly reward');

  const monthlyCmd = new SlashCommandBuilder()
    .setName('monthly')
    .setDescription('Claim your monthly reward');

  const workCmd = new SlashCommandBuilder()
    .setName('work')
    .setDescription('Work a job to earn some coins');

  const crimeCmd = new SlashCommandBuilder()
    .setName('crime')
    .setDescription('Attempt a crime for big rewards — but risk a fine');

  const begCmd = new SlashCommandBuilder()
    .setName('beg')
    .setDescription('Beg for spare change');

  const searchCmd = new SlashCommandBuilder()
    .setName('search')
    .setDescription('Search random places for coins');

  const depositCmd = new SlashCommandBuilder()
    .setName('deposit')
    .setDescription('Deposit coins into your bank')
    .addIntegerOption((opt) =>
      opt.setName('amount').setDescription('Amount to deposit (leave empty to deposit all)').setRequired(false).setMinValue(1),
    );

  const withdrawCmd = new SlashCommandBuilder()
    .setName('withdraw')
    .setDescription('Withdraw coins from your bank')
    .addIntegerOption((opt) =>
      opt.setName('amount').setDescription('Amount to withdraw (leave empty to withdraw all)').setRequired(false).setMinValue(1),
    );

  const payCmd = new SlashCommandBuilder()
    .setName('pay')
    .setDescription('Send coins to another user')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('User to pay').setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt.setName('amount').setDescription('Amount to send').setRequired(true).setMinValue(1),
    );

  const robCmd = new SlashCommandBuilder()
    .setName('rob')
    .setDescription('Attempt to rob another user')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('User to rob').setRequired(true),
    );

  const passiveCmd = new SlashCommandBuilder()
    .setName('passive')
    .setDescription('Toggle passive mode (protection from robbery)');

  const shopCmd = new SlashCommandBuilder()
    .setName('shop')
    .setDescription('Browse the server shop')
    .addStringOption((opt) =>
      opt.setName('category').setDescription('Filter by category').setRequired(false)
        .addChoices(
          // Canonical shop categories — keep in sync with the dashboard shop
          // page (economy/shop/page.tsx CATEGORIES) and the categories used by
          // the content seeder and crafting outputs. Discord caps choices at
          // 25; currently 11.
          { name: 'Tools', value: 'Tools' },
          { name: 'Protection', value: 'Protection' },
          { name: 'Farming', value: 'Farming' },
          { name: 'Accessories', value: 'Accessories' },
          { name: 'Bait', value: 'Bait' },
          { name: 'Seeds', value: 'Seeds' },
          { name: 'Materials', value: 'Materials' },
          { name: 'Consumables', value: 'Consumables' },
          { name: 'Roles', value: 'Roles' },
          { name: 'Cosmetics', value: 'Cosmetics' },
          { name: 'Lootboxes', value: 'Lootboxes' },
        ),
    );

  const buyCmd = new SlashCommandBuilder()
    .setName('buy')
    .setDescription('Buy an item from the shop')
    .addStringOption((opt) =>
      opt.setName('item').setDescription('Item name or ID').setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt.setName('quantity').setDescription('How many to buy').setRequired(false).setMinValue(1).setMaxValue(99),
    );

  const sellCmd = new SlashCommandBuilder()
    .setName('sell')
    .setDescription('Sell an item from your inventory')
    .addStringOption((opt) =>
      opt.setName('item').setDescription('Item name or ID').setRequired(true),
    )
    .addIntegerOption((opt) =>
      opt.setName('quantity').setDescription('How many to sell').setRequired(false).setMinValue(1).setMaxValue(99),
    );

  const inventoryCmd = new SlashCommandBuilder()
    .setName('inventory')
    .setDescription('View your item inventory')
    .addUserOption((opt) =>
      opt.setName('user').setDescription('User to check (leave empty for yourself)').setRequired(false),
    );

  const useCmd = new SlashCommandBuilder()
    .setName('use')
    .setDescription('Use an item from your inventory')
    .addStringOption((opt) =>
      opt.setName('item').setDescription('Item name or ID').setRequired(true),
    );

  const econLeaderboardCmd = new SlashCommandBuilder()
    .setName('economy-leaderboard')
    .setDescription('View the richest members');

  const collectCmd = new SlashCommandBuilder()
    .setName('collect-income')
    .setDescription('Collect your role-based passive income');

  return {
    balanceCmd,
    dailyCmd,
    weeklyCmd,
    monthlyCmd,
    workCmd,
    crimeCmd,
    begCmd,
    searchCmd,
    depositCmd,
    withdrawCmd,
    payCmd,
    robCmd,
    passiveCmd,
    shopCmd,
    buyCmd,
    sellCmd,
    inventoryCmd,
    useCmd,
    econLeaderboardCmd,
    collectCmd,
  };
}

// ── Command handlers ──────────────────────────────────────

export async function handleEconomyCommand(
  interaction: ChatInputCommandInteraction,
  economyManager: EconomyManager,
): Promise<void> {
  const cfg = await economyManager.loadConfig();
  if (!cfg.economy_enabled) {
    await interaction.reply({ content: '🚫 The economy system is not enabled on this server.', ephemeral: true });
    return;
  }

  const cmd = interaction.commandName;

  switch (cmd) {
    case 'balance': return handleBalance(interaction, economyManager);
    case 'daily': return handleTimedReward(interaction, economyManager, 'daily');
    case 'weekly': return handleTimedReward(interaction, economyManager, 'weekly');
    case 'monthly': return handleTimedReward(interaction, economyManager, 'monthly');
    case 'work': return handleWork(interaction, economyManager);
    case 'crime': return handleCrime(interaction, economyManager);
    case 'beg': return handleBeg(interaction, economyManager);
    case 'search': return handleSearch(interaction, economyManager);
    case 'deposit': return handleDeposit(interaction, economyManager);
    case 'withdraw': return handleWithdraw(interaction, economyManager);
    case 'pay': return handlePay(interaction, economyManager);
    case 'rob': return handleRob(interaction, economyManager);
    case 'passive': return handlePassive(interaction, economyManager);
    case 'shop': return handleShop(interaction, economyManager);
    case 'buy': return handleBuy(interaction, economyManager);
    case 'sell': return handleSell(interaction, economyManager);
    case 'inventory': return handleInventory(interaction, economyManager);
    case 'use': return handleUse(interaction, economyManager);
    case 'economy-leaderboard': return handleEconLeaderboard(interaction, economyManager);
    case 'collect-income': return handleCollectIncome(interaction, economyManager);
    default:
      await interaction.reply({ content: '❌ Unknown economy command.', ephemeral: true });
  }
}

// ── Individual handlers ───────────────────────────────────

async function handleBalance(
  interaction: ChatInputCommandInteraction,
  mgr: EconomyManager,
): Promise<void> {
  const user = interaction.options.getUser('user') ?? interaction.user;
  const cfg = await mgr.loadConfig();
  const wallet = await mgr.getOrCreateWallet(user.id);

  // [game-economy-wallet-rewards DEPFAIL] A `degraded` wallet is the
  // non-throwing fallback fabricated when the database was unreachable — NOT
  // the member's real balance. Rendering it would tell the member a
  // data-shaped lie ("wallet: 0") about state the bot could not read; degrade
  // with the branded wallet-unavailable notice instead.
  if (wallet.degraded) {
    await interaction.reply({ content: await mgr.walletUnavailableMessage('wallet') });
    return;
  }

  const netWorth = wallet.wallet + wallet.bank;

  const kit = await brandKitFor(interaction);
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${user.displayName}'s Balance`, iconURL: user.displayAvatarURL() })
    .addFields(
      { name: '💰 Wallet', value: `${cfg.currency_emoji} ${wallet.wallet.toLocaleString()}`, inline: true },
      { name: '🏦 Bank', value: `${cfg.currency_emoji} ${wallet.bank.toLocaleString()} / ${wallet.bank_max.toLocaleString()}`, inline: true },
      { name: '📊 Net Worth', value: `${cfg.currency_emoji} ${netWorth.toLocaleString()}`, inline: true },
    )
    .setFooter({ text: wallet.passive ? '🛡️ Passive mode enabled' : '⚔️ Passive mode disabled' })
    .setTimestamp();
  applyBrand(embed, kit, { intent: 'info' });

  // V53 Phase 3 (3.4): Quick action buttons
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('econ_daily')
      .setLabel('Daily')
      .setEmoji('📅')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('econ_inventory')
      .setLabel('Inventory')
      .setEmoji('🎒')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('econ_shop')
      .setLabel('Shop')
      .setEmoji('🛒')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('econ_timers')
      .setLabel('Timers')
      .setEmoji('⏱️')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleTimedReward(
  interaction: ChatInputCommandInteraction,
  mgr: EconomyManager,
  type: 'daily' | 'weekly' | 'monthly',
): Promise<void> {
  await interaction.deferReply();
  const result = await mgr.claimTimedReward(interaction.user.id, type);

  const cfg = await mgr.loadConfig();
  if (result.success) {
    const kit = await brandKitFor(interaction);
    const embed = new EmbedBuilder()
      .setTitle(`${cfg.currency_emoji} ${type.charAt(0).toUpperCase() + type.slice(1)} Reward`)
      .setDescription(result.message)
      .addFields(
        { name: '💰 New Balance', value: `${cfg.currency_emoji} ${result.balance.wallet.toLocaleString()}`, inline: true },
      )
      .setTimestamp();
    applyBrand(embed, kit, { intent: 'primary' });

    if (result.streak) {
      embed.addFields(
        { name: '🔥 Streak', value: `${result.streak.current_streak}`, inline: true },
        { name: '🏆 Best Streak', value: `${result.streak.longest_streak}`, inline: true },
      );
    }

    await interaction.editReply({ embeds: [embed] });
  } else {
    await interaction.editReply({ content: result.message });
  }
}

async function handleWork(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  await interaction.deferReply();
  const result = await mgr.work(interaction.user.id);

  if (result.success) {
    const cfg = await mgr.loadConfig();
    const kit = await brandKitFor(interaction);
    const embed = new EmbedBuilder()
      .setTitle('💼 Work')
      .setDescription(result.message)
      .addFields({ name: '💰 Balance', value: `${cfg.currency_emoji} ${result.balance.wallet.toLocaleString()}`, inline: true })
      .setTimestamp();
    applyBrand(embed, kit, { intent: 'info' });
    await interaction.editReply({ embeds: [embed] });
  } else {
    await interaction.editReply({ content: result.message });
  }
}

async function handleCrime(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  await interaction.deferReply();
  const result = await mgr.crime(interaction.user.id);
  const cfg = await mgr.loadConfig();

  const kit = await brandKitFor(interaction);
  const embed = new EmbedBuilder()
    .setTitle(result.success ? '🎭 Crime — Success!' : '🚨 Crime — Busted!')
    .setDescription(result.message)
    .addFields({ name: '💰 Balance', value: `${cfg.currency_emoji} ${result.balance.wallet.toLocaleString()}`, inline: true })
    .setTimestamp();
  applyBrand(embed, kit, { intent: result.success ? 'primary' : 'danger' });

  await interaction.editReply({ embeds: [embed] });
}

async function handleBeg(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  await interaction.deferReply();
  const result = await mgr.beg(interaction.user.id);
  await interaction.editReply({ content: result.message });
}

async function handleSearch(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  await interaction.deferReply();
  const result = await mgr.search(interaction.user.id);
  await interaction.editReply({ content: result.message });
}

async function handleDeposit(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  await interaction.deferReply();
  const explicitAmount = interaction.options.getInteger('amount');
  // If no amount provided, deposit everything in the wallet
  const amount = explicitAmount ?? (await mgr.getOrCreateWallet(interaction.user.id)).wallet;
  if (amount <= 0) {
    await interaction.editReply({ content: "You don't have anything to deposit." });
    return;
  }
  const result = await mgr.deposit(interaction.user.id, amount);
  await interaction.editReply({ content: result.message });
}

async function handleWithdraw(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  await interaction.deferReply();
  const explicitAmount = interaction.options.getInteger('amount');
  // If no amount provided, withdraw everything in the bank
  const amount = explicitAmount ?? (await mgr.getOrCreateWallet(interaction.user.id)).bank;
  if (amount <= 0) {
    await interaction.editReply({ content: "You don't have anything to withdraw." });
    return;
  }
  const result = await mgr.withdraw(interaction.user.id, amount);
  await interaction.editReply({ content: result.message });
}

async function handlePay(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  const target = interaction.options.getUser('user', true);
  const amount = interaction.options.getInteger('amount', true);

  if (target.bot) {
    await interaction.reply({ content: "❌ You can't pay a bot.", ephemeral: true });
    return;
  }

  // interaction.id is the idempotency key: a redelivered /pay returns the first
  // result and never debits the sender twice.
  const result = await mgr.pay(interaction.user.id, target.id, amount, interaction.id);
  await interaction.reply({ content: result.message, ephemeral: !result.success });
}

async function handleRob(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  const target = interaction.options.getUser('user', true);

  if (target.bot) {
    await interaction.reply({ content: "❌ You can't rob a bot.", ephemeral: true });
    return;
  }

  await interaction.deferReply();
  const result = await mgr.rob(interaction.user.id, target.id);
  const cfg = await mgr.loadConfig();

  const kit = await brandKitFor(interaction);
  const embed = new EmbedBuilder()
    .setTitle(result.success ? '💰 Robbery — Success!' : '🚨 Robbery — Failed!')
    .setDescription(result.message)
    .addFields({ name: '💰 Your Balance', value: `${cfg.currency_emoji} ${result.balance.wallet.toLocaleString()}`, inline: true })
    .setTimestamp();
  applyBrand(embed, kit, { intent: result.success ? 'primary' : 'danger' });

  await interaction.editReply({ embeds: [embed] });
}

async function handlePassive(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const result = await mgr.togglePassive(interaction.user.id);
  await interaction.editReply({ content: result.message });
}

async function handleShop(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  const category = interaction.options.getString('category') ?? undefined;
  const cfg = await mgr.loadConfig();
  const { items, degraded } = await mgr.getShopItemsChecked(category);

  // [game-economy-shop-market DEPFAIL] A FAILED catalog read is not an empty
  // shop: replying "The shop is empty!" during a database outage is a
  // data-shaped lie about a catalog the bot could not read. Degrade honestly.
  if (degraded) {
    await interaction.reply({ content: await mgr.walletUnavailableMessage('shop'), ephemeral: true });
    return;
  }

  if (items.length === 0) {
    // White-label: even the empty-state carries the owner-configured currency
    // (a shop of only craft-earned items lists nothing but is still branded).
    await interaction.reply({
      content: `🏪 The shop is empty — nothing is currently sold for ${cfg.currency_emoji} ${cfg.currency_name}.`,
      ephemeral: true,
    });
    return;
  }

  const lines = items.map((item, i) => {
    const stockStr = item.stock !== null ? ` (${item.stock} left)` : '';
    return `${item.emoji} **${item.name}** — ${cfg.currency_emoji} ${item.price.toLocaleString()}${stockStr}\n> ${item.description ?? 'No description'}`;
  });

  const kit = await brandKitFor(interaction);
  const embed = new EmbedBuilder()
    .setTitle(`🏪 Shop${category ? ` — ${category}` : ''}`)
    .setDescription(lines.join('\n\n'))
    .setFooter({ text: `Use /buy <item> to purchase • ${items.length} items` })
    .setTimestamp();
  applyBrand(embed, kit, { intent: 'warning' });

  // V53 Phase 3 (3.4): Quick action buttons
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('econ_balance')
      .setLabel('Balance')
      .setEmoji('💰')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('econ_inventory')
      .setLabel('Inventory')
      .setEmoji('🎒')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleBuy(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  const itemName = interaction.options.getString('item', true);
  const quantity = interaction.options.getInteger('quantity') ?? 1;

  // Resolve item by name or ID
  const { id: itemId, degraded } = await resolveItemId(mgr, interaction.guildId!, itemName);
  // [game-economy-shop-market DEPFAIL] A FAILED catalog lookup is not "item not
  // found" — that verdict is fabricated during an outage. Nothing was charged.
  if (degraded) {
    await interaction.reply({ content: await mgr.walletUnavailableMessage('shop'), ephemeral: true });
    return;
  }
  if (!itemId) {
    await interaction.reply({ content: `❌ Item "${itemName}" not found. Use \`/shop\` to browse available items.`, ephemeral: true });
    return;
  }

  await interaction.deferReply();
  // interaction.id is the idempotency key: a redelivered /buy charges + delivers once.
  const result = await mgr.buyItem(interaction.user.id, itemId, quantity, interaction.id);
  await interaction.editReply({ content: result.message });
}

async function handleSell(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  const itemName = interaction.options.getString('item', true);
  const quantity = interaction.options.getInteger('quantity') ?? 1;

  const { id: itemId, degraded } = await resolveItemId(mgr, interaction.guildId!, itemName);
  if (degraded) {
    await interaction.reply({ content: await mgr.walletUnavailableMessage('shop'), ephemeral: true });
    return;
  }
  if (!itemId) {
    await interaction.reply({ content: `❌ Item "${itemName}" not found.`, ephemeral: true });
    return;
  }

  await interaction.deferReply();
  const result = await mgr.sellItem(interaction.user.id, itemId, quantity);
  await interaction.editReply({ content: result.message });
}

async function handleInventory(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  const user = interaction.options.getUser('user') ?? interaction.user;
  const items = await mgr.getInventory(user.id);

  if (items.length === 0) {
    await interaction.reply({ content: `📦 ${user.id === interaction.user.id ? 'Your' : `${user.displayName}'s`} inventory is empty.`, ephemeral: true });
    return;
  }

  const lines = items.map((item) => {
    const durStr = item.durability_remaining !== null ? ` [${item.durability_remaining} uses]` : '';
    return `${item.item_emoji} **${item.item_name}** ×${item.quantity}${durStr}`;
  });

  const kit = await brandKitFor(interaction);
  const embed = new EmbedBuilder()
    .setAuthor({ name: `${user.displayName}'s Inventory`, iconURL: user.displayAvatarURL() })
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${items.length} items • Use /use <item> to use an item` })
    .setTimestamp();
  applyBrand(embed, kit, { intent: 'info' });

  // V53 Phase 3 (3.4): Quick action buttons
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('econ_balance')
      .setLabel('Balance')
      .setEmoji('💰')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('econ_shop')
      .setLabel('Shop')
      .setEmoji('🛒')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({ embeds: [embed], components: [row] });
}

async function handleUse(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  await interaction.reply({ content: '🔧 Item usage will be implemented with specific item effects in PR #43+.', ephemeral: true });
}

async function handleEconLeaderboard(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  const cfg = await mgr.loadConfig();
  const leaders = await mgr.getLeaderboard(10);

  if (leaders.length === 0) {
    await interaction.reply({ content: '📊 No one has earned any coins yet!', ephemeral: true });
    return;
  }

  const lines = leaders.map((entry, i) => {
    const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**#${i + 1}**`;
    return `${medal} <@${entry.user_id}> — ${cfg.currency_emoji} ${entry.net_worth.toLocaleString()}`;
  });

  const kit = await brandKitFor(interaction);
  const embed = new EmbedBuilder()
    .setTitle(`${cfg.currency_emoji} Economy Leaderboard`)
    .setDescription(lines.join('\n'))
    .setTimestamp();
  applyBrand(embed, kit, { intent: 'warning' });

  await interaction.reply({ embeds: [embed] });
}

async function handleCollectIncome(interaction: ChatInputCommandInteraction, mgr: EconomyManager): Promise<void> {
  // Discord interactions must be acknowledged within three seconds. The RPC
  // performs every eligibility, cooldown, idempotency, and wallet mutation in
  // one database transaction, so defer before any database work.
  await interaction.deferReply({ ephemeral: true });

  const guildId = interaction.guildId;
  const member = interaction.member;
  if (!guildId || !member || !('roles' in member)) {
    await interaction.editReply({ content: '❌ Could not verify your Discord roles. Please try again.' });
    return;
  }

  const client = interaction.client as SomniClient;
  const discordRoleIds = Array.isArray(member.roles)
    ? member.roles
    : [...member.roles.cache.keys()];
  const abortController = new AbortController();
  let timeoutHandle: NodeJS.Timeout | undefined;

  try {
    const cfg = await mgr.loadConfig();
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        abortController.abort();
        reject(new Error('economy_collect_role_income timed out'));
      }, COLLECT_INCOME_RPC_TIMEOUT_MS);
    });

    const rpc = client.supabase
      .rpc('economy_collect_role_income', {
        p_guild_id: guildId,
        p_user_id: interaction.user.id,
        p_discord_role_ids: discordRoleIds,
        // Discord snowflakes are stable strings. Passing the interaction ID
        // directly lets the database return the same result for a replay.
        p_request_id: interaction.id,
      })
      .abortSignal(abortController.signal);

    const { data, error } = await Promise.race([rpc, timeout]);
    if (error || !isRoleIncomeRpcResult(data)) {
      await interaction.editReply({
        content: '⚠️ Role income verification is temporarily unavailable. Please try again.',
      });
      return;
    }

    switch (data.status) {
      case 'credited': {
        const roleCount = data.credited_role_ids.length;
        const balance = data.balance_cents === null
          ? ''
          : `\n💰 Balance: **${data.balance_cents.toLocaleString()}**`;
        await interaction.editReply({
          content: `${cfg.currency_emoji} Collected **${data.amount_cents.toLocaleString()} ${cfg.currency_name}** from ${roleCount} role${roleCount === 1 ? '' : 's'}!${balance}`,
        });
        return;
      }
      case 'cooldown': {
        const nextAtMs = data.next_available_at === null ? Number.NaN : Date.parse(data.next_available_at);
        const nextAt = Number.isFinite(nextAtMs)
          ? ` Try again <t:${Math.floor(nextAtMs / 1000)}:R>.`
          : '';
        await interaction.editReply({ content: `⏰ Role income is still on cooldown.${nextAt}` });
        return;
      }
      case 'no_eligible_roles':
        await interaction.editReply({ content: '❌ No eligible role income is available for your current Discord roles.' });
        return;
      case 'verification_unavailable':
        await interaction.editReply({
          content: '⚠️ Role income verification is temporarily unavailable. Please try again.',
        });
        return;
    }
  } catch {
    await interaction.editReply({
      content: '⚠️ Role income verification is temporarily unavailable. Please try again.',
    });
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

// ── Helpers ───────────────────────────────────────────────

async function resolveItemId(
  mgr: EconomyManager,
  guildId: string,
  nameOrId: string,
): Promise<{ id: string | null; degraded: boolean }> {
  // Try UUID first
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrId)) {
    return { id: nameOrId, degraded: false };
  }

  // Search by name (case-insensitive). A degraded (failed) catalog read must
  // surface as an outage, never be conflated with "not found".
  const { items, degraded } = await mgr.getShopItemsChecked();
  if (degraded) return { id: null, degraded: true };
  const match = items.find((item) => item.name.toLowerCase() === nameOrId.toLowerCase());
  return { id: match?.id ?? null, degraded: false };
}
