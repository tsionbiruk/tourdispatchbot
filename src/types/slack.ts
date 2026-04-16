/**
 * Slack-related types for offer messages and interaction payloads.
 */

/**
 * The action IDs used in Slack interactive messages sent to guides.
 */
export enum SlackActionId {
  ACCEPT_OFFER = 'accept_offer',
  DECLINE_OFFER = 'decline_offer',
}

/**
 * Metadata embedded in each Slack offer message so we can correlate
 * a button click back to the correct offer record.
 */
export interface OfferMetadata {
  offerId: number;
  tourId: string;
  guideId: string;
}

/**
 * Parsed Slack Block Kit interaction payload (subset we care about).
 */
export interface SlackInteractionPayload {
  type: string;
  callback_id?: string;
  trigger_id: string;
  user: {
    id: string;
    name: string;
  };
  actions: Array<{
    action_id: string;
    value: string;
  }>;
  /** JSON-stringified OfferMetadata */
  view?: { private_metadata?: string };
  message?: { ts: string };
  channel?: { id: string };
}
