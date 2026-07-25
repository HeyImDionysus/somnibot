#!/bin/bash
# Full 46-domain fleet run — one RESULT line per domain into fleet-results.jsonl
: > fleet-results.jsonl
for d in community-giveaways community-levels community-polls-predictions community-profiles community-reaction-roles community-scheduled-messages community-starboard community-statistics-channels community-temporary-channels community-welcome-onboarding game-economy-achievements-prestige game-economy-adventures game-economy-casino game-economy-crafting game-economy-farming game-economy-fishing game-economy-gathering game-economy-heist game-economy-lottery game-economy-pets game-economy-quests game-economy-shop-market game-economy-trivia game-economy-wallet-rewards moderation-anti-raid moderation-automod moderation-infractions-appeals moderation-message-logging moderation-tickets-transcripts music-collaborative-queue music-player-fairness commerce-fraud commerce-licenses commerce-paypal commerce-portal commerce-product-store administration-audit administration-automations administration-custom-commands administration-diagnostics administration-incidents administration-rbac administration-server-sync administration-team-management infrastructure-launcher infrastructure-license-sdk; do
  node run-one-domain.mjs "$d" 2>/dev/null | grep -E "^RESULT" | sed 's/^RESULT //' >> fleet-results.jsonl
done
echo "FLEET_DONE $(wc -l < fleet-results.jsonl)"
