#!/bin/bash
# Runtime gate report — what ACTUALLY gates, not what could.
#
# scripts/gate-audit.mjs counts ctx.gate() call sites in source, which
# over-counts badly: a call site inside `if (!capability)` never fires when the
# capability is present. The runner logs every real gate to stderr as
# "[scenario-runner][GATED] <domain>/<scenario> <class> via <channel>: <reason>",
# so capturing stderr gives the true distribution and shows which reasons are
# worth engineering away.
#
# Usage: bash gate-report.sh [domain ...]   (no args = all 46)
set -u

DOMAINS="${*:-community-giveaways community-levels community-polls-predictions community-profiles community-reaction-roles community-scheduled-messages community-starboard community-statistics-channels community-temporary-channels community-welcome-onboarding game-economy-achievements-prestige game-economy-adventures game-economy-casino game-economy-crafting game-economy-farming game-economy-fishing game-economy-gathering game-economy-heist game-economy-lottery game-economy-pets game-economy-quests game-economy-shop-market game-economy-trivia game-economy-wallet-rewards moderation-anti-raid moderation-automod moderation-infractions-appeals moderation-message-logging moderation-tickets-transcripts music-collaborative-queue music-player-fairness commerce-fraud commerce-licenses commerce-paypal commerce-portal commerce-product-store administration-audit administration-automations administration-custom-commands administration-diagnostics administration-incidents administration-rbac administration-server-sync administration-team-management infrastructure-launcher infrastructure-license-sdk}"

: > gate-lines.txt
for d in $DOMAINS; do
  node run-one-domain.mjs "$d" 2>>gate-lines.txt >/dev/null
done

grep -o '\[scenario-runner\]\[GATED\].*' gate-lines.txt \
  | sed 's/.*: //' \
  | sort | uniq -c | sort -rn > gate-reasons.txt

echo "TOTAL GATES: $(grep -c 'scenario-runner..GATED' gate-lines.txt)"
echo "DISTINCT REASONS: $(wc -l < gate-reasons.txt)"
echo
head -40 gate-reasons.txt
