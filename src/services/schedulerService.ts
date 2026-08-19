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
  getDispatchesPendingTimeoutNotification,
  markTimeoutNotified,
} from './offerService';
import { updateTourWorkflowFields, getTourById, parseTourDispatchColumns } from './mondayService';
import { notifyAdminChannel } from './slackService';
import { logger } from '../utils/logger';

const POLL_INTERVAL_MS = parseInt(process.env.SCHEDULER_POLL_INTERVAL_MS || '300000', 10); // 5 min

/**
 * How long a dispatch can sit with no guide response before managers get a
 * heads-up nudge. This does NOT expire or cancel the offer — guides can
 * still accept after this fires. Default: 3 hours.
 */
const OFFER_TIMEOUT_NOTIFY_MS = parseInt(
  process.env.OFFER_TIMEOUT_NOTIFY_MS || String(3 * 60 * 60 * 1000),
  10
);

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

  // Independent of the expired-offer handling below — a dispatch can be
  // fully "on time" (offers not yet expired) and still be past the 3-hour
  // no-response mark, since offer expiry and the manager nudge are on
  // separate clocks.
  await checkPendingTimeoutNotifications();

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
 * Finds dispatches that have been open for 3+ hours with no guide response
 * and haven't already been flagged for this session, then sends a one-time
 * heads-up to the manager channel.
 *
 * Important: this never touches offer status, dispatch status, or Monday.
 * The offer stays fully live — this is purely an informational nudge so a
 * manager can decide whether to step in manually.
 */
async function checkPendingTimeoutNotifications(): Promise<void> {
  const dueDispatches = getDispatchesPendingTimeoutNotification(OFFER_TIMEOUT_NOTIFY_MS);

  if (dueDispatches.length === 0) return;

  logger.info(
    `[schedulerService] ${dueDispatches.length} dispatch(es) past the ${
      OFFER_TIMEOUT_NOTIFY_MS / (60 * 60 * 1000)
    }h no-response mark`
  );

  for (const dispatch of dueDispatches) {
    try {
      const tour = await getTourById(dispatch.tourId);
      const { dispatchRole } = await parseTourDispatchColumns(dispatch.tourId);

      await notifyAdminChannel(
        `⏰ *No Response After 3 Hours*\n` +
        `Tour ${tour.name} - ${tour.date} - ${tour.time}\n` +
        `Role: ${dispatchRole}\n` +
        `3 hours have passed since guides were contacted and no one has accepted yet. ` +
        `The offer is still open and guides can still accept — would you like to follow up manually?`
      );

      // Mark this session as notified so it isn't repeated on every 5-minute
      // poll. openDispatch() automatically clears this flag on re-dispatch.
      markTimeoutNotified(dispatch.tourId);
    } catch (err) {
      logger.error(
        `[schedulerService] Failed to send timeout notice for tour ${dispatch.tourId}:`,
        err
      );
    }
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

  await updateTourWorkflowFields(tourId, {
    dispatchStatus: 'Manual Review',
    dispatchTrigger: 'Complete',
  });

  const tour = await getTourById(tourId);

  try {
    await notifyAdminChannel(
      `⚠️ *Manual Review Required*\n` +
      `Tour ${tour.name} - ${tour.date} - ${tour.time} - all guides either declined or did not respond before the offer expired. ` +
      `Manual assignment required.`
    );
  } catch (err) {
    logger.error(`[schedulerService] Failed to notify admin for tour ${tourId}:`, err);
  }
}