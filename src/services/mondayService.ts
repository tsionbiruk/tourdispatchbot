/**
 * mondayService.ts
 *
 * All monday.com GraphQL interactions live here.
 */

import { Tour, DispatchMode } from '../types/tour';
import { Guide } from '../types/guide';
import { logger } from '../utils/logger';

// ── Monday API config ─────────────────────────────────────────────────────────

const MONDAY_API_URL = 'https://api.monday.com/v2';
const MONDAY_TOKEN = process.env.MONDAY_API_TOKEN || '';

// ── Board IDs ─────────────────────────────────────────────────────────────────

const TOURS_BOARD_ID = process.env.MONDAY_TOURS_BOARD_ID || '';
const TEAM_MEMBERS_BOARD_ID = process.env.MONDAY_TEAM_MEMBERS_BOARD_ID || '';

// ── Team Members board: column IDs ────────────────────────────────────────────

const TEAM_MEMBER_SLACK_ID_COLUMN_ID =
  process.env.MONDAY_TEAM_MEMBER_SLACK_ID_COLUMN_ID || 'slack_id';

const TEAM_MEMBER_GUIDED_TOURS_COLUMN_ID =
  process.env.MONDAY_TEAM_MEMBER_GUIDED_TOURS_COLUMN_ID || 'guided_tours';

const TEAM_MEMBER_HOSTED_TOURS_COLUMN_ID =
  process.env.MONDAY_TEAM_MEMBER_HOSTED_TOURS_COLUMN_ID || 'hosted_tours';

// ── Tours board: input columns ────────────────────────────────────────────────

const TOUR_NAME_COLUMN_ID = process.env.MONDAY_TOUR_NAME_COLUMN_ID || '';
const TOUR_DISPATCH_MODE_COLUMN_ID =
  process.env.MONDAY_TOUR_DISPATCH_MODE_COLUMN_ID || 'dispatch_mode';
const TOUR_MANUAL_GUIDES_COLUMN_ID =
  process.env.MONDAY_SELECTED_GUIDES_COLUMN_ID ||
  process.env.MONDAY_TOUR_MANUAL_GUIDES_COLUMN_ID ||
  'manual_guides';

// ── Tours board: output/metadata columns ──────────────────────────────────────

const TOUR_STATUS_COLUMN_ID = process.env.MONDAY_TOUR_STATUS_COLUMN_ID || 'status';
const TOUR_START_COLUMN_ID = process.env.MONDAY_TOUR_START_COLUMN_ID || 'date';
const TOUR_END_COLUMN_ID = process.env.MONDAY_TOUR_END_COLUMN_ID || 'date_end';
const TOUR_TYPE_COLUMN_ID = process.env.MONDAY_TOUR_TYPE_COLUMN_ID || 'tour_type';
const DISPATCH_STATUS_COLUMN_ID =
  process.env.MONDAY_DISPATCH_STATUS_COLUMN_ID || 'dispatch_status';
const TOUR_ASSIGNED_GUIDE_COLUMN_ID =
  process.env.MONDAY_TOUR_ASSIGNED_GUIDE_COLUMN_ID || 'assigned_guide';
const ASSIGNED_GUIDE_COLUMN_ID = process.env.MONDAY_TOUR_ASSIGNED_GUIDE_COLUMN_ID;
// ── Webhook trigger config ────────────────────────────────────────────────────

export const MONDAY_DISPATCH_TRIGGER_TYPE =
  process.env.MONDAY_DISPATCH_TRIGGER_TYPE || 'update_column_value';

export const MONDAY_DISPATCH_TRIGGER_VALUE =
  process.env.MONDAY_DISPATCH_TRIGGER_VALUE || 'Start Dispatch';

const MONDAY_DISPATCH_TRIGGER_COLUMN_ID =
  process.env.MONDAY_DISPATCH_TRIGGER_COLUMN_ID || '';

interface MondayColumnChangeValue {
  label?: {
    text?: string;
  };
}

type MondayColumnValue = {
  id: string;
  text: string | null;
  value: string | null;
};

type MondayItem = {
  id: string;
  name: string;
  column_values: MondayColumnValue[];
};

type TourReference = {
  id?: string;
  name?: string;
};

