/**
 * app.ts
 *
 * Application entry point.
 *
 * Responsibilities:
 *  - Initialise Slack Bolt app
 *  - Initialise SQLite database
 *  - Mount Express routes
 *  - Register Bolt action handlers (Accept / Decline buttons)
 *  - Start the background scheduler
 *  - Start the HTTP server
 */

import 'dotenv/config';
import { WebClient } from '@slack/web-api';
import express, { Request, Response, NextFunction } from 'express';
import { App as BoltApp, ExpressReceiver } from '@slack/bolt';
import { initDb } from './services/offerService';
import { initSlack } from './services/slackService';
import { startScheduler } from './services/schedulerService';
import { handleAccept, handleDecline } from './routes/slackInteractions';
import mondayWebhookRouter from './routes/mondayWebhook';
import slackInteractionsRouter from './routes/slackInteractions';
import { SlackActionId, OfferMetadata } from './types/slack';
import { logger } from './utils/logger';

const PORT = parseInt(process.env.PORT || '3000', 10);
const slackTestClient = new WebClient(process.env.SLACK_BOT_TOKEN || '');

// ---------------------------------------------------------------------------
// Slack Bolt — using ExpressReceiver so we can share the Express app
// ---------------------------------------------------------------------------

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET || '',
  // We handle /slack/interactions ourselves, so disable Bolt's built-in endpoint
  endpoints: '/slack/events',
});

const boltApp = new BoltApp({
  token: process.env.SLACK_BOT_TOKEN || '',
  receiver,
});

// ---------------------------------------------------------------------------
// Register Bolt action handlers for interactive buttons
// ---------------------------------------------------------------------------

boltApp.action(SlackActionId.ACCEPT_OFFER, async ({ ack, body, action }) => {
  await ack();

  // @ts-expect-error Bolt types are loose around action.value
  const meta: OfferMetadata = JSON.parse(action.value);
  await handleAccept(meta, {
    type: body.type,
    trigger_id: (body as unknown as { trigger_id: string }).trigger_id ?? '',
    user: {
      id: body.user.id,
      name: (body.user as { id: string; name?: string }).name ?? body.user.id,
    },
    // @ts-expect-error channel may not exist on all body types
    channel: body.channel,
    // @ts-expect-error message may not exist on all body types
    message: body.message,
    actions: [],
  });
});

boltApp.action(SlackActionId.DECLINE_OFFER, async ({ ack, body, action }) => {
  await ack();

  // @ts-expect-error Bolt types are loose around action.value
  const meta: OfferMetadata = JSON.parse(action.value);
  await handleDecline(meta, {
    type: body.type,
    trigger_id: (body as unknown as { trigger_id: string }).trigger_id ?? '',
    user: {
      id: body.user.id,
      name: (body.user as { id: string; name?: string }).name ?? body.user.id,
    },
    // @ts-expect-error channel may not exist on all body types
    channel: body.channel,
    // @ts-expect-error message may not exist on all body types
    message: body.message,
    actions: [],
  });
});
// ---------------------------------------------------------------------------
// Express app (shared with Bolt via receiver.app)
// ---------------------------------------------------------------------------

const app = receiver.app;

app.use(express.json({ verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
  // Preserve raw body for monday.com signature verification
  req.rawBody = buf;
}}));
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

import { openDispatch, updateOfferSlackMessage } from './services/offerService';

app.get('/test-slack', async (_req, res) => {
  try {
    const slackUserId = 'U0ARED834HM';
    const testTourId = 'test-tour-001';
    const testGuideId = 'test-guide-001';

    const offerIds = openDispatch(
      testTourId,
      [{ guideId: testGuideId, slackUserId }],
      'manual_selection',
      [testGuideId]
    );

    const offerId = offerIds[0];

    if (!offerId) {
      throw new Error('Failed to create test offer');
    }

    const openResult = await slackTestClient.conversations.open({
      users: slackUserId,
    });

    const dmChannelId = openResult.channel?.id;
    if (!dmChannelId) {
      throw new Error('Could not open DM channel');
    }

    const postResult = await slackTestClient.chat.postMessage({
      channel: dmChannelId,
      text: 'New tour offer available',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: '*New Tour Offer*\n*Tour:* Colosseum Night Tour\n*Date:* 2026-04-10\n*Time:* 19:00 - 21:00\n*Meeting Point:* Piazza Venezia',
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Can you take this tour?',
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Accept' },
              style: 'primary',
              action_id: 'accept_offer',
              value: JSON.stringify({
                offerId,
                tourId: testTourId,
                guideId: testGuideId,
              }),
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Decline' },
              style: 'danger',
              action_id: 'decline_offer',
              value: JSON.stringify({
                offerId,
                tourId: testTourId,
                guideId: testGuideId,
              }),
            },
          ],
        },
      ],
    });

    updateOfferSlackMessage(offerId, dmChannelId, postResult.ts as string);

    res.json({ ok: true, offerId });
  } catch (error) {
    console.error(error);
    res.status(500).json({ ok: false, error: 'Failed to send Slack test message' });
  }
});
// monday.com webhooks
app.use('/webhooks/monday', mondayWebhookRouter);

// Slack interactive components (fallback / non-Bolt path)
app.use('/slack/interactions', slackInteractionsRouter);

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error('[app] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function bootstrap(): Promise<void> {
  // 1. Open SQLite database
  initDb();

  // 2. Share Bolt client with slackService
  initSlack(boltApp);

  // 3. Start background scheduler
  startScheduler();

  // 4. Start HTTP server
  await boltApp.start(PORT);
  logger.info(`[app] 🚀 tour-dispatch-bot listening on port ${PORT}`);
}

bootstrap().catch((err) => {
  logger.error('[app] Fatal startup error:', err);
  process.exit(1);
});
