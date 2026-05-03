/**
 * slackInteractions.ts
 *
 * Handles inbound Slack interactive component payloads (button clicks).
 *
 * This route receives POST requests from Slack when a guide clicks
 * Accept or Decline on a tour offer message.
 *
 * ── Accept flow (new) ──────────────────────────────────────────────────────
 * Offers are sent simultaneously to multiple guides. The FIRST guide to
 * click Accept wins. The win is determined atomically inside tryAcceptOffer(),
 * which wraps the acceptance check + assignment + supersession in a single
 * SQLite transaction. Subsequent accept clicks — even if they arrive
 * milliseconds later — will receive success: false and see a "already
 * assigned" message.
 *
 * ── Decline flow ───────────────────────────────────────────────────────────
 * A guide declining simply marks their own offer as declined. There is no
 * "next guide" to advance to — all guides were already contacted. If ALL
 * offers for a tour are now in a terminal state (declined/expired) and none
 * was accepted, the dispatch is cancelled and admins are notified.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { Router, Request, Response } from 'express';
import { SlackInteractionPayload, SlackActionId, OfferMetadata } from '../types/slack';
import {
  getOfferById,
  resolveOffer,
  tryAcceptOffer,
  isDispatchOpen,
  getOffersForTour,
  cancelDispatch,
} from '../services/offerService';
import {
  markOfferSuperseded,
  markOfferAlreadyAssigned,
  confirmAcceptanceToGuide,
  confirmDeclineToGuide,
  notifyAdminChannel,
} from '../services/slackService';
import {
  updateTourWorkflowFields,
  getGuidesFromTeamBoard,
} from '../services/mondayService';
import { logger } from '../utils/logger';

const router = Router();

/**
 * POST /slack/interactions
 *
 * Raw Express endpoint. In a pure Bolt setup this is handled by the Bolt
 * receiver, but we keep it here for custom middleware pipeline compatibility.
 *
 * Bolt's App also registers action handlers via app.action() in app.ts which
 * delegate to the exported handleAccept / handleDecline below.
 */
router.post('/', async (req: Request, res: Response): Promise<void> => {
  let payload: SlackInteractionPayload;
  try {
    payload = JSON.parse(req.body?.payload || '{}') as SlackInteractionPayload;
  } catch {
    res.status(400).json({ error: 'Invalid payload JSON' });
    return;
  }

  // Acknowledge immediately — Slack requires a response within 3 s
  res.status(200).send();

  const action = payload.actions?.[0];
  if (!action) return;

  let meta: OfferMetadata;
  try {
    meta = JSON.parse(action.value) as OfferMetadata;
  } catch {
    logger.error('[slackInteractions] Could not parse offer metadata from action value');
    return;
  }

  if (action.action_id === SlackActionId.ACCEPT_OFFER) {
    await handleAccept(meta, payload);
  } else if (action.action_id === SlackActionId.DECLINE_OFFER) {
    await handleDecline(meta, payload);
  }
});

export default router;

// ── Core handlers (also exported for Bolt app.action() use in app.ts) ─────────

/**
 * Handles a guide accepting a tour offer.
 *
 * Steps:
 *   1. Fast pre-check: is the dispatch still open?
 *   2. Atomic accept via tryAcceptOffer (single SQLite transaction)
 *   3a. On success: confirm to the accepting guide, update all superseded guides'
 *       Slack messages, update monday.com, notify admins
 *   3b. On failure: inform the guide the tour is already assigned
 */
