/**
 * PayPal Webhook Resource Types — V5 audit remediation (Finding 1.1)
 *
 * Replaces `as {}` type assertions with proper interfaces for PayPal
 * webhook `resource` payloads.
 */

/** Link in PayPal HATEOAS responses. */
export interface PayPalLink {
  rel?: string;
  href?: string;
  method?: string;
}

/** PayPal capture resource (PAYMENT.CAPTURE.COMPLETED / REFUNDED). */
export interface PayPalCaptureResource {
  id: string;
  custom_id?: string;
  amount?: { value?: string; currency_code?: string };
  supplementary_data?: { related_ids?: { capture_id?: string } };
  links?: PayPalLink[];
}

/** PayPal sale resource (PAYMENT.SALE.*). */
export interface PayPalSaleResource {
  id: string;
  custom_id?: string;
  billing_agreement_id?: string;
  amount?: { total?: string; currency?: string };
  links?: PayPalLink[];
}
