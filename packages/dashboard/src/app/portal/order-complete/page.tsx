/**
 * Public purchase-confirmation page — PayPal `return_url` target.
 *
 * Lives under `/portal` because the middleware already treats that prefix as
 * sessionless-public; no admin surface is made public to reach it. Shows no
 * customer-specific data (the URL is guessable) — see
 * `components/portal/checkout-outcome.tsx`.
 */
import { CheckoutComplete } from '@/components/portal/checkout-outcome';

export const metadata = {
  title: 'Payment received — SomniBot',
  description: 'Your purchase went through. Here is what happens next.',
};

export default function OrderCompletePage() {
  return <CheckoutComplete />;
}
