/**
 * PayPal Webhook Resource Types — V5 audit remediation (Finding 1.1, §2.1)
 *
 * V5 Audit §2.1: Interfaces AND Zod schemas for runtime validation.
 * The webhook handler uses `safeParse` on the raw resource payload before
 * accessing nested fields, eliminating `as unknown as` type assertions.
 */

import { z } from 'zod';

/** Link in PayPal HATEOAS responses. */
export interface PayPalLink {
  rel?: string;
  href?: string;
  method?: string;
}

// ── Zod Schemas (runtime validation) ────────────────────────

const paypalLinkSchema = z.object({
  rel: z.string().optional(),
  href: z.string().optional(),
  method: z.string().optional(),
});

/** V5 Audit §2.1: Zod schema for PayPal capture resources. */
export const paypalCaptureResourceSchema = z.object({
  id: z.string(),
  custom_id: z.string().optional(),
  // PayPal v1 capture-refund resources expose their parent capture directly.
  capture_id: z.string().optional(),
  amount: z.object({
    value: z.string().optional(),
    currency_code: z.string().optional(),
    // Deprecated v1 capture-refund money shape.
    total: z.string().optional(),
    currency: z.string().optional(),
  }).optional(),
  // W2 refund semantics: on PAYMENT.CAPTURE.REFUNDED the resource is a v2
  // Refund object whose seller_payable_breakdown carries PayPal's
  // authoritative cumulative refunded total for the parent capture.
  seller_payable_breakdown: z.object({
    total_refunded_amount: z.object({
      value: z.string().optional(),
      currency_code: z.string().optional(),
    }).optional(),
  }).optional(),
  seller_receivable_breakdown: z.object({
    gross_amount: z.object({
      value: z.string().optional(),
      currency_code: z.string().optional(),
    }).optional(),
    paypal_fee: z.object({
      value: z.string().optional(),
      currency_code: z.string().optional(),
    }).optional(),
    net_amount: z.object({
      value: z.string().optional(),
      currency_code: z.string().optional(),
    }).optional(),
  }).optional(),
  supplementary_data: z.object({
    related_ids: z.object({
      capture_id: z.string().optional(),
      order_id: z.string().optional(),
    }).optional(),
  }).optional(),
  // Deprecated v1 capture-refund cumulative money shape.
  total_refunded_amount: z.object({
    value: z.string().optional(),
    currency: z.string().optional(),
  }).optional(),
  links: z.array(paypalLinkSchema).optional(),
});

/** V5 Audit §2.1: Zod schema for PayPal sale resources. */
export const paypalSaleResourceSchema = z.object({
  id: z.string(),
  custom_id: z.string().optional(),
  sale_id: z.string().optional(),
  capture_id: z.string().optional(),
  // A PAYMENT.SALE.REVERSED event can carry the v1 Sale itself rather than
  // a Refund. These fields distinguish that parent resource from a refund
  // resource whose `id` is the refund transaction id.
  state: z.string().optional(),
  status: z.string().optional(),
  reason_code: z.string().optional(),
  parent_payment: z.string().optional(),
  billing_agreement_id: z.string().optional(),
  amount: z.object({
    total: z.string().optional(),
    currency: z.string().optional(),
  }).optional(),
  // W2 refund semantics: v1 sale refund resources carry the cumulative
  // refunded total for the parent sale.
  total_refunded_amount: z.object({
    value: z.string().optional(),
    currency: z.string().optional(),
  }).optional(),
  links: z.array(paypalLinkSchema).optional(),
});

// ── Inferred types from schemas ─────────────────────────────

/** PayPal capture resource (PAYMENT.CAPTURE.COMPLETED / REFUNDED). */
export type PayPalCaptureResource = z.infer<typeof paypalCaptureResourceSchema>;

/** PayPal sale resource (PAYMENT.SALE.*). */
export type PayPalSaleResource = z.infer<typeof paypalSaleResourceSchema>;
