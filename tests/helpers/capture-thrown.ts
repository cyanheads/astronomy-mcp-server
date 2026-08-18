/**
 * @fileoverview Helper for the throw-then-inspect assertions: run a function that
 *   is expected to throw and hand back the thrown value shaped for the fields the
 *   error-contract tests read — the JSON-RPC code, the contract `reason`, and the
 *   recovery hint. `expect(() => …).toThrow()` proves only that something threw;
 *   these tests assert on which contract entry fired.
 * @module tests/helpers/capture-thrown
 */

/** The client-visible slice of a thrown `McpError` the contract tests assert on. */
export interface ThrownError {
  code?: number;
  data?: {
    reason?: string;
    recovery?: { hint?: string };
  };
  message?: string;
}

/**
 * Invoke `fn` and return whatever it threw. Returns `undefined` when nothing was
 * thrown, so the caller's `reason` assertion is what fails — not an access on a
 * value that was never produced.
 */
export function captureThrown(fn: () => unknown): ThrownError | undefined {
  try {
    fn();
  } catch (e) {
    return e as ThrownError;
  }
  return undefined;
}

/**
 * Async twin of {@link captureThrown} for handlers that return a promise. Awaits
 * `fn` and returns whatever it rejected with, or `undefined` when it resolved.
 */
export async function captureRejected(fn: () => unknown): Promise<ThrownError | undefined> {
  try {
    await fn();
  } catch (e) {
    return e as ThrownError;
  }
  return undefined;
}
