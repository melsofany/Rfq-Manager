/**
 * Supplier standing: a named level derived from the supplier's score.
 *
 * Modelled on ERPNext's Supplier Scorecard (standings + actions), written from
 * scratch for this codebase. A standing is only given once a supplier has enough
 * evaluated offers; below that the score is shown but the level is "not_rated",
 * so one lucky or unlucky quote cannot label a supplier.
 */

/** Offers a supplier must have submitted before a standing is assigned. */
export const STANDING_MIN_SAMPLE = 3;

/** Score (0–100) at or above which a supplier is "preferred", and "watch" floor. */
export const STANDING_THRESHOLDS = { preferred: 80, watch: 60 } as const;

export type SupplierStanding = "preferred" | "watch" | "restricted" | "not_rated";

export function standingOf(totalScore: number | null, sampleSize: number): SupplierStanding {
  if (totalScore === null || sampleSize < STANDING_MIN_SAMPLE) return "not_rated";
  if (totalScore >= STANDING_THRESHOLDS.preferred) return "preferred";
  if (totalScore >= STANDING_THRESHOLDS.watch) return "watch";
  return "restricted";
}
