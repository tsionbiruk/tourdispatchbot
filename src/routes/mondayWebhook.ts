/**
 * mondayWebhook.ts
 *
 * Express router that handles inbound webhook events from monday.com.
 *
 * monday.com sends a challenge request on first registration — we handle that.
 * On real events we verify the HMAC-SHA256 signature and dispatch to the right handler.
 *
 * ── Trigger model ─────────────────────────────────────────────────────────────
 * Dispatch is triggered when the `Dispatch Trigger` status column on a tour item
 * is changed to "Start Dispatch" in monday.com.
 *
 * The automation used is: "When Dispatch Trigger changes, send a webhook"
 *
 * The webhook fires a column-change event whose:
 *   event.type     === "update_column_value"
 *   event.columnTitle === "Dispatch Trigger"
 *   event.value    === { label: { text: "Start Dispatch" } }
 *
 * Any other column changes or label values are acknowledged and ignored.
 *
 * Dispatch mode (all_guides | manual_selection) and any manually selected guide
 * IDs are read from dedicated columns on the Tours board via parseTourDispatchColumns.
 *
 * ── Monday status update lifecycle ────────────────────────────────────────────
 *   Dispatch Status = "Dispatching"   → set immediately when dispatch starts
 *   Dispatch Status = "Sent"          → set after Slack DMs are successfully sent
 *   Dispatch Status = "Assigned"      → set when a guide accepts (via updateAssignedGuide)
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
 *
 * Added `columnId` and `value` to the event shape to support
 * column-change events from the "When column changes, send a webhook" automation.
 */
