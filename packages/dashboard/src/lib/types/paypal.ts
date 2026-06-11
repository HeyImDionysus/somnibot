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
  amount: z.object({
    value: z.string().optional(),
    currency_code: z.string().optional(),
  }).optional(),
  supplementary_data: z.object({
    related_ids: z.object({
      capture_id: z.string().optional(),
    }).optional(),
  }).optional(),
  links: z.array(paypalLinkSchema).optional(),
});

/** V5 Audit §2.1: Zod schema for PayPal sale resources. */
export const paypalSaleResourceSchema = z.object({
  id: z.string(),
  custom_id: z.string().optional(),
  sale_id: z.string().optional(),
  capture_id: z.string().optional(),
  billing_agreement_id: z.string().optional(),
  amount: z.object({
    total: z.string().optional(),
    currency: z.string().optional(),
  }).optional(),
  links: z.array(paypalLinkSchema).optional(),
});

// ── Inferred types from schemas ─────────────────────────────

/** PayPal capture resource (PAYMENT.CAPTURE.COMPLETED / REFUNDED). */
export type PayPalCaptureResource = z.infer<typeof paypalCaptureResourceSchema>;

/** PayPal sale resource (PAYMENT.SALE.*). */
export type PayPalSaleResource = z.infer<typeof paypalSaleResourceSchema>;
