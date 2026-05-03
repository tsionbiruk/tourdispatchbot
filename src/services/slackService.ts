/**
 * slackService.ts
 *
 * Handles all outbound Slack interactions:
 *   - Sending simultaneous DM offer messages to multiple guides
 *   - Updating messages after a guide responds (accept / decline / superseded)
 *   - Notifying admins of dispatch outcomes
 *
 * ── Message lifecycle ──────────────────────────────────────────────────────
 *
 *   [active offer]          — two buttons: ✅ Accept  ❌ Decline
 *       │
 *       ├─ guide accepts ──▶ [confirmed: you got it]        (confirmAcceptanceToGuide)
 *       ├─ guide declines ─▶ [confirmed: offer declined]    (confirmDeclineToGuide)
 *       ├─ another guide
 *       │  accepted first ─▶ [superseded: already assigned] (markOfferSuperseded)
 *       └─ guide clicks
 *          Accept but lost
 *          the race ────────▶ [already assigned]            (markOfferAlreadyAssigned)
 *
 * All update functions replace the Block Kit actions block with a plain text
 * section so no interactive elements remain — guides cannot click anything
 * after the tour is resolved.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { App as BoltApp } from '@slack/bolt';
import { KnownBlock, Block } from '@slack/types';
import { Tour } from '../types/tour';
import { Guide } from '../types/guide';
import { formatForSlack } from '../utils/time';
import { logger } from '../utils/logger';
import { updateTourWorkflowFields } from './mondayService';

let boltApp: BoltApp;

/**
 * Must be called once during application startup with the initialised Bolt app.
 */
export function initSlack(app: BoltApp): void {
  boltApp = app;
}

// ── Sending offers ────────────────────────────────────────────────────────────

/**
 * Sends an interactive offer DM to a single guide.
 * Returns the channel ID and message timestamp needed to update the message later.
 *
 * Called for each guide in the eligible list. Use Promise.allSettled() in the
 * caller so one failed DM doesn't abort the rest.
 */

type OfferMetadata = {
  offerId: number;
  tourId: string;
  guideId: string;
};

enum SlackActionId {
  ACCEPT_OFFER = 'accept_offer',
  DECLINE_OFFER = 'decline_offer',
}

export async function sendOfferToGuide(
  guide: Guide,
  tour: Tour,
  offerMeta: OfferMetadata
): Promise<{ channelId: string; messageTs: string }> {
  logger.info(
    `[slackService] Sending offer to guide ${guide.name} (${guide.slackUserId}) for tour ${tour.id}`
  );

  const metadataStr = JSON.stringify(offerMeta);

  // Open a DM channel with the guide
  const openResult = await boltApp.client.conversations.open({
    users: guide.slackUserId,
  });

  const channelId = openResult.channel?.id;
  if (!channelId) {
    throw new Error(`Could not open DM channel with guide ${guide.slackUserId}`);
  }

  // Build the active-offer message
  const result = await boltApp.client.chat.postMessage({
    channel: channelId,
    text: `New tour offer: ${tour.name}`,
    blocks: buildActiveOfferBlocks(tour, metadataStr),
  });

  const messageTs = result.ts as string;
  logger.info(
    `[slackService] Offer sent to ${guide.name}, channelId=${channelId}, ts=${messageTs}`
  );

  return { channelId, messageTs };
}

/**
 * Sends offers to all guides in the list simultaneously.
 * Returns a per-guide result array (use Promise.allSettled semantics).
 *
 * Callers should iterate the results to store channelId + messageTs for
 * each successfully sent message.
 */
export async function sendOffersToAllGuides(
  guides: Guide[],
  tour: Tour,
  offerMetaList: OfferMetadata[]
): Promise<PromiseSettledResult<{ guideId: string; channelId: string; messageTs: string }>[]> {
  const results = await Promise.allSettled(
    guides.map(async (guide, i) => {
      const { channelId, messageTs } = await sendOfferToGuide(guide, tour, offerMetaList[i]);
      return { guideId: guide.id, channelId, messageTs };
    })
  );

  const sentCount = results.filter((result) => result.status === 'fulfilled').length;

  if (sentCount > 0) {
    await updateTourWorkflowFields(tour.id, {
      dispatchStatus: 'Message sent',
    });
  }

  return results;
}

// ── Message updates ───────────────────────────────────────────────────────────

/**
 * Updates the guide's message to confirm they have been assigned the tour.
 * Removes all interactive buttons.
 */
