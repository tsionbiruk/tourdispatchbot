-- =============================================================================
-- tour-dispatch-bot — SQLite schema
-- =============================================================================
-- Run this file once to initialise the database before first use:
--   sqlite3 database/dispatch.db < database/schema.sql
-- =============================================================================

-- =============================================================================
-- tour-dispatch-bot — SQLite schema
-- =============================================================================
-- Run this file once to initialise a fresh database:
--   sqlite3 database/dispatch.db < database/schema.sql
--
-- To migrate an existing database see the MIGRATION section at the bottom.
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- tour_dispatch
-- One row per tour, tracking the overall state of its dispatch session.
--
-- status values:
--   open       — offers are live; guides can still accept
--   assigned   — one guide accepted; no further acceptances allowed
--   cancelled  — manager cancelled, or all guides declined/expired with no taker
--
-- dispatch_mode values:
--   all_guides       — every eligible guide received the offer
--   manual_selection — only manager-chosen guides received the offer
--
-- manual_guide_ids: JSON array of monday.com guide item IDs, e.g. '["g1","g2"]'
--   NULL when dispatch_mode = 'all_guides'
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tour_dispatch (
    tour_id           TEXT    PRIMARY KEY,
    status            TEXT    NOT NULL DEFAULT 'open'
                      CHECK(status IN ('open', 'assigned', 'cancelled')),
    dispatch_mode     TEXT    NOT NULL DEFAULT 'all_guides'
                      CHECK(dispatch_mode IN ('all_guides', 'manual_selection')),
    manual_guide_ids  TEXT,                      -- JSON array | NULL
    accepted_guide_id TEXT,                      -- NULL until a guide accepts
    created_at        TEXT    NOT NULL,          -- ISO 8601
    updated_at        TEXT    NOT NULL           -- ISO 8601
);

-- -----------------------------------------------------------------------------
-- offers
-- One row per (tour, guide) contact attempt within a dispatch session.
--
-- status values:
--   pending    — DM sent, awaiting guide response
--   accepted   — this guide accepted; tour_dispatch.status becomes 'assigned'
--   declined   — guide explicitly declined via Slack button
--   superseded — another guide accepted first; this offer is void
--   expired    — guide did not respond before expires_at
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS offers (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    tour_id          TEXT    NOT NULL,
    guide_id         TEXT    NOT NULL,           -- monday.com guide item ID
    slack_user_id    TEXT    NOT NULL,           -- Guide's Slack user ID
    slack_channel_id TEXT,                       -- DM channel ID (set after message sent)
    slack_message_ts TEXT,                       -- Message ts (used to update the message)
    status           TEXT    NOT NULL
                     CHECK(status IN (
                         'pending',
                         'accepted',
                         'declined',
                         'superseded',
                         'expired'
                     )),
    created_at       TEXT    NOT NULL,           -- ISO 8601
    expires_at       TEXT    NOT NULL,           -- ISO 8601
    responded_at     TEXT,                       -- ISO 8601; set on any resolution

    FOREIGN KEY (tour_id) REFERENCES tour_dispatch(tour_id)
);

CREATE INDEX IF NOT EXISTS idx_offers_tour_id  ON offers (tour_id);
CREATE INDEX IF NOT EXISTS idx_offers_status   ON offers (status);
CREATE INDEX IF NOT EXISTS idx_offers_expires  ON offers (expires_at);

-- =============================================================================
-- MIGRATION — apply these statements against an existing dispatch.db
-- (skip if initialising a fresh database from this file)
-- =============================================================================
--
-- 1. Create tour_dispatch table (replaces dispatch_state):
--
--    CREATE TABLE IF NOT EXISTS tour_dispatch (
--        tour_id           TEXT    PRIMARY KEY,
--        status            TEXT    NOT NULL DEFAULT 'open'
--                          CHECK(status IN ('open', 'assigned', 'cancelled')),
--        dispatch_mode     TEXT    NOT NULL DEFAULT 'all_guides'
--                          CHECK(dispatch_mode IN ('all_guides', 'manual_selection')),
--        manual_guide_ids  TEXT,
--        accepted_guide_id TEXT,
--        created_at        TEXT    NOT NULL,
--        updated_at        TEXT    NOT NULL
--    );
--
-- 2. Drop the old dispatch_state table (no longer used):
--
--    DROP TABLE IF EXISTS dispatch_state;
--
-- 3. Drop and recreate offers to remove the 'exhausted' status from the CHECK
--    constraint (SQLite does not support ALTER COLUMN):
--
--    -- Back up existing data first if needed:
--    -- CREATE TABLE offers_backup AS SELECT * FROM offers;
--
--    DROP TABLE IF EXISTS offers;
--    -- Then run the CREATE TABLE offers statement above.
--
-- 4. Add the FOREIGN KEY relationship (already in the new CREATE TABLE;
--    no action needed for existing rows if you trust data consistency).
--
-- =============================================================================