/**
 * Receipt Builder — Unit Tests
 *
 * Tests receipt embed generation for commerce orders.
 */
import { describe, it, expect } from 'vitest';
import { buildReceiptEmbed } from '../features/commerce/receipt-builder.js';

describe('buildReceiptEmbed', () => {
  const baseData = {
    orderNumber: 'ORD-001',
    productName: 'Premium Role',
    amountCents: 999,
    currency: 'USD',
    licenseKey: null as string | null,
    date: new Date('2026-01-15T12:00:00Z'),
  };

  it('creates an embed with order details', () => {
    const embed = buildReceiptEmbed(baseData);
    const json = embed.toJSON();

    expect(json.title).toBe('🧾 Order Confirmed');
    expect(json.color).toBe(0xFF1493); // Hot pink
    expect(json.fields).toBeDefined();

    const fieldMap = Object.fromEntries(json.fields!.map(f => [f.name, f.value]));
    expect(fieldMap['Order']).toBe('ORD-001');
    expect(fieldMap['Product']).toBe('Premium Role');
    expect(fieldMap['Amount']).toBe('$9.99 USD');
  });

  it('formats the date correctly', () => {
    const embed = buildReceiptEmbed(baseData);
    const json = embed.toJSON();
    const dateField = json.fields!.find(f => f.name === 'Date');
    expect(dateField).toBeDefined();
    expect(dateField!.value).toContain('2026');
    expect(dateField!.value).toContain('January');
  });

  it('includes license key when provided', () => {
    const data = { ...baseData, licenseKey: 'SMNI-ABCD-EFGH-JKLM-NPQR' };
    const embed = buildReceiptEmbed(data);
    const json = embed.toJSON();

    const keyField = json.fields!.find(f => f.name === '🔑 Your License Key');
    expect(keyField).toBeDefined();
    expect(keyField!.value).toContain('SMNI-ABCD-EFGH-JKLM-NPQR');
  });

  it('includes activation instructions with license key', () => {
    const data = { ...baseData, licenseKey: 'SMNI-TEST-KEY1-KEY2-KEY3' };
    const embed = buildReceiptEmbed(data);
    const json = embed.toJSON();

    const activationField = json.fields!.find(f => f.name === 'Activation');
    expect(activationField).toBeDefined();
    expect(activationField!.value).toContain('/license activate');
  });

  it('omits license fields when no key provided', () => {
    const embed = buildReceiptEmbed(baseData);
    const json = embed.toJSON();

    const keyField = json.fields!.find(f => f.name === '🔑 Your License Key');
    expect(keyField).toBeUndefined();
  });

  it('includes warning to save the key', () => {
    const data = { ...baseData, licenseKey: 'SMNI-SAVE-THIS-KEY0-NOW0' };
    const embed = buildReceiptEmbed(data);
    const json = embed.toJSON();

    const warningField = json.fields!.find(f => f.name === '⚠️ Important');
    expect(warningField).toBeDefined();
    expect(warningField!.value).toContain('Save this key');
  });

  it('keeps the semantic commerce footer and appends the powered-by attribution', () => {
    // The receipt is a BUYER-facing surface, so it carries attribution — but the
    // footer rule appends, never clobbers, so 'SomniBot Commerce' survives.
    const embed = buildReceiptEmbed(baseData);
    const json = embed.toJSON();
    expect(json.footer?.text).toBe('SomniBot Commerce • Powered by SomniBot');
  });

  it('sets timestamp', () => {
    const embed = buildReceiptEmbed(baseData);
    const json = embed.toJSON();
    expect(json.timestamp).toBeDefined();
  });

  it('handles zero-cent amount', () => {
    const data = { ...baseData, amountCents: 0 };
    const embed = buildReceiptEmbed(data);
    const json = embed.toJSON();
    const amountField = json.fields!.find(f => f.name === 'Amount');
    expect(amountField!.value).toBe('$0.00 USD');
  });

  it('handles large amounts', () => {
    const data = { ...baseData, amountCents: 99999 };
    const embed = buildReceiptEmbed(data);
    const json = embed.toJSON();
    const amountField = json.fields!.find(f => f.name === 'Amount');
    expect(amountField!.value).toBe('$999.99 USD');
  });
});
