/**
 * Receipt Builder — Creates Components v2 receipt DMs for customers.
 *
 * Architecture doc §31.2 — container with accent color, order details, license key.
 */
import {
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  EmbedBuilder,
  type User,
} from 'discord.js';
import { createLogger } from '@somnibot/shared';
import {
  applyBrand,
  defaultBrandKit,
  intentColor,
  type BrandKit,
} from '../branding/index.js';

const log = createLogger('ReceiptBuilder');

interface ReceiptData {
  orderNumber: string;
  productName: string;
  amountCents: number;
  currency: string;
  licenseKey: string | null; // Plaintext — shown once
  date: Date;
}

/**
 * Build a Components v2 receipt for DM delivery.
 *
 * Falls back to standard embed if Components v2 isn't available.
 *
 * Buyer-facing: framed with the owner's white-label kit (brand primary color,
 * brand-name footer, powered-by attribution per the owner toggle). Callers
 * that cannot resolve a kit fall back to the vendor defaults.
 */
export function buildReceiptEmbed(data: ReceiptData, kit: BrandKit = defaultBrandKit()): EmbedBuilder {
  const amount = (data.amountCents / 100).toFixed(2);
  const dateStr = data.date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const embed = new EmbedBuilder()
    .setTitle('🧾 Order Confirmed')
    .addFields(
      { name: 'Order', value: data.orderNumber, inline: true },
      { name: 'Product', value: data.productName, inline: true },
      { name: 'Amount', value: `$${amount} ${data.currency}`, inline: true },
      { name: 'Date', value: dateStr, inline: true },
    );

  if (data.licenseKey) {
    embed.addFields(
      { name: '\u200B', value: '─'.repeat(30) },
      { name: '🔑 Your License Key', value: `\`${data.licenseKey}\`` },
      {
        name: '⚠️ Important',
        value: '**Save this key!** It will not be shown again.',
      },
      { name: '\u200B', value: '─'.repeat(30) },
      {
        name: 'Activation',
        value: `Use \`/license activate ${data.licenseKey}\` in the server to activate.`,
      },
    );
  }

  embed.setFooter({ text: `${kit.brandName} Commerce` });
  embed.setTimestamp(data.date);

  return applyBrand(embed, kit, { intent: 'primary' });
}

/**
 * Try to build Components v2 receipt container.
 * Falls back to standard embed if container APIs aren't available.
 */
export function buildReceiptComponents(
  data: ReceiptData,
  kit: BrandKit = defaultBrandKit(),
): ContainerBuilder | null {
  try {
    const amount = (data.amountCents / 100).toFixed(2);
    const dateStr = data.date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });

    const container = new ContainerBuilder()
      .setAccentColor(intentColor(kit, 'primary'))
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent('🧾 **Order Confirmed**'),
      )
      .addSeparatorComponents(
        new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**Order:** ${data.orderNumber}`),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**Product:** ${data.productName}`),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**Amount:** $${amount} ${data.currency}`),
      )
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`**Date:** ${dateStr}`),
      );

    if (data.licenseKey) {
      container
        .addSeparatorComponents(
          new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent('**Your License Key:**'),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(`\`${data.licenseKey}\``),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(''),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent('⚠️ **Save this key!** It will not be shown again.'),
        )
        .addSeparatorComponents(
          new SeparatorBuilder().setSpacing(SeparatorSpacingSize.Small),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `To activate: \`/license activate ${data.licenseKey}\``,
          ),
        );
    }

    return container;
  } catch {
    // Components v2 not fully available — caller should fall back to embed
    return null;
  }
}

/**
 * Prepare one deterministic receipt send.
 *
 * All local construction and Discord channel lookup complete before the
 * returned function can perform the external send. The returned function makes
 * exactly one Discord API call. This matters for crash-fenced commerce:
 * retrying a different payload after an ambiguous send response can deliver
 * the same receipt twice.
 */
export async function prepareReceiptDM(
  user: User,
  data: ReceiptData,
  kit: BrandKit = defaultBrandKit(),
): Promise<() => Promise<void>> {
  const dm = await user.createDM();
  const embed = buildReceiptEmbed(data, kit);
  const payload: Parameters<typeof dm.send>[0] = { embeds: [embed] };

  return async () => {
    await dm.send(payload);
  };
}

/**
 * Deliver the receipt DM to a user with exactly one external send attempt.
 *
 * Throws on preparation or delivery failure so callers can classify the error
 * and route it to the appropriate retry/manual-review boundary.
 */
export async function deliverReceiptDM(
  user: User,
  data: ReceiptData,
  kit: BrandKit = defaultBrandKit(),
): Promise<void> {
  const deliver = await prepareReceiptDM(user, data, kit);
  await deliver();
}

/**
 * Send a receipt DM to a user.
 * Swallows errors — use deliverReceiptDM when the caller needs to classify
 * and handle delivery failures.
 */
export async function sendReceiptDM(
  user: User,
  data: ReceiptData,
  kit: BrandKit = defaultBrandKit(),
): Promise<boolean> {
  try {
    await deliverReceiptDM(user, data, kit);
    return true;
  } catch (err) {
    log.error(`Failed to DM receipt to ${user.id}:`, err);
    return false;
  }
}
