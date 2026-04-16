/**
 * schedulerService.ts
 *
 * Polls the database periodically for offers that have expired without a
 * response and handles them cleanly.
 *
 * ── What changed from the old design ─────────────────────────────────────────
 *
 * Previously this service was responsible for "advancing the dispatch queue":
 * after a guide didn't respond, it would contact the next guide in a ranked
 * list. That was the tier/wave model.
 *
 * In the new model:
 *   - All eligible guides are contacted SIMULTANEOUSLY when dispatch opens.
 *   - There is no "next guide" to advance to.
 *   - The scheduler's only job is now to:
 *       1. Detect offers whose expires_at has passed with status = 'pending'
 *       2. Mark them 'expired'
 *       3. After expiring, check whether ALL offers for that tour are now
 *          terminal — if so, cancel the dispatch and alert admins.
 *
 * advanceDispatchForTour() has been REMOVED. It was the old sequential wave
 * logic. Nothing should call it anymore.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  getExpiredPendingOffers,
  resolveOffer,
  getOffersForTour,
  cancelDispatch,
} from './offerService';
import { updateTourWorkflowFields } from './mondayService';
import { notifyAdminChannel } from './slackService';
import { logger } from '../utils/logger';

const POLL_INTERVAL_MS = parseInt(process.env.SCHEDULER_POLL_INTERVAL_MS || '300000', 10); // 5 min

let schedulerTimer: NodeJS.Timeout | null = null;

// ── Lifecycle ─────────────────────────────────────────────────────────────────

/**
 * Starts the background scheduler. Call once at application startup.
 */
export function startScheduler(): void {
  logger.info(`[schedulerService] Starting scheduler (poll every ${POLL_INTERVAL_MS / 1000}s)`);
  schedulerTimer = setInterval(() => {
    runSchedulerCycle().catch((err) =>
      logger.error('[schedulerService] Unhandled error in scheduler cycle:', err)
    );
  }, POLL_INTERVAL_MS);
}

/**
 * Stops the scheduler. Useful for graceful shutdown and tests.
 */
export function stopScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
    logger.info('[schedulerService] Scheduler stopped');
  }
}

// ── Scheduler cycle ───────────────────────────────────────────────────────────

/**
 * A single scheduler pass:
 *   1. Find all pending offers whose expires_at has passed
 *   2. Mark each one as 'expired'
 *   3. For each affected tour, check whether the dispatch is now fully exhausted
 */
async function runSchedulerCycle(): Promise<void> {
  logger.info('[schedulerService] Running scheduler cycle');

  const expiredOffers = getExpiredPendingOffers();

  if (expiredOffers.length === 0) {
    logger.info('[schedulerService] No expired offers found');
    return;
  }

  logger.info(`[schedulerService] Found ${expiredOffers.length} expired offer(s)`);

  // Mark each expired offer
  for (const offer of expiredOffers) {
    resolveOffer(offer.id, 'expired');
    logger.info(
      `[schedulerService] Marked offer ${offer.id} (tour ${offer.tourId}, guide ${offer.guideId}) as expired`
    );
  }

  // Deduplicate by tourId — check each tour once
  const affectedTourIds = [...new Set(expiredOffers.map((o) => o.tourId))];

  for (const tourId of affectedTourIds) {
    await handlePostExpiryCheck(tourId);
  }
}

/**
 * After offers expire, checks whether all offers for a tour are now in a
 * terminal state. If so — and none was accepted — cancels the dispatch
 * and notifies admins.
 *
 * This mirrors the same logic in slackInteractions.ts (handleDecline path)
 * so that expiry-driven exhaustion is handled identically to decline-driven.
 */
async function handlePostExpiryCheck(tourId: string): Promise<void> {
  const allOffers = getOffersForTour(tourId);

  const TERMINAL_STATUSES = new Set(['accepted', 'declined', 'superseded', 'expired']);
  const allTerminal = allOffers.every((o) => TERMINAL_STATUSES.has(o.status));

  if (!allTerminal) {
    // Some guides still have pending offers (sent later in the same session
    // or a different expiry window) — nothing to do yet
    return;
  }

  const anyAccepted = allOffers.some((o) => o.status === 'accepted');
  if (anyAccepted) {
    // Tour was already assigned — nothing to do
    return;
  }

  // All offers are terminal and no one accepted
  logger.warn(
    `[schedulerService] All offers for tour ${tourId} expired/declined with no acceptance — cancelling dispatch`
  );

  try {
    cancelDispatch(tourId);
  } catch (err) {
    logger.error(`[schedulerService] Failed to cancel dispatch for tour ${tourId}:`, err);
  }

  try {
    await updateTourWorkflowFields(tourId, { status: 'Manual Review' });
  } catch (err) {
    logger.error(`[schedulerService] Failed to update monday.com status for tour ${tourId}:`, err);
  }

  try {
    await notifyAdminChannel(
      `⚠️ *Manual Review Required*\n` +
        `Tour ID *${tourId}* — all guides either declined or did not respond before the offer expired. ` +
        `Manual assignment required.`
    );
  } catch (err) {
    logger.error(`[schedulerService] Failed to notify admin for tour ${tourId}:`, err);
  }
}