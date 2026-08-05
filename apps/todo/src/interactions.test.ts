import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { afterCompletionHold, COMPLETION_HOLD_MS } from "./interactions";

afterEach(() => vi.useRealTimers());

describe("task interaction timing", () => {
  it("holds a completed task in place long enough to register its checked state", () => {
    vi.useFakeTimers();
    const complete = vi.fn();

    afterCompletionHold(complete);
    vi.advanceTimersByTime(COMPLETION_HOLD_MS - 1);
    expect(complete).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(complete).toHaveBeenCalledOnce();
  });
});