// ── Generic helpers ───────────────────────────────────────────────────────────

async function mondayQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  if (!MONDAY_TOKEN) {
    throw new Error('Missing MONDAY_API_TOKEN in .env');
  }

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

function getColumnText(item: MondayItem, columnId: string): string {
  if (!columnId) return '';
  return item.column_values.find((c) => c.id === columnId)?.text?.trim() ?? '';
}

function getColumnValue(item: MondayItem, columnId: string): string | null {
  if (!columnId) return null;
  return item.column_values.find((c) => c.id === columnId)?.value ?? null;
}

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

function isNumericId(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

function splitCommaSeparated(text?: string | null): string[] {
  if (!text) return [];
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseDateColumn(rawValue: string | null, fallbackIso: string): string {
  if (!rawValue) return fallbackIso;

  try {
    const parsed = JSON.parse(rawValue) as {
      date?: string;
      time?: string;
      from?: string;
      to?: string;
    };

    if (parsed.date && parsed.time) return `${parsed.date}T${parsed.time}:00`;
    if (parsed.date) return `${parsed.date}T00:00:00`;
    if (parsed.from) return parsed.from;
    if (parsed.to) return parsed.to;
  } catch {
    // Ignore invalid JSON and use fallback.
  }

  return fallbackIso;
}

/**
 * Parses the manager's manual guide selection column.
 *
 * Supports:
 * - comma-separated guide names from a plain text column
 * - comma-separated Monday item IDs
 * - Monday People column JSON
 * - Monday Connect Boards-style JSON
 */
function parseManualGuideIdentifiers(
  rawValue: string | null | undefined,
  columnText?: string | null
): string[] {
  const values = new Set<string>();

  const addText = (text?: string | null) => {
    splitCommaSeparated(text).forEach((value) => values.add(value));
  };

  if (rawValue) {
    try {
      const parsed = JSON.parse(rawValue) as {
        text?: string;
        personsAndTeams?: { id: string | number }[];
        linkedPulseIds?: { linkedPulseId: string | number }[];
        item_ids?: Array<string | number>;
      };

      if (parsed.text) addText(parsed.text);

      if (Array.isArray(parsed.personsAndTeams)) {
        parsed.personsAndTeams.forEach((p) => values.add(String(p.id)));
      }

      if (Array.isArray(parsed.linkedPulseIds)) {
        parsed.linkedPulseIds.forEach((p) => values.add(String(p.linkedPulseId)));
      }

      if (Array.isArray(parsed.item_ids)) {
        parsed.item_ids.forEach((id) => values.add(String(id)));
      }
    } catch {
      addText(rawValue);
    }
  }

  addText(columnText);

  return Array.from(values).filter(Boolean);
}

function parseDispatchMode(text?: string | null): DispatchMode {
  const value = normalise(text ?? '');

  if (
    value === 'manual_selection' ||
    value === 'manual selection' ||
    value === 'selected guides' ||
    value === 'selected guide' ||
    value === 'manual' ||
    value === 'select guides'
  ) {
    return 'manual_selection';
  }

  return 'all_guides';
}

// ── Webhook payload helpers ───────────────────────────────────────────────────

export function isDispatchTriggerEvent(payload: unknown): boolean {
  const maybePayload = payload as Record<string, unknown>;

  // Supports BOTH:
  // 1. full payload: { event: {...} }
  // 2. direct event object: {...}
  const event = (maybePayload.event ?? maybePayload) as Record<string, unknown> | undefined;

  if (!event) return false;

  const expectedColumnId = process.env.MONDAY_DISPATCH_TRIGGER_COLUMN_ID;
  const expectedLabel =
    process.env.MONDAY_DISPATCH_TRIGGER_VALUE || 'Start Dispatch';

  if (event.type !== 'update_column_value') return false;

  const columnId = String(event.columnId ?? '');
  const columnTitle = String(event.columnTitle ?? '');

  const isCorrectColumn =
    columnTitle === 'Dispatch Trigger' ||
    (!!expectedColumnId && columnId === expectedColumnId);

  if (!isCorrectColumn) return false;

  const value = event.value as
    | {
        label?: {
          text?: string;
        };
      }
    | undefined;

  const label = value?.label?.text ?? '';

  return label === expectedLabel;
}

export function getWebhookItemId(payload: unknown): string | null {
  const event = (payload as Record<string, unknown>)?.event as
    | Record<string, unknown>
    | undefined;

  if (!event) return null;

  const raw = event.itemId ?? event.pulseId ?? event.item_id ?? '';
  const id = String(raw).trim();
  return id || null;
}

// ── Tours board ───────────────────────────────────────────────────────────────

export async function getTourById(itemId: string): Promise<Tour> {
  logger.info(`[mondayService] Fetching tour item ${itemId}`);

  const requestedColumnIds = [
    TOUR_NAME_COLUMN_ID,
    TOUR_START_COLUMN_ID,
    TOUR_END_COLUMN_ID,
    TOUR_TYPE_COLUMN_ID,
    TOUR_STATUS_COLUMN_ID,
    TOUR_ASSIGNED_GUIDE_COLUMN_ID,
  ].filter(Boolean);

  const columnIdsGql = requestedColumnIds.map((id) => `"${id}"`).join(', ');

  const data = await mondayQuery<{ items: MondayItem[] }>(`
    query {
      items(ids: [${itemId}]) {
        id
        name
        column_values(ids: [${columnIdsGql}]) {
          id
          text
          value
          ... on BoardRelationValue {
            linked_item_ids
            linked_items {
              id
              name
            }
          }
        }
      }
    }
  `);

  const item = data.items?.[0];

  if (!item) {
    throw new Error(`[mondayService] Tour item ${itemId} not found`);
  }

  const nameFromColumn = getColumnText(item, TOUR_NAME_COLUMN_ID);
  const tourTypeFromColumn = getColumnText(item, TOUR_TYPE_COLUMN_ID);
  const statusFromColumn = getColumnText(item, TOUR_STATUS_COLUMN_ID);
  const assignedGuideFromColumn = getColumnText(item, TOUR_ASSIGNED_GUIDE_COLUMN_ID);

  const tourName = nameFromColumn || tourTypeFromColumn || item.name;
  const startFallback = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const endFallback = new Date(Date.now() + 26 * 60 * 60 * 1000).toISOString();

  const tour: Tour = {
    id: item.id,
    name: tourName,
    startTime: parseDateColumn(getColumnValue(item, TOUR_START_COLUMN_ID), startFallback),
    endTime: parseDateColumn(getColumnValue(item, TOUR_END_COLUMN_ID), endFallback),
    tourType: tourTypeFromColumn || tourName,
    status: statusFromColumn || 'Available',
    isAssigned: Boolean(assignedGuideFromColumn),
    assignedGuideId: assignedGuideFromColumn || undefined,
    acceptedGuideId: undefined,
    dispatchMode: undefined,
    manualGuideIds: undefined,
  };

  logger.info(`[mondayService] Tour loaded: ${JSON.stringify({ id: tour.id, name: tour.name })}`);

  return tour;
}

export async function parseTourDispatchColumns(itemId: string): Promise<{
  dispatchMode: DispatchMode;
  manualGuideIds: string[];
}> {
  logger.info(`[mondayService] Reading dispatch columns for tour ${itemId}`);

  const requestedColumnIds = [
    TOUR_DISPATCH_MODE_COLUMN_ID,
    TOUR_MANUAL_GUIDES_COLUMN_ID,
  ].filter(Boolean);

  const columnIdsGql = requestedColumnIds.map((id) => `"${id}"`).join(', ');

  const data = await mondayQuery<{ items: MondayItem[] }>(`
    query {
      items(ids: [${itemId}]) {
        id
        name
        column_values(ids: [${columnIdsGql}]) {
          id
          text
          value
          ... on BoardRelationValue {
            linked_item_ids
            linked_items {
              id
              name
            }
          }
        }
      }
    }
  `);

  const item = data.items?.[0];

  if (!item) {
    throw new Error(`[mondayService] Tour item ${itemId} not found while reading dispatch columns`);
  }
  logger.info(
  `[mondayService] RAW dispatch column values for tour ${itemId}: ${JSON.stringify(item.column_values, null, 2)}`
);
  const modeText = getColumnText(item, TOUR_DISPATCH_MODE_COLUMN_ID);
  const guidesText = getColumnText(item, TOUR_MANUAL_GUIDES_COLUMN_ID);
  const guidesValue = getColumnValue(item, TOUR_MANUAL_GUIDES_COLUMN_ID);

  logger.info(
  `[mondayService] Selected guides debug: envColumnId=${TOUR_MANUAL_GUIDES_COLUMN_ID}, text=${guidesText}, value=${guidesValue}`
  );
  const guidesColumn = item.column_values.find(
  (c: any) => c.id === TOUR_MANUAL_GUIDES_COLUMN_ID
  ) as any;

  const manualGuideIds =
    Array.isArray(guidesColumn?.linked_item_ids) && guidesColumn.linked_item_ids.length > 0
      ? guidesColumn.linked_item_ids.map(String)
      : parseManualGuideIdentifiers(guidesValue, guidesText);
  const dispatchMode = manualGuideIds.length > 0 ? 'manual_selection' : parseDispatchMode(modeText);

  logger.info(
    `[mondayService] Dispatch config for tour ${itemId}: mode=${dispatchMode}, manualSelections=${JSON.stringify(manualGuideIds)}`
  );

  return { dispatchMode, manualGuideIds };
}

/**
 * Kept as an export for any older imports in your project.
 */
export function parseManualGuideIds(rawValue: string | null): string[] {
  return parseManualGuideIdentifiers(rawValue);
}

// ── Team Members board: column parsers ────────────────────────────────────────

function parseTourReferenceColumn(
  rawValue: string | null | undefined,
  columnText: string | null | undefined
): TourReference[] {
  if (rawValue) {
    try {
      const parsed = JSON.parse(rawValue) as {
        linkedPulseIds?: { linkedPulseId: number }[];
      };
      if (Array.isArray(parsed.linkedPulseIds) && parsed.linkedPulseIds.length > 0) {
        return parsed.linkedPulseIds.map((lp) => ({
          id: String(lp.linkedPulseId),
        }));
      }
    } catch {
      // Not valid JSON — fall through to dropdown/text parsing.
    }
  }

  return splitCommaSeparated(columnText).map((name) => ({ name }));
}

// ── Tours board: write helpers ────────────────────────────────────────────────

export async function updateTourWorkflowFields(
  itemId: string,
  fields: {
    assignedGuideId?: string;
    assignedGuideName?: string;
    acceptedGuideId?: string;
    isAssigned?: boolean;
    status?: string;
    dispatchStatus?: string;
    dispatchTrigger?: string;
    dispatchMode?: DispatchMode;
  }
): Promise<void> {
  logger.info(
    `[mondayService] Updating tour ${itemId} fields: ${JSON.stringify(fields)}`
  );

  const columnValues: Record<string, unknown> = {};

  if (fields.status !== undefined) {
    columnValues[TOUR_STATUS_COLUMN_ID] = { label: fields.status };
  }
  if (fields.dispatchStatus !== undefined) {
    columnValues[DISPATCH_STATUS_COLUMN_ID] = { label: fields.dispatchStatus };
  }
  if (fields.dispatchTrigger !== undefined && MONDAY_DISPATCH_TRIGGER_COLUMN_ID) {
  columnValues[MONDAY_DISPATCH_TRIGGER_COLUMN_ID] = {
    label: fields.dispatchTrigger,
  };
}
  if (fields.assignedGuideName !== undefined && ASSIGNED_GUIDE_COLUMN_ID) {
  columnValues[ASSIGNED_GUIDE_COLUMN_ID] = fields.assignedGuideName;
}

  if (Object.keys(columnValues).length === 0) return;

  await mondayQuery(`
    mutation {
      change_multiple_column_values(
        board_id: ${TOURS_BOARD_ID},
        item_id: ${itemId},
        column_values: ${JSON.stringify(JSON.stringify(columnValues))}
      ) { id }
    }
  `);
}

export async function updateDispatchStatus(
  itemId: string,
  dispatchStatus: string
): Promise<void> {
  return updateTourWorkflowFields(itemId, { dispatchStatus });
}

export async function updateAssignedGuide(
  itemId: string,
  assignedGuideId: string
): Promise<void> {
  return updateTourWorkflowFields(itemId, {
    assignedGuideId,
    isAssigned: true,
    status: 'Assigned',
    dispatchStatus: 'Complete',
    dispatchTrigger: 'Complete',
  });
}

// ── Team Members board ────────────────────────────────────────────────────────

export async function getGuidesFromTeamBoard(manualGuideIds?: string[]): Promise<Guide[]> {
  const hasManualSelections = Array.isArray(manualGuideIds) && manualGuideIds.length > 0;
  const manualSelections = hasManualSelections ? manualGuideIds! : [];
  const manualSelectionsAreItemIds = manualSelections.length > 0 && manualSelections.every(isNumericId);

  logger.info(
    hasManualSelections
      ? `[mondayService] Fetching manually selected guide(s): ${JSON.stringify(manualSelections)}`
      : '[mondayService] Fetching all guides from Team Members board'
  );

  const columnIds = [
    TEAM_MEMBER_SLACK_ID_COLUMN_ID,
    TEAM_MEMBER_GUIDED_TOURS_COLUMN_ID,
    TEAM_MEMBER_HOSTED_TOURS_COLUMN_ID,
  ];
  const columnIdsGql = columnIds.map((id) => `"${id}"`).join(', ');

  const query = manualSelectionsAreItemIds
    ? `
        query {
          items(ids: [${manualSelections.join(', ')}]) {
            id
            name
            column_values(ids: [${columnIdsGql}]) {
              id
              text
              value
            }
          }
        }
      `
    : `
        query {
          boards(ids: [${TEAM_MEMBERS_BOARD_ID}]) {
            items_page(limit: 500) {
              items {
                id
                name
                column_values(ids: [${columnIdsGql}]) {
                  id
                  text
                  value
                }
              }
            }
          }
        }
      `;

  let items: MondayItem[];

  if (manualSelectionsAreItemIds) {
    const data = await mondayQuery<{ items: MondayItem[] }>(query);
    items = data.items ?? [];
  } else {
    const data = await mondayQuery<{
      boards: { items_page: { items: MondayItem[] } }[];
    }>(query);
    items = data.boards?.[0]?.items_page?.items ?? [];
  }

  if (hasManualSelections && !manualSelectionsAreItemIds) {
    const selectedNames = new Set(manualSelections.map(normalise));
    items = items.filter((item) => selectedNames.has(normalise(item.name)));

    logger.info(
      `[mondayService] Matched ${items.length}/${manualSelections.length} manually typed guide name(s) from Team Members board`
    );
  }

  const guides: Guide[] = items
    .map((item) => {
      const slackIdCol = item.column_values.find(
        (c) => c.id === TEAM_MEMBER_SLACK_ID_COLUMN_ID
      );
      const slackUserId = slackIdCol?.text?.trim() ?? '';

      if (!slackUserId) {
        logger.warn(
          `[mondayService] Team member "${item.name}" (id: ${item.id}) has no Slack ID — skipping`
        );
        return null;
      }

      const guidedToursCol = item.column_values.find(
        (c) => c.id === TEAM_MEMBER_GUIDED_TOURS_COLUMN_ID
      );
      const hostedToursCol = item.column_values.find(
        (c) => c.id === TEAM_MEMBER_HOSTED_TOURS_COLUMN_ID
      );

      const guide = {
        id: item.id,
        name: item.name,
        slackUserId,
        guidedTours: parseTourReferenceColumn(
          guidedToursCol?.value,
          guidedToursCol?.text
        ),
        hostedTours: parseTourReferenceColumn(
          hostedToursCol?.value,
          hostedToursCol?.text
        ),
      } as Guide;

      return guide;
    })
    .filter((g): g is Guide => g !== null);

  logger.info(`[mondayService] ${guides.length} guide(s) fetched from Team Members board`);

  logger.debug(
    `[mondayService] Guide sample: ${JSON.stringify(
      guides.slice(0, 5).map((guide) => ({
        id: guide.id,
        name: guide.name,
        slackUserId: guide.slackUserId,
        guidedTours: (guide as Guide & { guidedTours?: TourReference[] }).guidedTours,
        hostedTours: (guide as Guide & { hostedTours?: TourReference[] }).hostedTours,
      }))
    )}`
  );

  return guides;
}