export async function confirmAcceptanceToGuide(
  channelId: string,
  messageTs: string,
  tourId: string
): Promise<void> {
  logger.info(`[slackService] Confirming acceptance to guide — tour ${tourId}, ts=${messageTs}`);

  await boltApp.client.chat.update({
    channel: channelId,
    ts: messageTs,
    text: `You have been assigned tour ${tourId}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `✅ *Tour Confirmed!*\n\n` +
            `You have been assigned to tour *${tourId}*.\n` +
            `Check monday.com for full details.`,
        },
      },
    ],
  });
}

/**
 * Updates the guide's message to acknowledge a decline.
 * Removes all interactive buttons.
 */
export async function confirmDeclineToGuide(
  channelId: string,
  messageTs: string,
  tourId: string
): Promise<void> {
  logger.info(`[slackService] Confirming decline to guide — tour ${tourId}, ts=${messageTs}`);

  await boltApp.client.chat.update({
    channel: channelId,
    ts: messageTs,
    text: `Tour offer declined: ${tourId}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `You have declined the offer for tour *${tourId}*. No further action needed.`,
        },
      },
    ],
  });
}

/**
 * Updates a guide's message to show that another guide already accepted.
 *
 * Called on guides whose offers were SUPERSEDED — i.e. they hadn't responded
 * yet when someone else accepted. The buttons are replaced with a static notice.
 */
export async function markOfferSuperseded(
  slackUserId: string,
  channelId: string,
  messageTs: string,
  tourId: string
): Promise<void> {
  logger.info(
    `[slackService] Marking offer superseded for user ${slackUserId} — tour ${tourId}, ts=${messageTs}`
  );

  await boltApp.client.chat.update({
    channel: channelId,
    ts: messageTs,
    text: `Tour ${tourId} has been assigned to another guide.`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `~*Tour Offer — ${tourId}*~\n\n` +
            `This offer is no longer available — another guide has accepted.\n` +
            `Thank you for your availability! 🙏`,
        },
      },
    ],
  });
}

/**
 * Updates a guide's message when they clicked Accept but lost the race.
 *
 * This is the message shown to a guide who clicked Accept AFTER another guide
 * already claimed the tour — distinguishable from "superseded" because the
 * guide actively tried to accept rather than simply not responding yet.
 */
export async function markOfferAlreadyAssigned(
  slackUserId: string,
  channelId: string,
  messageTs: string,
  tourId: string
): Promise<void> {
  logger.info(
    `[slackService] Notifying guide ${slackUserId} that tour ${tourId} is already assigned`
  );

  await boltApp.client.chat.update({
    channel: channelId,
    ts: messageTs,
    text: `Tour ${tourId} has already been assigned.`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text:
            `*Tour ${tourId} — Already Assigned* ⚡\n\n` +
            `Another guide accepted this tour just before you. ` +
            `It has already been assigned — no action needed.`,
        },
      },
    ],
  });
}

// ── Admin notifications ───────────────────────────────────────────────────────

/**
 * Posts a notification message to the configured admin / ops Slack channel.
 */
export async function notifyAdminChannel(message: string): Promise<void> {
  const adminChannels = (process.env.SLACK_ADMIN_CHANNEL_IDS || '')
    .split(',')
    .map(id => id.trim())
    .filter(Boolean);

  if (adminChannels.length === 0) {
    logger.warn('[slackService] SLACK_ADMIN_CHANNEL_IDS not set — skipping admin notification');
    return;
  }

  logger.info(`[slackService] Notifying ${adminChannels.length} admin(s)`);

  await Promise.all(
    adminChannels.map(channel =>
      boltApp.client.chat.postMessage({
        channel,
        text: message,
      })
    )
  );
}

// ── Block Kit helpers ─────────────────────────────────────────────────────────

/**
 * Builds the Block Kit blocks for an active offer message (with buttons).
 * Extracted so it can be tested independently of the Slack API call.
 */
function buildActiveOfferBlocks(tour: Tour, metadataStr: string): (KnownBlock | Block)[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text:
          `*New Tour Offer* 🗺️\n\n` +
          `*Tour:* ${tour.name}\n` +
          `*Type:* ${tour.tourType}\n` +
          `*Start:* ${formatForSlack(new Date(tour.startTime))}\n` +
          `*End:* ${formatForSlack(new Date(tour.endTime))}\n\n` +
          `This offer is open to multiple guides — first to accept gets the tour.`,
      },
    },
    {
      type: 'actions',
      // Use a stable block_id so we can update/replace this block later
      block_id: `offer_actions_${JSON.parse(metadataStr).offerId}`,
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '✅ Accept' },
          style: 'primary',
          action_id: SlackActionId.ACCEPT_OFFER,
          value: metadataStr,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '❌ Decline' },
          style: 'danger',
          action_id: SlackActionId.DECLINE_OFFER,
          value: metadataStr,
        },
      ],
    },
  ];
}