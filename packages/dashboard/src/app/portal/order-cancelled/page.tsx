/**
 * Public checkout-cancelled page — PayPal `cancel_url` target.
 *
 * Same public-by-prefix reasoning as `order-complete`. Its one job is to tell an
 * unauthenticated buyer, unambiguously, that no money was taken.
 */
import { CheckoutCancelled } from '@/components/portal/checkout-outcome';

export const metadata = {
  title: 'Checkout cancelled — SomniBot',
  description: 'Your checkout was cancelled and you have not been charged.',
};

export default function OrderCancelledPage() {
  return <CheckoutCancelled />;
}
