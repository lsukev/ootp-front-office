import { useEffect, useRef } from 'react';
import { statsFor, type StatDef, type StatGroup } from './stats';

const SECTIONS: Array<StatDef['section']> = ['Counting', 'Rate', 'Advanced'];

export function ColumnPicker({
  group, selected, onChange, onClose, onReset,
}: {
  group: StatGroup;
  selected: string[];
  onChange: (keys: string[]) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const toggle = (key: string) => {
    // Preserve the catalog's order so columns don't jump around as you toggle
    const next = selected.includes(key)
      ? selected.filter((k) => k !== key)
      : statsFor(group).map((s) => s.key).filter((k) => k === key || selected.includes(k));
    onChange(next);
  };

  return (
    <div className="col-picker" ref={ref}>
      <div className="col-picker-head">
        <strong>{group === 'batting' ? 'Batting' : 'Pitching'} columns</strong>
        <button className="chip-x" onClick={onClose}>✕</button>
      </div>
      <div className="col-picker-body">
        {SECTIONS.map((section) => (
          <div key={section} className="col-section">
            <span className="col-section-label">{section}</span>
            {statsFor(group)
              .filter((s) => s.section === section)
              .map((s) => (
                <label key={s.key} className="col-option" title={s.desc}>
                  <input
                    type="checkbox"
                    checked={selected.includes(s.key)}
                    onChange={() => toggle(s.key)}
                  />
                  <span className="col-option-label">{s.label}</span>
                  <span className="col-option-desc">{s.desc}</span>
                </label>
              ))}
          </div>
        ))}
      </div>
      <div className="col-picker-foot">
        <span className="muted">{selected.length} shown</span>
        <button onClick={onReset}>Reset to defaults</button>
      </div>
    </div>
  );
}
