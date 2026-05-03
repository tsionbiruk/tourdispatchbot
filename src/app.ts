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
import express, { Request, Response, NextFunction } from 'express';
import { App as BoltApp, ExpressReceiver } from '@slack/bolt';
import { initDb } from './services/offerService';
import { initSlack } from './services/slackService';
import slackInteractionsRouter from './routes/slackInteractions';
import { startScheduler } from './services/schedulerService';
import { handleAccept, handleDecline } from './routes/slackInteractions';
import mondayWebhookRouter from './routes/mondayWebhook';
import { SlackActionId, OfferMetadata } from './types/slack';
import { logger } from './utils/logger';

const PORT = parseInt(process.env.PORT || '3000', 10);

// ---------------------------------------------------------------------------
// Slack Bolt — using ExpressReceiver so we can share the Express app
// ---------------------------------------------------------------------------

const requiredEnvVars = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'MONDAY_API_TOKEN',
  'MONDAY_TOURS_BOARD_ID',
  'MONDAY_TEAM_MEMBERS_BOARD_ID',
];

for (const key of requiredEnvVars) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

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
app.use('/slack/interactions', slackInteractionsRouter);

// Health check
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});


// monday.com webhooks
app.use('/webhooks/monday', mondayWebhookRouter);

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
