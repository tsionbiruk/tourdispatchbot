// src/types/tour.ts

/**
 * Represents a tour item from the monday.com Tours board.
 */
export interface Tour {
  /** monday.com item ID */
  id: string;
  name: string;
  /** ISO 8601 start datetime */
  startTime: string;
  /** ISO 8601 end datetime */
  endTime: string;
  /** e.g. "walking", "bus", "boat" — used to match guide qualifications */
  tourType: string;
  /** Current status column value on monday.com */
  status: string;
  /** monday.com item ID of the currently assigned guide, if any */
  assignedGuideId?: string;

  // ── Dispatch flow ──────────────────────────────────────────────────────────

  /**
   * How guides were selected for this tour's dispatch.
   * Set when the manager triggers dispatch via the Monday button/action.
   */
  dispatchMode?: DispatchMode;

  /**
   * Guide IDs explicitly chosen by the manager.
   * Only relevant when dispatchMode === "manual_selection".
   */
  manualGuideIds?: string[];

  /**
   * Whether this tour has been successfully assigned to a guide.
   * Once true, no further acceptances should be processed.
   */
  isAssigned: boolean;

  /**
   * The monday.com guide ID of the guide who accepted the offer.
   * Populated when isAssigned becomes true.
   */
  acceptedGuideId?: string;

  // ── Deprecated (kept for backward compatibility) ───────────────────────────

  /**
   * @deprecated No longer used. Was part of the old sequential offer flow.
   * Friendly name of the last guide contacted.
   */
  lastGuideContacted?: string;

  /**
   * @deprecated No longer used. Was part of the old sequential offer flow.
   * ISO timestamp of when the last offer was sent.
   */
  lastOfferSentAt?: string;
}

/**
 * How guides are selected when a dispatch is triggered.
 *
 * - "all_guides"        → every eligible guide receives the offer simultaneously
 * - "manual_selection"  → only the guides explicitly chosen by the manager receive it
 */
export type DispatchMode = 'all_guides' | 'manual_selection';

/**
 * Payload received from the monday.com webhook when a status changes.
 */
export interface MondayStatusWebhookPayload {
  event: {
    type: 'StatusChanged';
    boardId: number;
    itemId: number;
    columnId: string;
    previousValue: { label: string; index: number };
    value: { label: string; index: number };
    userId: number;
    createdAt: string;
  };
}

/**
 * Payload received from the monday.com webhook when a manager clicks the
 * "Start Guide Search" button/action on a tour item.
 *
 * This replaces the old status-change trigger ("needed").
 * The `dispatchMode` and optional `manualGuideIds` are passed through
 * as button context values configured in the monday.com board.
 */
export interface MondayDispatchTriggerPayload {
  event: {
    type: 'ButtonClicked' | 'ActionTriggered';
    boardId: number;
    itemId: number;
    /** The monday.com user who clicked the button */
    userId: number;
    createdAt: string;
    /** Passed from the button's context payload */
    data: {
      dispatchMode: DispatchMode;
      /**
       * Only present when dispatchMode === "manual_selection".
       * Contains monday.com item IDs of the selected guides.
       */
      manualGuideIds?: string[];
    };
  };
}

/**
 * Union of all Monday webhook payload shapes this backend handles.
 */
export type MondayWebhookPayload =
  | MondayStatusWebhookPayload
  | MondayDispatchTriggerPayload;

/**
 * Type guard — narrows a webhook payload to a dispatch trigger.
 */
export function isDispatchTrigger(
  payload: MondayWebhookPayload
): payload is MondayDispatchTriggerPayload {
  return (
    payload.event.type === 'ButtonClicked' ||
    payload.event.type === 'ActionTriggered'
  );
}

/**
 * Type guard — narrows a webhook payload to a status change.
 */
export function isStatusChange(
  payload: MondayWebhookPayload
): payload is MondayStatusWebhookPayload {
  return payload.event.type === 'StatusChanged';
}