// src/services/guideSelectionService.ts

/**
 * guideSelectionService.ts
 *
 * Filters and returns guides eligible for a given tour.
 *
 * Dispatch modes:
 *   all_guides       — every eligible guide is returned
 *   manual_selection — only manager-chosen guides are returned (still filtered
 *                      for eligibility so an ineligible manual pick is rejected)
 *
 * Eligibility rules (unchanged):
 *   1. Guide must be active
 *   2. Guide must be qualified for the tour type
 *   3. Guide must have an availability window covering the entire tour
 *   4. Guide must not already be assigned to an overlapping tour
 */

import {
  getAllActiveGuides,
  getGuideAvailability,
  getAssignedToursForGuide,
} from './mondayService';
import { Tour, DispatchMode } from '../types/tour';
import { Guide } from '../types/guide';
import { windowsOverlap } from '../utils/time';
import { logger } from '../utils/logger';

export interface DispatchOptions {
  dispatchMode: DispatchMode;
  /**
   * Required when dispatchMode === "manual_selection".
   * Contains the monday.com guide IDs chosen by the manager.
   */
  manualGuideIds?: string[];
}

/**
 * Returns the list of guides who should receive an offer for the given tour,
 * respecting both eligibility rules and the chosen dispatch mode.
 *
 * The returned array has no guaranteed order — all guides in it will be
 * offered the tour simultaneously.
 */
export async function selectGuidesForTour(
  tour: Tour,
  options: DispatchOptions
): Promise<Guide[]> {
  logger.info(
    `[guideSelectionService] Selecting guides for tour ${tour.id} ` +
    `(mode: ${options.dispatchMode})`
  );

  const allActiveGuides = await getAllActiveGuides();

  // In manual_selection mode, restrict the candidate pool immediately so we
  // don't bother running eligibility checks for guides the manager didn't pick.
  const candidatePool =
    options.dispatchMode === 'manual_selection'
      ? filterToManualSelection(allActiveGuides, options.manualGuideIds ?? [], tour.id)
      : allActiveGuides;

  const eligibleGuides: Guide[] = [];

  for (const guide of candidatePool) {
    const eligible = await isGuideEligible(guide, tour);
    if (eligible) {
      eligibleGuides.push(guide);
    }
  }

  logger.info(
    `[guideSelectionService] ${eligibleGuides.length} eligible guide(s) found ` +
    `for tour ${tour.id}`
  );

  return eligibleGuides;
}

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Filters the active guide pool to only those IDs the manager selected.
 * Logs a warning for any selected ID that isn't in the active guide list.
 */
function filterToManualSelection(
  activeGuides: Guide[],
  manualGuideIds: string[],
  tourId: string
): Guide[] {
  const activeMap = new Map(activeGuides.map((g) => [g.id, g]));

  const selected: Guide[] = [];
  for (const id of manualGuideIds) {
    const guide = activeMap.get(id);
    if (guide) {
      selected.push(guide);
    } else {
      logger.warn(
        `[guideSelectionService] Manually selected guide ${id} not found in ` +
        `active guides — skipping (tour ${tourId})`
      );
    }
  }

  return selected;
}

/**
 * Determines whether a single guide is eligible for a given tour.
 * Returns false (with a reason log) if any eligibility rule is violated.
 */
async function isGuideEligible(guide: Guide, tour: Tour): Promise<boolean> {
  // Rule 1: Guide must be active
  if (!guide.isActive) {
    logger.debug(`[guideSelectionService] Guide ${guide.id} is inactive — skipping`);
    return false;
  }

  // Rule 2: Guide must be qualified for the tour type
  if (!guide.qualifications.includes(tour.tourType)) {
    logger.debug(
      `[guideSelectionService] Guide ${guide.id} not qualified for ` +
      `tour type "${tour.tourType}" — skipping`
    );
    return false;
  }

  // Rule 3: Guide must have an availability window covering the entire tour
  const availabilities = await getGuideAvailability(guide.id);
  const isTourCovered = availabilities.some(
    (avail) =>
      new Date(avail.availableFrom) <= new Date(tour.startTime) &&
      new Date(avail.availableTo) >= new Date(tour.endTime)
  );

  if (!isTourCovered) {
    logger.debug(
      `[guideSelectionService] Guide ${guide.id} not available for tour window — skipping`
    );
    return false;
  }

  // Rule 4: Guide must not be assigned to a conflicting tour
  const assignedTours = await getAssignedToursForGuide(guide.id);
  const hasConflict = assignedTours.some((assigned) =>
    windowsOverlap(assigned.startTime, assigned.endTime, tour.startTime, tour.endTime)
  );

  if (hasConflict) {
    logger.debug(
      `[guideSelectionService] Guide ${guide.id} has a scheduling conflict — skipping`
    );
    return false;
  }

  return true;
}