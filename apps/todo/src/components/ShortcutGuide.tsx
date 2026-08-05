import { X } from "lucide-react";

const shortcuts = [
  ["New to-do / new below", "Space"],
  ["Open selection", "Return"],
  ["Close editor", "⌘ Return"],
  ["Complete selection", "⇧ Return"],
  ["Extend selection", "⇧ ↑ / ↓"],
  ["Schedule", "⇧ S"],
  ["Set deadline", "⇧ D"],
  ["Reorder", "⌥ ↑ / ↓"],
  ["Switch lists", "G then key"],
  ["Search / travel", "/ or type"],
] as const;

export default function ShortcutGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="palette-layer" role="presentation">
      <button
        className="palette-scrim"
        type="button"
        onClick={onClose}
        aria-label="Close shortcuts"
      />
      <dialog open className="shortcut-guide" aria-label="Shortcuts">
        <header>
          <div>
            <p className="eyebrow">Move at thought speed</p>
            <h2>Keyboard shortcuts</h2>
          </div>
          <button
            className="shortcut-close"
            type="button"
            onClick={onClose}
            aria-label="Close shortcuts"
          >
            <X size={17} />
          </button>
        </header>
        <div className="shortcut-grid">
          {shortcuts.map(([label, keys]) => (
            <div key={label}>
              <span>{label}</span>
              <kbd>{keys}</kbd>
            </div>
          ))}
        </div>
      </dialog>
    </div>
  );
}
