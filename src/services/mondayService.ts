/**
 * mondayService.ts
 *
 * All monday.com GraphQL interactions live here.
 * Methods are structured around the three relevant boards:
 *   - Tours board        (MONDAY_TOURS_BOARD_ID)
 *   - Availability board (MONDAY_AVAILABILITY_BOARD_ID)
 *   - Guide Info board   (MONDAY_GUIDE_INFO_BOARD_ID)
 *
 * Column IDs are read from environment variables — set them all in .env.
 * Methods marked [STUB] return realistic mock data during development and
 * must be replaced with real GraphQL queries before going to production.
 *
 * Dispatch trigger model (new):
 *   Guide search is NOT triggered by a status change to "Needed".
 *   It is triggered by a monday.com button column (or automation action)
 *   that fires a webhook whose event.type matches MONDAY_DISPATCH_TRIGGER_TYPE.
 *
 *   The webhook payload carries:
 *     event.type         — the trigger type (see MONDAY_DISPATCH_TRIGGER_TYPE)
 *     event.itemId       — the tour's monday.com item ID
 *     event.data         — optional JSON object embedded by the button context:
 *       dispatchMode     — "all_guides" | "manual_selection"
 *       manualGuideIds   — string[] (only when dispatchMode = "manual_selection")
 *
 *   If monday.com does not natively support embedding JSON in button context,
 *   the dispatchMode can instead be read from a dedicated dropdown column on
 *   the Tours board (MONDAY_TOUR_DISPATCH_MODE_COLUMN_ID) and the manual guide
 *   IDs from a people/text column (MONDAY_TOUR_MANUAL_GUIDES_COLUMN_ID).
 *   See parseTourDispatchColumns() below for that alternative.
 */

import { Tour, DispatchMode } from '../types/tour';
import { Guide, GuideAvailability } from '../types/guide';
import { logger } from '../utils/logger';

// ── Monday API config ─────────────────────────────────────────────────────────

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_TOKEN   = process.env.MONDAY_API_TOKEN || '';

// ── Board IDs ─────────────────────────────────────────────────────────────────

const TOURS_BOARD_ID        = process.env.MONDAY_TOURS_BOARD_ID        || '';
const AVAILABILITY_BOARD_ID = process.env.MONDAY_AVAILABILITY_BOARD_ID || '';
const GUIDE_INFO_BOARD_ID   = process.env.MONDAY_GUIDE_INFO_BOARD_ID   || '';

// ── Tours board: input columns ────────────────────────────────────────────────
// These are read by the webhook to determine how to dispatch.

const DISPATCH_TRIGGER_COLUMN_ID    = process.env.MONDAY_DISPATCH_TRIGGER_COLUMN_ID    || 'dispatch_trigger';
const TOUR_DISPATCH_MODE_COLUMN_ID  = process.env.MONDAY_TOUR_DISPATCH_MODE_COLUMN_ID  || 'dispatch_mode';
const TOUR_MANUAL_GUIDES_COLUMN_ID  = process.env.MONDAY_TOUR_MANUAL_GUIDES_COLUMN_ID  || 'manual_guides';

// ── Tours board: output/metadata columns ──────────────────────────────────────
// These are written back after dispatch actions.

const TOUR_STATUS_COLUMN_ID         = process.env.MONDAY_TOUR_STATUS_COLUMN_ID         || 'status';
const TOUR_START_COLUMN_ID          = process.env.MONDAY_TOUR_START_COLUMN_ID          || 'date';
const TOUR_END_COLUMN_ID            = process.env.MONDAY_TOUR_END_COLUMN_ID            || 'date_end';
const TOUR_TYPE_COLUMN_ID           = process.env.MONDAY_TOUR_TYPE_COLUMN_ID           || 'tour_type';
const DISPATCH_STATUS_COLUMN_ID     = process.env.MONDAY_DISPATCH_STATUS_COLUMN_ID     || 'dispatch_status';
const TOUR_ASSIGNED_GUIDE_COLUMN_ID = process.env.MONDAY_TOUR_ASSIGNED_GUIDE_COLUMN_ID || 'assigned_guide';

