import { describe, expect, it } from "vite-plus/test";
import { keyboardCommand, viewFromTravelKey } from "./keyboard";

function key(
  value: string,
  modifiers: Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "shiftKey">> = {},
  target?: HTMLElement,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { key: value, ...modifiers });
  if (target) Object.defineProperty(event, "target", { value: target });
  return event;
}

describe("Daylight keyboard commands", () => {
  it("uses a browser-safe go-to sequence for list travel", () => {
    expect(keyboardCommand(key("g"))).toEqual({ type: "begin-travel" });
    expect(viewFromTravelKey("i")).toBe("inbox");
    expect(viewFromTravelKey("l")).toBe("logbook");
  });

  it("supports the selection-first task loop", () => {
    expect(keyboardCommand(key("Enter"))).toEqual({ type: "open" });
    expect(keyboardCommand(key(" "))).toEqual({ type: "create", belowSelection: true });
    expect(keyboardCommand(key("Enter", { shiftKey: true }))).toEqual({ type: "complete" });
    expect(keyboardCommand(key("s", { shiftKey: true }))).toEqual({ type: "focus-when" });
    expect(keyboardCommand(key("d", { shiftKey: true }))).toEqual({ type: "focus-deadline" });
  });

  it("turns ordinary typing into task travel", () => {
    expect(keyboardCommand(key("w"))).toEqual({ type: "search", query: "w" });
    expect(keyboardCommand(key("/"))).toEqual({ type: "search" });
  });

  it("does not intercept task commands while typing into a field", () => {
    const input = document.createElement("input");
    expect(keyboardCommand(key("s", { shiftKey: true }, input))).toBeNull();
    expect(keyboardCommand(key("w", {}, input))).toBeNull();
    expect(keyboardCommand(key("Enter", { metaKey: true }, input))).toEqual({ type: "close" });
  });
});
