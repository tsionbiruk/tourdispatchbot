/**
 * Represents a tour reference from the Team Members board.
 * This can come from a Connect Boards column or from plain text.
 */
export interface TourReference {
  id?: string | number;
  name?: string;
  title?: string;
}

/**
 * Represents a tour guide fetched from the monday.com Team Members board.
 */
export interface Guide {
  /** monday.com item ID from the Team Members board */
  id: string;

  name: string;

  slackUserId: string;

  /**
   * Tours this person can guide.
   */
  guidedTours?: TourReference[];

  /**
   * Tours this person can host.
   */
  hostedTours?: TourReference[];
}