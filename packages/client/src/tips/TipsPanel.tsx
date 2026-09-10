import { useEffect } from 'react';
import { TIPS } from './tips';
import { formatChord, loadBindings } from '../keybindings/keybindings';

export interface TipsPanelProps {
  onClose: () => void;
}

export function TipsPanel({ onClose }: TipsPanelProps) {
  const categories = [...new Set(TIPS.map((t) => t.category))];
  const bindings = loadBindings();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="panel-overlay" onPointerDown={onClose}>
      <div
        className="panel"
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Shortcuts & tips"
      >
        <h2>Shortcuts &amp; Tips</h2>
        {categories.map((cat) => (
          <div key={cat} style={{ marginBottom: 16 }}>
            <h3 style={{ margin: '8px 0', fontSize: 14, color: 'var(--t-accent)' }}>{cat}</h3>
            {TIPS.filter((t) => t.category === cat).map((t) => (
              <div
                key={t.title}
                style={{ padding: '6px 0', borderBottom: '1px solid var(--t-surface)' }}
              >
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 14,
                    display: 'flex',
                    gap: 8,
                    alignItems: 'baseline',
                  }}
                >
                  <span>{t.title}</span>
                  {t.action && (
                    <span
                      style={{
                        fontFamily: 'var(--font-mono, monospace)',
                        fontSize: 12,
                        color: 'var(--t-accent)',
                      }}
                    >
                      {formatChord(bindings[t.action])}
                    </span>
                  )}
                </div>
                <div style={{ color: 'var(--t-subtext)', fontSize: 13 }}>{t.description}</div>
              </div>
            ))}
          </div>
        ))}
        <div style={{ marginTop: 8, textAlign: 'right' }}>
          <button
            className="icon-btn"
            onClick={onClose}
            style={{ width: 'auto', padding: '0 16px' }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
