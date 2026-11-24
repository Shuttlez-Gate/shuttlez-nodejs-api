import { performance } from 'node:perf_hooks';

/** Local-only opt-in timing output. It deliberately excludes identifiers and payloads. */
export function monotonicNow(): number {
  return performance.now();
}

export function recordPerformanceDiagnostic(
  event: string,
  values: Record<string, string | number | boolean | null>,
): void {
  if (process.env.SHUTTLEZ_PERF_DIAGNOSTICS !== '1') return;
  process.stdout.write(
    `${JSON.stringify({
      type: 'shuttlez.performance',
      event,
      monotonicMs: performance.now(),
      wallTime: new Date().toISOString(),
      ...values,
    })}\n`,
  );
}