interface MondayWebhookPayload {
  event?: {
    type?: string;
    itemId?: string | number;
    pulseId?: string | number;
    item_id?: string | number;
    /** ID of the column that changed — present on column-change events */
    columnId?: string;
    /** New column value — present on column-change events */
    value?: {
      label?: {
        text?: string;
      };
    };
    /** Legacy: embedded button context data. No longer populated by the current trigger. */
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
 *
 * Behaviour by scenario:
 *
 *   MONDAY_SIGNING_SECRET not set
 *     → skip verification with a warning (unchanged, works in all envs)
 *
 *   Signature header present
 *     → always verify the HMAC regardless of NODE_ENV
 *
 *   Signature header absent + NODE_ENV !== 'production'
 *     → warn and allow through — supports local ngrok testing where
 *       monday.com may not include the signature header
 *
 *   Signature header absent + NODE_ENV === 'production'
 *     → reject with a warning — never skip in production
 */
function verifyMondaySignature(rawBody: string, signature: string | undefined): boolean {
  if (!MONDAY_SIGNING_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      logger.error('[mondayWebhook] MONDAY_SIGNING_SECRET not set — rejecting request in production');
      return false;
    }

    logger.warn('[mondayWebhook] MONDAY_SIGNING_SECRET not set — skipping signature verification');
    return true;
  }

  if (!signature) {
    if (process.env.NODE_ENV === 'production') {
      logger.warn('[mondayWebhook] No x-monday-signature header present — rejecting (production)');
      return false;
    }
    logger.warn(
      '[mondayWebhook] No x-monday-signature header present — allowing through (non-production)'
    );
    return true;
  }

  const hash = crypto
    .createHmac('sha256', MONDAY_SIGNING_SECRET)
    .update(rawBody)
    .digest('hex');
  if (hash.length !== signature.length) return false;
  return crypto.timingSafeEqual(
    Buffer.from(hash, 'hex'),
    Buffer.from(signature, 'hex')
  );
}

// ── Main route ────────────────────────────────────────────────────────────────

/**
 * POST /webhooks/monday
 *
 * Handles:
 *   - Challenge handshake (monday.com registration)
 *   - Dispatch trigger (Dispatch Trigger column changed to "Start Dispatch")
 *   - All other events are acknowledged and ignored
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  // ── Challenge handshake ─────────────────────────────────────────────────────
  if (req.body?.challenge) {
    logger.info('[mondayWebhook] Received monday.com challenge — responding');
    res.json({ challenge: req.body.challenge });
    return;
  }

  // ── Signature verification ──────────────────────────────────────────────────
  const signature = req.headers['x-monday-signature'] as string | undefined;
  const rawBody =
  (req as Request & { rawBody?: Buffer }).rawBody?.toString('utf8') ??
  JSON.stringify(req.body);

  if (!verifyMondaySignature(rawBody, signature)) {
    logger.warn('[mondayWebhook] Invalid signature — rejecting request');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  const payload = req.body as MondayWebhookPayload;

  logger.info('[mondayWebhook] Raw payload:\n' + JSON.stringify(payload, null, 2));

  const event = payload?.event;

  if (!event) {
    res.status(400).json({ error: 'Missing event payload' });
    return;
  }

  logger.info(
    `[mondayWebhook] Received event type="${event.type}" columnId="${event.columnId ?? 'n/a'}" ` +
      `label="${event.value?.label?.text ?? 'n/a'}" itemId=${
        event.itemId ?? event.pulseId ?? event.item_id ?? 'unknown'
      }`
  );

  // ── Route: dispatch trigger ─────────────────────────────────────────────────
  if (!isDispatchTriggerEvent(payload)) {
    logger.info(
      `[mondayWebhook] Event type="${event.type}" columnId="${event.columnId ?? 'n/a'}" ` +
        `label="${event.value?.label?.text ?? 'n/a'}" is not a dispatch trigger — ignoring`
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
 * Called when the Dispatch Trigger column is changed to "Start Dispatch".
 *
 * Steps:
 *   1. Extract and validate the tour item ID
 *   2. Guard against duplicate dispatches
 *   3. Resolve dispatch mode and guide selection (from board columns)
 *   4. Set Monday Dispatch Status → "Dispatching"
 *   5. Fetch the full tour and select guides from the Team Members board
 *   6. Open the dispatch (creates one offer row per guide atomically)
 *   7. Send Slack DMs to all selected guides simultaneously
 *   8. Persist Slack message references so they can be updated later
 *   9. Set Monday Dispatch Status → "Sent"
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
    const options = await resolveDispatchOptions(payload, tourId);

    logger.info(
      `[mondayWebhook] Dispatch mode for tour ${tourId}: ${options.dispatchMode}` +
        (options.manualGuideIds?.length
          ? ` (${options.manualGuideIds.length} guide(s) pre-selected)`
          : '')
    );

    // ── 4. Mark dispatch as started in Monday ─────────────────────────────────
    await updateDispatchStatus(tourId, 'Dispatching');

    // ── 5. Fetch tour and select guides ───────────────────────────────────────
    const tour   = await getTourById(tourId);
    const guides = await selectGuidesForTour(tour, options);

    if (guides.length === 0) {
      logger.warn(`[mondayWebhook] No guides found for tour ${tourId}`);
      await updateDispatchStatus(tourId, 'No guides found');
      await notifyAdminChannel(
        `⚠️ *No Guides Found*\nTour *${tour.name}* (ID: ${tourId}) was triggered for dispatch but no guides were found on the Team Members board.`
      );
      return;
    }

    // ── 6. Open dispatch — creates one offer row per guide atomically ─────────
    const guideOffers = guides.map((g) => ({
      guideId:     g.id,
      slackUserId: g.slackUserId,
    }));

    const offerIds = openDispatch(
      tourId,
      guideOffers,
      options.dispatchMode,
      options.manualGuideIds
    );
    // offerIds is in the same order as guideOffers / guides

    // ── 7. Send Slack DMs to all guides simultaneously ────────────────────────
    const sendResults = await Promise.allSettled(
      guides.map((guide, i) =>
        sendOfferToGuide(guide, tour, {
          offerId: offerIds[i],
          tourId,
          guideId: guide.id,
        })
      )
    );

    // ── 8. Persist Slack message references ───────────────────────────────────
    for (let i = 0; i < sendResults.length; i++) {
      const result = sendResults[i];
      if (result.status === 'fulfilled') {
        updateOfferSlackMessage(offerIds[i], result.value.channelId, result.value.messageTs);
      } else {
        logger.error(
          `[mondayWebhook] Failed to send Slack DM to guide ${guides[i].id}:`,
          result.reason
        );
      }
    }

    const sentCount   = sendResults.filter((r) => r.status === 'fulfilled').length;
    const failedCount = sendResults.length - sentCount;

    logger.info(
      `[mondayWebhook] Dispatch result for tour ${tourId}: ` +
        `${sentCount}/${guides.length} Slack DM(s) sent`
    );

    // ── 9. Update Monday dispatch status ──────────────────────────────────────
    if (sentCount === 0) {
      // Every Slack send failed — dispatch is broken
      await updateDispatchStatus(tourId, 'Dispatch failed');
      await notifyAdminChannel(
        `❌ *Dispatch Failed*\nTour *${tour.name}* (ID: ${tourId}) — all ${failedCount} Slack DM(s) failed to send. Check Slack bot permissions.`
      );
      return;
    }

    // At least one DM was delivered — mark as sent
    await updateDispatchStatus(tourId, 'Message sent');
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
 * The column-change trigger does not embed dispatch configuration in
 * event.data, so we always fall back to reading board columns directly.
 * The embedded-data path is kept for forward-compatibility but will not be
 * populated by the current automation.
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

  // Column-change events carry no embedded dispatch config — read from board.
  logger.info(
    `[mondayWebhook] No dispatch data in event payload for tour ${tourId} — reading from board columns`
  );

  const { dispatchMode, manualGuideIds } = await parseTourDispatchColumns(tourId);

  return {
    dispatchMode,
    manualGuideIds: dispatchMode === 'manual_selection' ? manualGuideIds : undefined,
  };
}

// ── Re-exports ────────────────────────────────────────────────────────────────

export type { DispatchOptions };