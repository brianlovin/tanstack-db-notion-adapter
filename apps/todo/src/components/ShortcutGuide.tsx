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

export default function ShortcutGuide({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="palette-layer" role="presentation">
      <button className="palette-scrim" onClick={onClose} aria-label="Close shortcuts" />
      <section className="shortcut-guide" role="dialog" aria-modal="true" aria-label="Shortcuts">
        <header>
          <div>
            <p className="eyebrow">Move at thought speed</p>
            <h2>Keyboard shortcuts</h2>
          </div>
          <button className="shortcut-close" onClick={onClose} aria-label="Close shortcuts">
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
      </section>
    </div>
  );
}
