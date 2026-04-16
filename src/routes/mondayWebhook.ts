/**
 * mondayWebhook.ts
 *
 * Express router that handles inbound webhook events from monday.com.
 *
 * monday.com sends a challenge request on first registration — we handle that.
 * On real events we verify the HMAC-SHA256 signature and dispatch to the right handler.
 *
 * ── Trigger model (new) ───────────────────────────────────────────────────────
 * Dispatch is NO LONGER triggered by a status change to "Needed".
 * It is triggered when a manager clicks the "Start Guide Search" button/action
 * on a tour item in monday.com.
 *
 * The button fires a webhook whose event.type matches MONDAY_DISPATCH_TRIGGER_TYPE
 * (default: "ButtonClicked"). The dispatch mode (all_guides | manual_selection)
 * and any manually selected guide IDs are read either from:
 *
 *   a) event.data embedded in the button's context payload, OR
 *   b) dedicated columns on the Tours board (parseTourDispatchColumns fallback)
 *
 * See mondayService.ts for column ID configuration details.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Router, Request, Response } from 'express';
import crypto from 'crypto';

import { DispatchMode } from '../types/tour';
import {
  isDispatchTriggerEvent,
  getWebhookItemId,
  getTourById,
  parseTourDispatchColumns,
  updateDispatchStatus,
} from '../services/mondayService';
import { selectGuidesForTour, DispatchOptions } from '../services/guideSelectionService';
import { openDispatch, updateOfferSlackMessage, getDispatch } from '../services/offerService';
import { sendOfferToGuide, notifyAdminChannel } from '../services/slackService';
import { logger } from '../utils/logger';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Minimal shape of a monday.com webhook payload.
 * The `event` field is typed loosely here because different trigger types
 * carry different shapes; we only read the fields we actually need.
 */
interface MondayWebhookPayload {
  event?: {
    type?: string;
    itemId?: string | number;
    pulseId?: string | number;
    item_id?: string | number;
    columnId?: string;
    data?: {
      dispatchMode?: DispatchMode;
      manualGuideIds?: string[];
    };
  };
}

/**
 * Narrowed payload type used once we have confirmed this is a dispatch trigger.
 * event.itemId is guaranteed to be present (as enforced by getWebhookItemId).
 */
interface MondayDispatchTriggerPayload extends MondayWebhookPayload {
  event: NonNullable<MondayWebhookPayload['event']>;
}

// ── Router setup ──────────────────────────────────────────────────────────────

const router = Router();

const MONDAY_SIGNING_SECRET = process.env.MONDAY_SIGNING_SECRET || '';

// ── Signature verification ────────────────────────────────────────────────────

/**
 * Verifies the monday.com webhook HMAC-SHA256 signature.
 * If MONDAY_SIGNING_SECRET is not configured, verification is skipped with a
 * warning — do NOT leave this unset in production.
 */
function verifyMondaySignature(rawBody: string, signature: string | undefined): boolean {
  if (!MONDAY_SIGNING_SECRET) {
    logger.warn('[mondayWebhook] MONDAY_SIGNING_SECRET not set — skipping signature verification');
    return true;
  }
  if (!signature) {
    logger.warn('[mondayWebhook] No x-monday-signature header present');
    return false;
  }
  const hash = crypto
    .createHmac('sha256', MONDAY_SIGNING_SECRET)
    .update(rawBody)
    .digest('hex');
  return hash === signature;
}

// ── Main route ────────────────────────────────────────────────────────────────