export async function handleAccept(
  meta: OfferMetadata,
  payload: SlackInteractionPayload
): Promise<void> {
  logger.info(
    `[slackInteractions] Guide ${meta.guideId} attempting to accept offer ${meta.offerId} for tour ${meta.tourId}`
  );

  // ── Fast pre-check (non-authoritative, avoids unnecessary DB write) ───────
  // The real guard is inside tryAcceptOffer. This check just short-circuits
  // obvious stale clicks without hitting the transaction machinery.
  if (!isDispatchOpen(meta.tourId)) {
    logger.info(
      `[slackInteractions] Dispatch for tour ${meta.tourId} is no longer open — rejecting accept from guide ${meta.guideId}`
    );
    await safeMarkAlreadyAssigned(payload, meta.tourId);
    return;
  }

  // ── Atomic acceptance ─────────────────────────────────────────────────────
  const result = tryAcceptOffer(meta.offerId, meta.guideId);

  if (!result.success) {
    // Another guide won the race, or this offer was already terminal
    logger.info(
      `[slackInteractions] Accept rejected for offer ${meta.offerId}: ${result.reason}`
    );
    await safeMarkAlreadyAssigned(payload, meta.tourId);
    return;
  }

  // ── Acceptance confirmed ─────────────────────────────────────────────────
  logger.info(
    `[slackInteractions] Tour ${meta.tourId} assigned to guide ${meta.guideId} via offer ${meta.offerId}`
  );

  // 1. Confirm to the accepting guide (remove buttons, show "you got it")
  if (payload.channel?.id && payload.message?.ts) {
    try {
      await confirmAcceptanceToGuide(
        payload.channel.id,
        payload.message.ts,
        meta.tourId
      );
    } catch (err) {
      logger.error('[slackInteractions] Failed to confirm acceptance to guide:', err);
    }
  }

  // 2. Update Slack messages for all superseded guides so their buttons disappear
  for (const superseded of result.supersededOffers) {
    if (superseded.slackChannelId && superseded.slackMessageTs) {
      try {
        await markOfferSuperseded(
          superseded.slackUserId,
          superseded.slackChannelId,
          superseded.slackMessageTs,
          meta.tourId
        );
      } catch (err) {
        logger.error(
          `[slackInteractions] Failed to update superseded offer ${superseded.id} for guide ${superseded.guideId}:`,
          err
        );
      }
    } else {
      logger.warn(
        `[slackInteractions] Superseded offer ${superseded.id} has no Slack message reference — cannot update message`
      );
    }
  }

  // 3. Update monday.com
  try {
    await updateTourWorkflowFields(meta.tourId, {
      dispatchStatus: 'Complete',
      dispatchTrigger: 'Complete',
    });

    const acceptedGuides = await getGuidesFromTeamBoard([meta.guideId]);
    const acceptedGuideName = acceptedGuides[0]?.name ?? meta.guideId;

    await updateTourWorkflowFields(meta.tourId, {
      assignedGuideName: acceptedGuideName,
      acceptedGuideId: meta.guideId,
      isAssigned: true,
    });
  } catch (err) {
    logger.error('[slackInteractions] Failed to update monday.com after acceptance:', err);
  }

  // 4. Notify ops team
  try {
    await notifyAdminChannel(
      `✅ *Tour Assigned*\nTour ID *${meta.tourId}* has been accepted by guide <@${payload.user.id}>.`
    );
  } catch (err) {
    logger.error('[slackInteractions] Failed to notify admin channel:', err);
  }
}

/**
 * Handles a guide declining a tour offer.
 *
 * Steps:
 *   1. Validate the offer is still pending
 *   2. Mark this offer declined
 *   3. Acknowledge the decline to the guide (remove buttons)
 *   4. Check if all offers for this tour are now terminal — if so, cancel
 *      the dispatch and alert admins
 */
export async function handleDecline(
  meta: OfferMetadata,
  payload: SlackInteractionPayload
): Promise<void> {
  logger.info(
    `[slackInteractions] Guide ${meta.guideId} declining offer ${meta.offerId} for tour ${meta.tourId}`
  );

  const offer = getOfferById(meta.offerId);

  if (!offer || offer.status !== 'pending') {
    logger.warn(
      `[slackInteractions] Offer ${meta.offerId} is no longer pending (status: ${offer?.status ?? 'not found'}) — ignoring decline`
    );
    return;
  }

  // Mark this offer declined
  resolveOffer(meta.offerId, 'declined');

  // Acknowledge to the guide
  if (payload.channel?.id && payload.message?.ts) {
    try {
      await confirmDeclineToGuide(payload.channel.id, payload.message.ts, meta.tourId);
    } catch (err) {
      logger.error('[slackInteractions] Failed to confirm decline to guide:', err);
    }
  }

  // Check if all offers for this tour are now in a terminal state
  await checkAndHandleExhaustedDispatch(meta.tourId);
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Checks whether every offer for a tour has reached a terminal status
 * (accepted, declined, superseded, expired). If so — and none was accepted —
 * cancels the dispatch and notifies admins.
 */
async function checkAndHandleExhaustedDispatch(tourId: string): Promise<void> {
  const allOffers = getOffersForTour(tourId);

  const TERMINAL_STATUSES = new Set(['accepted', 'declined', 'superseded', 'expired']);
  const allTerminal = allOffers.every((o) => TERMINAL_STATUSES.has(o.status));

  if (!allTerminal) return; // Some guides still haven't responded

  const anyAccepted = allOffers.some((o) => o.status === 'accepted');
  if (anyAccepted) return; // Handled by the accept flow already

  // All offers are terminal and none was accepted → cancel and alert
  logger.warn(
    `[slackInteractions] All offers for tour ${tourId} are terminal with no acceptance — cancelling dispatch`
  );

  try {
    cancelDispatch(tourId);
  } catch (err) {
    logger.error(`[slackInteractions] Failed to cancel dispatch for tour ${tourId}:`, err);
  }

  try {
    await notifyAdminChannel(
      `⚠️ *No Guide Available*\nTour ID *${tourId}* — all guides have declined or did not respond. Manual assignment required.`
    );
  } catch (err) {
    logger.error('[slackInteractions] Failed to notify admin of exhausted dispatch:', err);
  }
}

/**
 * Safely updates the guide's Slack message to "already assigned" after a
 * failed accept attempt. Swallows errors so we never throw in the accept path.
 */
async function safeMarkAlreadyAssigned(
  payload: SlackInteractionPayload,
  tourId: string
): Promise<void> {
  if (payload.channel?.id && payload.message?.ts) {
    try {
      await markOfferAlreadyAssigned(
        payload.user.id,
        payload.channel.id,
        payload.message.ts,
        tourId
      );
    } catch (err) {
      logger.error('[slackInteractions] Failed to mark offer as already assigned:', err);
    }
  }
}