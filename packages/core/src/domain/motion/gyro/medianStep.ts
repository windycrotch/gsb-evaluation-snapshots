/**
 * The typical spacing between stamps, in their own unit, told robustly enough that a record of
 * three samples still tells its rate though one of them is a stray.
 *
 * Two estimates are made and the smaller positive one wins, because each can only be too large:
 * the median of the steps between neighbours in the order recorded (a stamp left at zero, one
 * jumping back and one not a number are ignored there), and the median of every pair's span over
 * its distance. A stray in the middle doubles the first estimate, a stray at an end inflates the
 * second; the other stays right. Zero when neither estimate finds a positive, finite spacing.
 */
export function medianStep(stamps: Float64Array): number {
  const estimates = [neighbourStepMedian(stamps), pairSpanMedian(stamps)].filter(
    (estimate) => estimate > 0,
  );
  return estimates.length === 0 ? 0 : Math.min(...estimates);
}

/**
 * How far apart two stamps may lie and still vote with their span: enough that a pair skipping
 * over a stray or two still agrees with its neighbours, few enough that one real gap among many
 * samples does not outvote the rate.
 */
const MAX_PAIR_DISTANCE = 8;

/**
 * The lower median of the forward steps between neighbours in the order recorded.
 */
function neighbourStepMedian(stamps: Float64Array): number {
  const steps: number[] = [];
  for (let index = 1; index < stamps.length; index += 1) {
    const step = (stamps[index] ?? 0) - (stamps[index - 1] ?? 0);
    if (Number.isFinite(step) && step > 0) steps.push(step);
  }
  return lowerMedian(steps);
}

/**
 * The lower median of each pair's span over the samples between them, which a stray cannot
 * inflate so long as some pairs skip over it.
 */
function pairSpanMedian(stamps: Float64Array): number {
  const spans: number[] = [];
  for (let from = 0; from < stamps.length; from += 1) {
    const limit = Math.min(stamps.length, from + MAX_PAIR_DISTANCE + 1);
    for (let to = from + 1; to < limit; to += 1) {
      const span = ((stamps[to] ?? 0) - (stamps[from] ?? 0)) / (to - from);
      if (Number.isFinite(span) && span > 0) spans.push(span);
    }
  }
  return lowerMedian(spans);
}

/**
 * The lower of the two middle values, so an even count is not raised by its larger half.
 */
function lowerMedian(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).toSorted();
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}