// ── Webhook trigger type ──────────────────────────────────────────────────────

/**
 * The monday.com event type string that indicates a manager clicked the
 * "Start Guide Search" button on a tour item.
 *
 * Common values:
 *   "ButtonClicked"    — native monday button column
 *   "ActionTriggered"  — monday automation action
 *
 * Set MONDAY_DISPATCH_TRIGGER_TYPE in .env to match your board configuration.
 */
export const MONDAY_DISPATCH_TRIGGER_TYPE =
  process.env.MONDAY_DISPATCH_TRIGGER_TYPE || 'ButtonClicked';

// ── Generic GraphQL helper ────────────────────────────────────────────────────

async function mondayQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(MONDAY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: MONDAY_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Monday API HTTP error: ${response.status} ${response.statusText}`);
  }

  const json = (await response.json()) as {
    data: T;
    errors?: { message: string }[];
  };

  if (json.errors?.length) {
    throw new Error(
      `Monday GraphQL errors: ${json.errors.map((e) => e.message).join(', ')}`
    );
  }

  return json.data;
}

// ── Webhook payload helpers ───────────────────────────────────────────────────

/**
 * Returns true if the webhook payload represents a dispatch trigger event.
 *
 * Matches on either:
 *   a) event.type === MONDAY_DISPATCH_TRIGGER_TYPE  (button click)
 *   b) event.columnId === DISPATCH_TRIGGER_COLUMN_ID (column-change fallback)
 */
export function isDispatchTriggerEvent(payload: unknown): boolean {
  const event = (payload as Record<string, unknown>)?.event as
    | Record<string, unknown>
    | undefined;

  if (!event) return false;

  if (event.type === MONDAY_DISPATCH_TRIGGER_TYPE) return true;

  if (
    event.columnId !== undefined &&
    String(event.columnId) === DISPATCH_TRIGGER_COLUMN_ID
  ) {
    return true;
  }

  return false;
}

/**
 * Extracts the tour item ID from a monday.com webhook payload.
 *
 * Handles the three field name variants monday uses across different event types:
 *   event.itemId   — most common
 *   event.pulseId  — legacy board webhooks
 *   event.item_id  — some automation payloads
 *
 * Returns null if no item ID can be found.
 */
export function getWebhookItemId(payload: unknown): string | null {
  const event = (payload as Record<string, unknown>)?.event as
    | Record<string, unknown>
    | undefined;

  if (!event) return null;

  const raw =
    event.itemId ??
    event.pulseId ??
    event.item_id ??
    '';

  const id = String(raw).trim();
  return id || null;
}

// ── Tours board ───────────────────────────────────────────────────────────────

/**
 * Fetches a single tour item from the Tours board by item ID.
 *
 * [STUB] Returns mock data. Replace with real GraphQL, e.g.:
 *
 *   const data = await mondayQuery<{
 *     items: { id: string; name: string; column_values: { id: string; text: string; value: string }[] }[]
 *   }>(`
 *     query {
 *       items(ids: [${itemId}]) {
 *         id
 *         name
 *         column_values {
 *           id
 *           text
 *           value
 *         }
 *       }
 *     }
 *   `);
 *   return mapMondayItemToTour(data.items[0]);
 */
export async function getTourById(itemId: string): Promise<Tour> {
  logger.info(`[mondayService] Fetching tour item ${itemId}`);

  // [STUB] — replace with real query + mapMondayItemToTour()
  return {
    id: itemId,
    name: 'Mock Tour Name',
    startTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    endTime: new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString(),
    tourType: 'walking',
    status: 'Available',
    isAssigned: false,
    assignedGuideId: undefined,
    acceptedGuideId: undefined,
    dispatchMode: undefined,
    manualGuideIds: undefined,
  };
}

/**
 * Reads dispatch configuration directly from a tour's board columns.
 *
 * Use this when dispatch mode and manual guide IDs are stored as column values
 * on the Tours board rather than being embedded in the button click payload.
 *
 * Returns:
 *   dispatchMode    — parsed from MONDAY_TOUR_DISPATCH_MODE_COLUMN_ID
 *   manualGuideIds  — parsed from MONDAY_TOUR_MANUAL_GUIDES_COLUMN_ID (may be [])
 *
 * [STUB] Returns mock values. Replace with real GraphQL query.
 */
export async function parseTourDispatchColumns(itemId: string): Promise<{
  dispatchMode: DispatchMode;
  manualGuideIds: string[];
}> {
  logger.info(`[mondayService] Reading dispatch columns for tour ${itemId}`);

  // [STUB] — replace with:
  //
  // const data = await mondayQuery<{
  //   items: { column_values: { id: string; text: string; value: string }[] }[]
  // }>(`
  //   query {
  //     items(ids: [${itemId}]) {
  //       column_values(ids: [
  //         "${TOUR_DISPATCH_MODE_COLUMN_ID}",
  //         "${TOUR_MANUAL_GUIDES_COLUMN_ID}"
  //       ]) {
  //         id text value
  //       }
  //     }
  //   }
  // `);
  //
  // const cols = data.items[0].column_values;
  // const modeCol   = cols.find((c) => c.id === TOUR_DISPATCH_MODE_COLUMN_ID);
  // const guidesCol = cols.find((c) => c.id === TOUR_MANUAL_GUIDES_COLUMN_ID);
  //
  // const dispatchMode: DispatchMode =
  //   modeCol?.text === 'manual_selection' ? 'manual_selection' : 'all_guides';
  //
  // const manualGuideIds: string[] =
  //   dispatchMode === 'manual_selection'
  //     ? parseManualGuideIds(guidesCol?.value ?? null)
  //     : [];
  //
  // return { dispatchMode, manualGuideIds };

  return { dispatchMode: 'all_guides', manualGuideIds: [] };
}

