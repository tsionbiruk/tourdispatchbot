/**
 * offerService.ts
 *
 * Manages the full lifecycle of a tour dispatch: opening a dispatch session,
 * handling the first-accept-wins race atomically, and querying offer state.
 *
 * ── Offer statuses (per-guide row in `offers`) ───────────────────────────────
 *   pending    — DM sent, awaiting guide response
 *   accepted   — this guide accepted; tour is now assigned
 *   declined   — guide explicitly declined
 *   superseded — another guide accepted first; this offer is void
 *   expired    — guide did not respond before expires_at
 *
 * ── Dispatch statuses (per-tour row in `tour_dispatch`) ─────────────────────
 *   open       — offers are live; a guide can still accept
 *   assigned   — a guide accepted; no further acceptances allowed
 *   cancelled  — all guides declined/expired, or manager cancelled manually
 *
 * ── Race condition safety ────────────────────────────────────────────────────
 * tryAcceptOffer() wraps the acceptance check + tour assignment + offer
 * supersession in a single SQLite transaction. Because SQLite serialises
 * writes, only one concurrent caller can set tour_dispatch.status to
 * 'assigned' — all others will find it already set and return
 * { success: false, reason: 'already_assigned' }.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { logger } from '../utils/logger';
import { ONE_HOUR_MS, fromNowMs } from '../utils/time';
import { DispatchMode } from '../types/tour';
import fs from 'fs';

const DB_PATH = path.resolve(__dirname, '../../database/dispatch.db');

let db: Database.Database;

// ── Types ─────────────────────────────────────────────────────────────────────

export type OfferStatus =
  | 'pending'
  | 'accepted'
  | 'declined'
  | 'superseded'
  | 'expired';

export type DispatchStatus = 'open' | 'assigned' | 'cancelled';

export interface Offer {
  id: number;
  tourId: string;
  guideId: string;
  slackUserId: string;
  slackChannelId: string | null;
  slackMessageTs: string | null;
  status: OfferStatus;
  createdAt: string;
  expiresAt: string;
  respondedAt: string | null;
}

export interface TourDispatch {
  tourId: string;
  status: DispatchStatus;
  dispatchMode: DispatchMode;
  manualGuideIds: string[] | null;  // null when dispatchMode = 'all_guides'
  acceptedGuideId: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Returned by tryAcceptOffer so callers can act on the exact outcome.
 */
export type AcceptOfferResult =
  | { success: true; supersededOffers: Offer[] }
  | { success: false; reason: 'already_assigned' | 'offer_not_pending' | 'dispatch_not_found' };

// ── Initialisation ────────────────────────────────────────────────────────────

/**
 * Initialises (or opens) the SQLite database and ensures the schema is present.
 * Must be called once at application startup before any other offerService call.
 */


