export const COMPLETION_HOLD_MS = 700;

export function afterCompletionHold(complete: () => void): number {
  return window.setTimeout(complete, COMPLETION_HOLD_MS);
}