/**
 * POST /webhooks/monday
 *
 * Handles:
 *   - Challenge handshake (monday.com registration)
 *   - Dispatch trigger (manager clicks "Start Guide Search" button)
 *   - All other events are acknowledged and ignored
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  // ── Challenge handshake ─────────────────────────────────────────────────────
  // monday.com POSTs this once when the webhook is first registered.
  if (req.body?.challenge) {
    logger.info('[mondayWebhook] Received monday.com challenge — responding');
    res.json({ challenge: req.body.challenge });
    return;
  }

  // ── Signature verification ──────────────────────────────────────────────────
  const signature = req.headers['x-monday-signature'] as string | undefined;
  // NOTE: express must be configured with express.raw() or a rawBody middleware
  // on this route so that the body is available as the original bytes for HMAC.
  // If you use express.json() globally, store rawBody in a middleware first.
  const rawBody = JSON.stringify(req.body);

  if (!verifyMondaySignature(rawBody, signature)) {
    logger.warn('[mondayWebhook] Invalid signature — rejecting request');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  const payload = req.body as MondayWebhookPayload;
  const event   = payload?.event;

  if (!event) {
    res.status(400).json({ error: 'Missing event payload' });
    return;
  }

  logger.info(
    `[mondayWebhook] Received event type="${event.type}" itemId=${
      event.itemId ?? event.pulseId ?? event.item_id ?? 'unknown'
    }`
  );

  // ── Route: dispatch trigger ─────────────────────────────────────────────────
  if (!isDispatchTriggerEvent(payload)) {
    logger.info(
      `[mondayWebhook] Event type "${event.type}" is not a dispatch trigger — ignoring`
    );
    res.status(200).json({ message: 'Event ignored' });
    return;
  }

  // Respond to monday immediately — webhook must return within 5 s.
  res.status(200).json({ message: 'Accepted' });

  // Process asynchronously so we never block the HTTP response.
  setImmediate(() =>
    handleDispatchTrigger(payload as MondayDispatchTriggerPayload).catch((err) =>
      logger.error('[mondayWebhook] Unhandled error in handleDispatchTrigger:', err)
    )
  );
});

export default router;

// ── Dispatch trigger handler ──────────────────────────────────────────────────

/**
 * Called when a manager clicks the "Start Guide Search" button on a tour item.
 *
 * Steps:
 *   1. Extract and validate the tour item ID
 *   2. Guard against duplicate dispatches
 *   3. Resolve dispatch mode and guide selection
 *   4. Fetch the full tour and select eligible guides
 *   5. Open the dispatch (creates one offer row per guide atomically)
 *   6. Send Slack DMs to all selected guides simultaneously
 *   7. Persist Slack message references so they can be updated later
 *   8. Update Monday dispatch status column accordingly
 */