export function initDb(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Ensure the tour_dispatch table exists (idempotent — safe to run on restart).
  // The offers table is created by database/schema.sql on first setup.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tour_dispatch (
      tour_id           TEXT    PRIMARY KEY,
      status            TEXT    NOT NULL DEFAULT 'open'
                        CHECK(status IN ('open', 'assigned', 'cancelled')),
      dispatch_mode     TEXT    NOT NULL DEFAULT 'all_guides'
                        CHECK(dispatch_mode IN ('all_guides', 'manual_selection')),
      manual_guide_ids  TEXT,
      accepted_guide_id TEXT,
      created_at        TEXT    NOT NULL,
      updated_at        TEXT    NOT NULL
    );
  `);

  logger.info(`[offerService] SQLite database opened at ${DB_PATH}`);
}

/**
 * Returns the shared database instance.
 * Throws if initDb() has not been called.
 */
export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialised — call initDb() first.');
  return db;
}

// ── Dispatch lifecycle ────────────────────────────────────────────────────────

/**
 * Opens a new dispatch for a tour and creates one pending offer per target guide,
 * all within a single transaction.
 *
 * This is the single entry point for starting a dispatch session. The caller
 * (mondayWebhook) passes all selected guides and dispatch metadata at once.
 *
 * @param tourId         monday.com tour item ID
 * @param guideOffers    one entry per guide: { guideId, slackUserId }
 * @param dispatchMode   how guides were selected
 * @param manualGuideIds guide IDs chosen by manager (only for 'manual_selection')
 * @param timeoutMs      offer expiry window per guide (default: 1 hour)
 * @returns              offer row IDs in the same order as guideOffers
 */
export function openDispatch(
  tourId: string,
  guideOffers: Array<{ guideId: string; slackUserId: string }>,
  dispatchMode: DispatchMode = 'all_guides',
  manualGuideIds?: string[]
): number[] {
  const now = new Date().toISOString();
  const expiresAt = fromNowMs(ONE_HOUR_MS).toISOString();
  const manualGuideIdsJson =
    dispatchMode === 'manual_selection' && manualGuideIds?.length
      ? JSON.stringify(manualGuideIds)
      : null;

  const offerIds: number[] = [];

  const transaction = db.transaction(() => {
    // 1. Create or reset the tour_dispatch row
    db.prepare(`
      INSERT INTO tour_dispatch
        (tour_id, status, dispatch_mode, manual_guide_ids, accepted_guide_id, created_at, updated_at)
      VALUES (?, 'open', ?, ?, NULL, ?, ?)
      ON CONFLICT(tour_id) DO UPDATE SET
        status           = 'open',
        dispatch_mode    = excluded.dispatch_mode,
        manual_guide_ids = excluded.manual_guide_ids,
        accepted_guide_id = NULL,
        updated_at       = excluded.updated_at
    `).run(tourId, dispatchMode, manualGuideIdsJson, now, now);

    // 2. Create one pending offer per guide
    const insertOffer = db.prepare(`
      INSERT INTO offers (tour_id, guide_id, slack_user_id, status, created_at, expires_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `);

    for (const { guideId, slackUserId } of guideOffers) {
      const result = insertOffer.run(tourId, guideId, slackUserId, now, expiresAt);
      offerIds.push(result.lastInsertRowid as number);
      logger.info(
        `[offerService] Created offer ${result.lastInsertRowid} for tour ${tourId} → guide ${guideId}`
      );
    }
  });

  transaction();

  logger.info(
    `[offerService] Dispatch opened for tour ${tourId}: ${offerIds.length} offer(s), mode=${dispatchMode}`
  );

  return offerIds;
}

/**
 * Attempts to accept an offer on behalf of a guide.
 *
 * Atomicity guarantee: the entire check-then-update sequence runs inside a
 * single SQLite write transaction. Because SQLite serialises concurrent
 * writers, only one simultaneous accept attempt can succeed — all others will
 * find tour_dispatch.status already 'assigned' and return
 * { success: false, reason: 'already_assigned' }.
 *
 * On success, returns the list of offers that were superseded so the caller
 * can update those guides' Slack messages.
 */
export function tryAcceptOffer(offerId: number, guideId: string): AcceptOfferResult {
  let result: AcceptOfferResult;

  const transaction = db.transaction((): AcceptOfferResult => {
    // 1. Load and validate the offer
    const offer = db.prepare(`
      SELECT
        id,
        tour_id AS tourId,
        guide_id AS guideId,
        slack_user_id AS slackUserId,
        slack_channel_id AS slackChannelId,
        slack_message_ts AS slackMessageTs,
        status,
        created_at AS createdAt,
        expires_at AS expiresAt,
        responded_at AS respondedAt
      FROM offers
      WHERE id = ?
    `).get(offerId) as Offer | undefined;

    if (!offer || offer.status !== 'pending') {
      return { success: false, reason: 'offer_not_pending' };
    }

    // 2. Load and validate the dispatch — authoritative source for "is it open?"
    const dispatch = db
      .prepare(`SELECT * FROM tour_dispatch WHERE tour_id = ?`)
      .get(offer.tourId) as TourDispatch | undefined;

    if (!dispatch) {
      return { success: false, reason: 'dispatch_not_found' };
    }

    if (dispatch.status !== 'open') {
      return { success: false, reason: 'already_assigned' };
    }

    const now = new Date().toISOString();

    // 3. Mark this offer accepted
    db.prepare(`
      UPDATE offers SET status = 'accepted', responded_at = ? WHERE id = ?
    `).run(now, offerId);

    // 4. Mark the dispatch assigned
    db.prepare(`
      UPDATE tour_dispatch
      SET status = 'assigned', accepted_guide_id = ?, updated_at = ?
      WHERE tour_id = ?
    `).run(guideId, now, offer.tourId);

    // 5. Supersede all other pending offers for this tour
    db.prepare(`
      UPDATE offers
      SET status = 'superseded', responded_at = ?
      WHERE tour_id = ? AND status = 'pending' AND id != ?
    `).run(now, offer.tourId, offerId);

    const superseded = db
      .prepare(
        `SELECT
        id,
        tour_id AS tourId,
        guide_id AS guideId,
        slack_user_id AS slackUserId,
        slack_channel_id AS slackChannelId,
        slack_message_ts AS slackMessageTs,
        status,
        created_at AS createdAt,
        expires_at AS expiresAt,
        responded_at AS respondedAt
      FROM offers
      WHERE tour_id = ? AND status = 'superseded' AND responded_at = ? AND id != ?`
      )
      .all(offer.tourId, now, offerId) as Offer[];

    logger.info(
      `[offerService] Offer ${offerId} accepted by guide ${guideId} — ` +
        `${superseded.length} offer(s) superseded for tour ${offer.tourId}`
    );

    return { success: true, supersededOffers: superseded };
  });

  result = transaction();
  return result;
}

/**
 * Cancels an open dispatch and marks any remaining pending offers as expired.
 * Safe to call when all guides declined/expired or the manager aborts.
 */
export function cancelDispatch(tourId: string): void {
  const now = new Date().toISOString();

  const transaction = db.transaction(() => {
    db.prepare(`
      UPDATE tour_dispatch SET status = 'cancelled', updated_at = ? WHERE tour_id = ?
    `).run(now, tourId);

    db.prepare(`
      UPDATE offers SET status = 'expired', responded_at = ?
      WHERE tour_id = ? AND status = 'pending'
    `).run(now, tourId);
  });

  transaction();
  logger.info(`[offerService] Dispatch cancelled for tour ${tourId}`);
}

// ── State queries ─────────────────────────────────────────────────────────────

/**
 * Returns true if the dispatch for this tour is still open.
 * Use as a fast pre-check before calling tryAcceptOffer.
 * (The authoritative guard is inside tryAcceptOffer's transaction.)
 */
export function isDispatchOpen(tourId: string): boolean {
  const row = db
    .prepare(`SELECT status FROM tour_dispatch WHERE tour_id = ?`)
    .get(tourId) as { status: DispatchStatus } | undefined;

  return row?.status === 'open';
}

/**
 * Returns the full dispatch record for a tour, or undefined if not started.
 */
export function getDispatch(tourId: string): TourDispatch | undefined {
  const row = db
    .prepare(`SELECT * FROM tour_dispatch WHERE tour_id = ?`)
    .get(tourId) as
    | {
        tour_id: string;
        status: DispatchStatus;
        dispatch_mode: DispatchMode;
        manual_guide_ids: string | null;
        accepted_guide_id: string | null;
        created_at: string;
        updated_at: string;
      }
    | undefined;

  if (!row) return undefined;

  return {
    tourId: row.tour_id,
    status: row.status,
    dispatchMode: row.dispatch_mode,
    manualGuideIds: row.manual_guide_ids ? JSON.parse(row.manual_guide_ids) : null,
    acceptedGuideId: row.accepted_guide_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Per-offer helpers ─────────────────────────────────────────────────────────

/**
 * Stores the Slack channel ID and message timestamp after a DM is sent.
 * These are needed to update or disable the message later.
 */
export function updateOfferSlackMessage(
  offerId: number,
  slackChannelId: string,
  slackMessageTs: string
): void {
  db.prepare(`
    UPDATE offers SET slack_channel_id = ?, slack_message_ts = ? WHERE id = ?
  `).run(slackChannelId, slackMessageTs, offerId);
}

/**
 * Marks an offer with a terminal status (declined or expired).
 * Do NOT use for acceptance — use tryAcceptOffer instead.
 */
export function resolveOffer(
  offerId: number,
  status: Exclude<OfferStatus, 'accepted' | 'superseded'>
): void {
  const respondedAt = new Date().toISOString();
  db.prepare(`
    UPDATE offers SET status = ?, responded_at = ? WHERE id = ?
  `).run(status, respondedAt, offerId);
  logger.info(`[offerService] Offer ${offerId} resolved as "${status}"`);
}

/**
 * Returns all pending offers whose expiry time has passed.
 * Called by the scheduler on each polling cycle.
 */
export function getExpiredPendingOffers(): Offer[] {
  const now = new Date().toISOString();
  return db
    .prepare(`SELECT * FROM offers WHERE status = 'pending' AND expires_at <= ?`)
    .all(now) as Offer[];
}

/**
 * Returns an offer by its ID.
 */
export function getOfferById(offerId: number): Offer | undefined {
  return db
    .prepare(`SELECT * FROM offers WHERE id = ?`)
    .get(offerId) as Offer | undefined;
}

/**
 * Returns all offers for a tour, optionally filtered by status.
 */
export function getOffersForTour(tourId: string, status?: OfferStatus): Offer[] {
  if (status) {
    return db
      .prepare(`SELECT
      id,
      tour_id AS tourId,
      guide_id AS guideId,
      slack_user_id AS slackUserId,
      slack_channel_id AS slackChannelId,
      slack_message_ts AS slackMessageTs,
      status,
      created_at AS createdAt,
      expires_at AS expiresAt,
      responded_at AS respondedAt
    FROM offers
    WHERE tour_id = ? AND status = ?`)
      .all(tourId, status) as Offer[];
  }
  return db
    .prepare(`SELECT
  id,
  tour_id AS tourId,
  guide_id AS guideId,
  slack_user_id AS slackUserId,
  slack_channel_id AS slackChannelId,
  slack_message_ts AS slackMessageTs,
  status,
  created_at AS createdAt,
  expires_at AS expiresAt,
  responded_at AS respondedAt
FROM offers
WHERE tour_id = ?`)
    .all(tourId) as Offer[];
}