/**
 * Parses a raw monday.com column value for a people/text column into guide IDs.
 *
 * Supports two formats:
 *   1. People column JSON: { "personsAndTeams": [{ "id": "123" }] }
 *   2. Plain text: comma-separated IDs, e.g. "guide_001,guide_002"
 *
 * Returns an empty array on any parse failure — the caller should treat this
 * as "no guides selected" and fall back to 'all_guides' mode or notify admin.
 */
export function parseManualGuideIds(rawValue: string | null): string[] {
  if (!rawValue) return [];

  try {
    const parsed = JSON.parse(rawValue) as {
      personsAndTeams?: { id: string }[];
    };
    if (Array.isArray(parsed.personsAndTeams)) {
      return parsed.personsAndTeams.map((p) => String(p.id)).filter(Boolean);
    }
  } catch {
    // Not JSON — try comma-separated plain text
    return rawValue
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  return [];
}

// ── Tours board: write helpers ────────────────────────────────────────────────

/**
 * Updates one or more workflow fields on the Tours board.
 *
 * Writes to distinct columns depending on the field:
 *   status          → MONDAY_TOUR_STATUS_COLUMN_ID       (tour lifecycle status)
 *   dispatchStatus  → MONDAY_DISPATCH_STATUS_COLUMN_ID   (dispatch pipeline status)
 *   assignedGuideId → MONDAY_TOUR_ASSIGNED_GUIDE_COLUMN_ID
 *
 * Note: status and dispatchStatus intentionally map to DIFFERENT columns.
 *   - status         reflects the tour lifecycle ("Available", "Assigned", …)
 *   - dispatchStatus reflects the dispatch pipeline ("Dispatching", "No eligible guides", …)
 *
 * [STUB] Logs intent; replace body with real GraphQL mutation.
 */
export async function updateTourWorkflowFields(
  itemId: string,
  fields: {
    assignedGuideId?: string;
    acceptedGuideId?: string;
    isAssigned?: boolean;
    status?: string;
    dispatchStatus?: string;
    dispatchMode?: DispatchMode;
  }
): Promise<void> {
  logger.info(
    `[mondayService] Updating tour ${itemId} fields: ${JSON.stringify(fields)}`
  );

  // [STUB] — replace with:
  //
  // const columnValues: Record<string, unknown> = {};
  //
  // if (fields.status !== undefined) {
  //   columnValues[TOUR_STATUS_COLUMN_ID] = { label: fields.status };
  // }
  // if (fields.dispatchStatus !== undefined) {
  //   columnValues[DISPATCH_STATUS_COLUMN_ID] = { label: fields.dispatchStatus };
  // }
  // if (fields.assignedGuideId !== undefined) {
  //   columnValues[TOUR_ASSIGNED_GUIDE_COLUMN_ID] = {
  //     item_ids: [Number(fields.assignedGuideId)],
  //   };
  // }
  //
  // if (Object.keys(columnValues).length === 0) return;
  //
  // await mondayQuery(`
  //   mutation {
  //     change_multiple_column_values(
  //       board_id: ${TOURS_BOARD_ID},
  //       item_id: ${itemId},
  //       column_values: ${JSON.stringify(JSON.stringify(columnValues))}
  //     ) { id }
  //   }
  // `);
}

/**
 * Sets the dispatch pipeline status column on the Tours board.
 *
 * Expected status strings (match your monday Status column labels exactly):
 *   "Dispatching"        — offers are live in Slack
 *   "No eligible guides" — no qualified/available guides found
 *   "Dispatch failed"    — Slack sends failed entirely
 *   "Assigned"           — a guide accepted (written by the accept handler)
 *
 * This writes to MONDAY_DISPATCH_STATUS_COLUMN_ID, NOT to the tour lifecycle
 * status column (MONDAY_TOUR_STATUS_COLUMN_ID).
 */
export async function updateDispatchStatus(
  itemId: string,
  dispatchStatus: string
): Promise<void> {
  return updateTourWorkflowFields(itemId, { dispatchStatus });
}

/**
 * Marks a tour as assigned to a specific guide.
 *
 * Sets:
 *   assignedGuideId → MONDAY_TOUR_ASSIGNED_GUIDE_COLUMN_ID
 *   status          → "Assigned"  (tour lifecycle status column)
 *   dispatchStatus  → "Assigned"  (dispatch pipeline status column)
 */
export async function updateAssignedGuide(
  itemId: string,
  assignedGuideId: string
): Promise<void> {
  return updateTourWorkflowFields(itemId, {
    assignedGuideId,
    isAssigned: true,
    status: 'Assigned',
    dispatchStatus: 'Assigned',
  });
}

// ── Availability board ────────────────────────────────────────────────────────

/**
 * Fetches all availability windows for a specific guide.
 * [STUB] Returns a single wide-open window. Replace with real query.
 */
export async function getGuideAvailability(guideId: string): Promise<GuideAvailability[]> {
  logger.info(`[mondayService] Fetching availability for guide ${guideId}`);

  // [STUB]
  return [
    {
      guideId,
      availableFrom: new Date(Date.now()).toISOString(),
      availableTo: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    },
  ];
}

// ── Guide Info board ──────────────────────────────────────────────────────────

/**
 * Fetches all active guides from the Guide Info board.
 * [STUB] Returns two mock guides. Replace with real query + pagination.
 */
export async function getAllActiveGuides(): Promise<Guide[]> {
  logger.info('[mondayService] Fetching all active guides');

  // [STUB]
  return [
    {
      id: 'guide_001',
      name: 'Alice Romano',
      slackUserId: 'U00000001',
      email: 'alice@example.com',
      isActive: true,
      qualifications: ['walking', 'bus'],
      rankingScore: 90,
      hadCancellationThisMonth: true,
    },
    {
      id: 'guide_002',
      name: 'Marco Bianchi',
      slackUserId: 'U00000002',
      email: 'marco@example.com',
      isActive: true,
      qualifications: ['walking'],
      rankingScore: 85,
      hadCancellationThisMonth: false,
    },
  ];
}

/**
 * Fetches tours currently assigned to a guide (to detect scheduling conflicts).
 * [STUB] Returns empty list. Replace with real filtered query.
 */
export async function getAssignedToursForGuide(guideId: string): Promise<Tour[]> {
  logger.info(`[mondayService] Fetching assigned tours for guide ${guideId}`);

  // [STUB]
  return [];
}