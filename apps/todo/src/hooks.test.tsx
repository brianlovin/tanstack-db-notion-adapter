import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { useSession } from "./hooks";

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
});

describe("offline session bootstrap", () => {
  it("opens a previously unlocked device after a network-level session failure", async () => {
    localStorage.setItem(
      "daylight:remembered-session",
      JSON.stringify({ authenticated: true, developmentBypass: false }),
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    const { result } = renderHook(() => useSession());

    await waitFor(() => expect(result.current.session?.authenticated).toBe(true));
    expect(result.current.error).toBeNull();
  });

  it("clears the remembered unlock even when logout cannot reach the server", async () => {
    localStorage.setItem(
      "daylight:remembered-session",
      JSON.stringify({ authenticated: true, developmentBypass: false }),
    );
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const { result } = renderHook(() => useSession());
    await waitFor(() => expect(result.current.session?.authenticated).toBe(true));

    await act(async () => {
      await expect(result.current.logout()).rejects.toThrow("offline");
    });

    expect(localStorage.getItem("daylight:remembered-session")).toBeNull();
    await waitFor(() => expect(result.current.session?.authenticated).toBe(false));
  });
});
