/**
 * Represents a tour guide fetched from monday.com guide boards.
 */
export interface Guide {
  /** monday.com item ID from the Guide Info board */
  id: string;
  name: string;
  slackUserId: string;
  email: string;
  /** Whether the guide is currently active and eligible for dispatch */
  isActive: boolean;
  /** Qualifications / tour types this guide is certified for */
  qualifications: string[];
  /** Ranking score for this guide (fetched from Guide Ranking board) */
  rankingScore: number;
  /** Whether this guide had a cancellation in the current month */
  hadCancellationThisMonth: boolean;
}

/**
 * Raw availability record from the monday.com Availability board.
 */
export interface GuideAvailability {
  guideId: string;
  availableFrom: string; // ISO 8601
  availableTo: string;   // ISO 8601
}

/**
 * Candidate guide after eligibility filtering — includes computed priority.
 */
export interface RankedGuide extends Guide {
  /**
   * Priority group:
   *  0 = cancelled tour in current month (highest priority)
   *  1 = standard eligible guide
   */
  priorityGroup: 0 | 1;
}
