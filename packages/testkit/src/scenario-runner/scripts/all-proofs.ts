/**
 * scenario-runner/scripts/all-proofs — registry of all 46 domain proofs (catalog order).
 */
import { communityGiveawaysProof } from './community-giveaways.js';
import { communityLevelsProof } from './community-levels.js';
import { communityPollsPredictionsProof } from './community-polls-predictions.js';
import { communityProfilesProof } from './community-profiles.js';
import { communityReactionRolesProof } from './community-reaction-roles.js';
import { communityScheduledMessagesProof } from './community-scheduled-messages.js';
import { communityStarboardProof } from './community-starboard.js';
import { communityStatisticsChannelsProof } from './community-statistics-channels.js';
import { communityTemporaryChannelsProof } from './community-temporary-channels.js';
import { communityWelcomeOnboardingProof } from './community-welcome-onboarding.js';
import { gameEconomyAchievementsPrestigeProof } from './game-economy-achievements-prestige.js';
import { gameEconomyAdventuresProof } from './game-economy-adventures.js';
import { gameEconomyCasinoProof } from './game-economy-casino.js';
import { gameEconomyCraftingProof } from './game-economy-crafting.js';
import { gameEconomyFarmingProof } from './game-economy-farming.js';
import { gameEconomyFishingProof } from './game-economy-fishing.js';
import { gameEconomyGatheringProof } from './game-economy-gathering.js';
import { gameEconomyHeistProof } from './game-economy-heist.js';
import { gameEconomyLotteryProof } from './game-economy-lottery.js';
import { gameEconomyPetsProof } from './game-economy-pets.js';
import { gameEconomyQuestsProof } from './game-economy-quests.js';
import { gameEconomyShopMarketProof } from './game-economy-shop-market.js';
import { gameEconomyTriviaProof } from './game-economy-trivia.js';
import { gameEconomyWalletRewardsProof } from './game-economy-wallet-rewards.js';
import { moderationAntiRaidProof } from './moderation-anti-raid.js';
import { moderationAutomodProof } from './moderation-automod.js';
import { moderationInfractionsAppealsProof } from './moderation-infractions-appeals.js';
import { moderationMessageLoggingProof } from './moderation-message-logging.js';
import { moderationTicketsTranscriptsProof } from './moderation-tickets-transcripts.js';
import { musicCollaborativeQueueProof } from './music-collaborative-queue.js';
import { musicPlayerFairnessProof } from './music-player-fairness.js';
import { commerceFraudProof } from './commerce-fraud.js';
import { commerceLicensesProof } from './commerce-licenses.js';
import { commercePaypalProof } from './commerce-paypal.js';
import { commercePortalProof } from './commerce-portal.js';
import { commerceProductStoreProof } from './commerce-product-store.js';
import { administrationAuditProof } from './administration-audit.js';
import { administrationAutomationsProof } from './administration-automations.js';
import { administrationCustomCommandsProof } from './administration-custom-commands.js';
import { administrationDiagnosticsProof } from './administration-diagnostics.js';
import { administrationIncidentsProof } from './administration-incidents.js';
import { administrationRbacProof } from './administration-rbac.js';
import { administrationServerSyncProof } from './administration-server-sync.js';
import { administrationTeamManagementProof } from './administration-team-management.js';
import { infrastructureLauncherProof } from './infrastructure-launcher.js';
import { infrastructureLicenseSdkProof } from './infrastructure-license-sdk.js';

import type { DomainProof } from '../types.js';

export const ALL_DOMAIN_PROOFS: readonly DomainProof[] = [
  communityGiveawaysProof,
  communityLevelsProof,
  communityPollsPredictionsProof,
  communityProfilesProof,
  communityReactionRolesProof,
  communityScheduledMessagesProof,
  communityStarboardProof,
  communityStatisticsChannelsProof,
  communityTemporaryChannelsProof,
  communityWelcomeOnboardingProof,
  gameEconomyAchievementsPrestigeProof,
  gameEconomyAdventuresProof,
  gameEconomyCasinoProof,
  gameEconomyCraftingProof,
  gameEconomyFarmingProof,
  gameEconomyFishingProof,
  gameEconomyGatheringProof,
  gameEconomyHeistProof,
  gameEconomyLotteryProof,
  gameEconomyPetsProof,
  gameEconomyQuestsProof,
  gameEconomyShopMarketProof,
  gameEconomyTriviaProof,
  gameEconomyWalletRewardsProof,
  moderationAntiRaidProof,
  moderationAutomodProof,
  moderationInfractionsAppealsProof,
  moderationMessageLoggingProof,
  moderationTicketsTranscriptsProof,
  musicCollaborativeQueueProof,
  musicPlayerFairnessProof,
  commerceFraudProof,
  commerceLicensesProof,
  commercePaypalProof,
  commercePortalProof,
  commerceProductStoreProof,
  administrationAuditProof,
  administrationAutomationsProof,
  administrationCustomCommandsProof,
  administrationDiagnosticsProof,
  administrationIncidentsProof,
  administrationRbacProof,
  administrationServerSyncProof,
  administrationTeamManagementProof,
  infrastructureLauncherProof,
  infrastructureLicenseSdkProof,
];