async function handleDispatchTrigger(payload: MondayDispatchTriggerPayload): Promise<void> {
  // ── 1. Extract item ID ────────────────────────────────────────────────────
  const tourId = getWebhookItemId(payload);

  if (!tourId) {
    logger.error('[mondayWebhook] handleDispatchTrigger: could not extract itemId from payload');
    return;
  }

  logger.info(`[mondayWebhook] Handling dispatch trigger for tour ${tourId}`);

  try {
    // ── 2. Guard: do not restart an already-open or assigned dispatch ────────
    const existingDispatch = getDispatch(tourId);
    if (existingDispatch?.status === 'open') {
      logger.info(`[mondayWebhook] Tour ${tourId} already has an open dispatch — skipping`);
      return;
    }
    if (existingDispatch?.status === 'assigned') {
      logger.info(`[mondayWebhook] Tour ${tourId} is already assigned — skipping`);
      return;
    }

    // ── 3. Resolve dispatch mode ─────────────────────────────────────────────
    //
    // Preferred: read from the button's embedded context data.
    // Fallback:  read from dedicated tour board columns.
    const options = await resolveDispatchOptions(payload, tourId);

    logger.info(
      `[mondayWebhook] Dispatch mode for tour ${tourId}: ${options.dispatchMode}` +
        (options.manualGuideIds?.length
          ? ` (${options.manualGuideIds.length} guide(s) pre-selected)`
          : '')
    );

    // ── 4. Fetch tour and select eligible guides ──────────────────────────────
    const tour           = await getTourById(tourId);
    const eligibleGuides = await selectGuidesForTour(tour, options);

    if (eligibleGuides.length === 0) {
      logger.warn(`[mondayWebhook] No eligible guides found for tour ${tourId}`);
      await updateDispatchStatus(tourId, 'No eligible guides');
      await notifyAdminChannel(
        `⚠️ *No Eligible Guides*\nTour *${tour.name}* (ID: ${tourId}) was triggered for dispatch but no eligible guides were found.`
      );
      return;
    }

    // ── 5. Open dispatch — creates one offer row per guide atomically ─────────
    const guideOffers = eligibleGuides.map((g) => ({
      guideId:     g.id,
      slackUserId: g.slackUserId,
    }));

    const offerIds = openDispatch(
      tourId,
      guideOffers,
      options.dispatchMode,
      options.manualGuideIds
    );
    // offerIds is in the same order as guideOffers / eligibleGuides

    // ── 6. Send Slack DMs to all guides simultaneously ────────────────────────
    const sendResults = await Promise.allSettled(
      eligibleGuides.map((guide, i) =>
        sendOfferToGuide(guide, tour, {
          offerId: offerIds[i],
          tourId,
          guideId: guide.id,
        })
      )
    );

    // ── 7. Persist Slack message references ───────────────────────────────────
    for (let i = 0; i < sendResults.length; i++) {
      const result = sendResults[i];
      if (result.status === 'fulfilled') {
        updateOfferSlackMessage(offerIds[i], result.value.channelId, result.value.messageTs);
      } else {
        logger.error(
          `[mondayWebhook] Failed to send Slack DM to guide ${eligibleGuides[i].id}:`,
          result.reason
        );
      }
    }

    const sentCount   = sendResults.filter((r) => r.status === 'fulfilled').length;
    const failedCount = sendResults.length - sentCount;

    logger.info(
      `[mondayWebhook] Dispatch result for tour ${tourId}: ` +
        `${sentCount}/${eligibleGuides.length} Slack DM(s) sent`
    );

    // ── 8. Update Monday dispatch status ──────────────────────────────────────
    if (sentCount === 0) {
      // Every Slack send failed — dispatch is broken
      await updateDispatchStatus(tourId, 'Dispatch failed');
      await notifyAdminChannel(
        `❌ *Dispatch Failed*\nTour *${tour.name}* (ID: ${tourId}) — all ${failedCount} Slack DM(s) failed to send. Check Slack bot permissions.`
      );
      return;
    }

    // At least one DM was delivered — dispatch is live
    await updateDispatchStatus(tourId, 'Dispatching');
    await notifyAdminChannel(
      `📨 *Dispatch Started*\nTour *${tour.name}* (ID: ${tourId}) — offers sent to ${sentCount} guide(s). Mode: \`${options.dispatchMode}\`.` +
        (failedCount > 0 ? ` (${failedCount} DM(s) failed to send)` : '')
    );
  } catch (err) {
    logger.error(
      `[mondayWebhook] Error handling dispatch trigger for tour ${tourId}:`,
      err
    );
    // Best-effort status update — log if this also fails
    updateDispatchStatus(tourId, 'Dispatch failed').catch((statusErr) =>
      logger.error(
        `[mondayWebhook] Also failed to update dispatch status for tour ${tourId}:`,
        statusErr
      )
    );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Resolves dispatch options from the webhook payload.
 *
 * Strategy:
 *   1. If the button payload embeds event.data with a dispatchMode field, use it.
 *   2. Otherwise fall back to reading dispatch columns from the Tours board.
 *
 * tourId is passed in explicitly (already extracted by the caller) to avoid
 * calling getWebhookItemId() a second time.
 */
async function resolveDispatchOptions(
  payload: MondayDispatchTriggerPayload,
  tourId: string
): Promise<DispatchOptions> {
  const embeddedData = payload.event.data;

  if (embeddedData?.dispatchMode) {
    const dispatchMode: DispatchMode = embeddedData.dispatchMode;
    const manualGuideIds =
      dispatchMode === 'manual_selection'
        ? (embeddedData.manualGuideIds ?? [])
        : undefined;

    return { dispatchMode, manualGuideIds };
  }

  // Fallback: read from dedicated board columns
  logger.info(
    `[mondayWebhook] No dispatch data in button payload for tour ${tourId} — falling back to board columns`
  );

  const { dispatchMode, manualGuideIds } = await parseTourDispatchColumns(tourId);

  return {
    dispatchMode,
    manualGuideIds: dispatchMode === 'manual_selection' ? manualGuideIds : undefined,
  };
}

// ── Re-exports ────────────────────────────────────────────────────────────────

/**
 * Re-export DispatchOptions so other modules can import it from here if needed.
 */
export type { DispatchOptions };