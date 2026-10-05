import axios from 'axios';
import { SlackInteractionPayload } from '../types/slack';
import { logger } from '../utils/logger';

export const DISPATCH_V2_ACTION_IDS = new Set([
  'dispatch_v2_interest',
  'dispatch_v2_interest_unavailable',
  'dispatch_v2_urgent_accept',
  'dispatch_v2_urgent_unavailable',
]);

export function isDispatchV2Action(actionId: string): boolean {
  return DISPATCH_V2_ACTION_IDS.has(actionId);
}

/**
 * Forwards only namespaced Dispatch V2 actions to the separate V2 service.
 * Existing V1 action handlers never pass through this function.
 */
export async function forwardDispatchV2Interaction(
  payload: SlackInteractionPayload
): Promise<void> {
  const url = process.env.DISPATCH_V2_INTERACTIONS_URL?.trim();
  const proxySecret = process.env.DISPATCH_V2_PROXY_SECRET?.trim();

  if (!url || !proxySecret) {
    throw new Error(
      'Dispatch V2 forwarding is not configured. Set DISPATCH_V2_INTERACTIONS_URL and DISPATCH_V2_PROXY_SECRET.'
    );
  }

  await axios.post(
    url,
    { payload },
    {
      timeout: 2500,
      headers: {
        Authorization: `Bearer ${proxySecret}`,
        'Content-Type': 'application/json',
      },
    }
  );

  logger.info(
    `[dispatchV2Service] Forwarded ${payload.actions[0]?.action_id ?? 'unknown'} for Slack user ${payload.user.id}`
  );
}
