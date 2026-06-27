// src/services/guideSelectionService.ts

import { getGuidesFromTeamBoard } from './mondayService';
import { Tour, DispatchMode } from '../types/tour';
import { Guide, TourReference } from '../types/guide';
import { logger } from '../utils/logger';

export type DispatchRole = 'guide' | 'host';

export interface DispatchOptions {
  dispatchMode: DispatchMode;
  dispatchRole: 'guide' | 'host';
  manualGuideIds?: string[];
}

function normalise(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function getTourName(tour: Tour): string {
  return normalise(tour.name ?? tour.tourType);
}

function getTourRefName(tourRef: TourReference): string {
  return normalise(tourRef.name ?? tourRef.title);
}

function tourRefMatchesTour(tourRef: TourReference, tour: Tour): boolean {
  const refId = tourRef.id !== undefined ? String(tourRef.id).trim() : '';
  const tourId = tour.id !== undefined ? String(tour.id).trim() : '';

  if (refId && tourId && refId === tourId) {
    return true;
  }

  const refName = getTourRefName(tourRef);
  const tourName = getTourName(tour);

  return Boolean(refName && tourName && refName === tourName);
}

export function isGuideEligibleForTour(
  guide: Guide,
  tour: Tour,
  dispatchRole: DispatchRole = 'guide'
): boolean {
  const guidedTours = guide.guidedTours ?? [];
  const hostedTours = guide.hostedTours ?? [];

  if (dispatchRole === 'host') {
    return hostedTours.some((tourRef) => tourRefMatchesTour(tourRef, tour));
  }

  return guidedTours.some((tourRef) => tourRefMatchesTour(tourRef, tour));
}

export async function selectGuidesForTour(
  tour: Tour,
  options: DispatchOptions
): Promise<Guide[]> {
  const dispatchRole: DispatchRole = options.dispatchRole ?? 'guide';

  logger.info(
    `[guideSelectionService] Selecting ${dispatchRole}s for tour ${tour.id} with mode: ${options.dispatchMode}`
  );

  const candidates: Guide[] =
    options.dispatchMode === 'manual_selection'
      ? await getGuidesFromTeamBoard(options.manualGuideIds ?? [])
      : await getGuidesFromTeamBoard();

  logger.info(
    `[guideSelectionService] ${candidates.length} candidate(s) before ${dispatchRole} eligibility filtering`
  );

  const eligibleGuides = candidates.filter((guide) =>
    isGuideEligibleForTour(guide, tour, dispatchRole)
  );

  const skippedGuides = candidates.filter(
    (guide) => !isGuideEligibleForTour(guide, tour, dispatchRole)
  );

  logger.info(
    `[guideSelectionService] ${eligibleGuides.length} eligible ${dispatchRole}(s) after filtering`
  );

  if (skippedGuides.length > 0) {
    logger.debug(
      `[guideSelectionService] Skipped ${dispatchRole}(s): ${JSON.stringify(
        skippedGuides.map((guide) => ({
          id: guide.id,
          name: guide.name,
          reason:
            dispatchRole === 'host'
              ? 'Tour not found in hostedTours'
              : 'Tour not found in guidedTours',
        }))
      )}`
    );
  }

  return eligibleGuides;
}