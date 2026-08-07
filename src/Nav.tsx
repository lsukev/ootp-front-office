import { useEffect, useRef, useState } from 'react';

export interface NavItem<P extends string> {
  page: P;
  label: string;
  hint: string;
}
export interface NavGroup<P extends string> {
  label: string;
  icon: string;
  items: Array<NavItem<P>>;
}
/** A top-level entry is either a direct link or a dropdown of related pages. */
export type NavEntry<P extends string> = ({ kind: 'link' } & NavItem<P>) | ({ kind: 'group' } & NavGroup<P>);

export function Nav<P extends string>({
  entries, current, onNavigate,
}: {
  entries: Array<NavEntry<P>>;
  current: P;
  onNavigate: (page: P) => void;
}) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);

  // Close on outside click or Escape
  useEffect(() => {
    if (openMenu === null) return;
    const onClick = (e: MouseEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  const go = (page: P) => {
    onNavigate(page);
    setOpenMenu(null);
  };

  const activeLabel = entries
    .flatMap((e) => (e.kind === 'group' ? e.items : [e]))
    .find((i) => i.page === current)?.label;

  return (
    <>
      <nav className="nav" ref={navRef}>
        {entries.map((entry) => {
          if (entry.kind === 'link') {
            return (
              <button
                key={entry.page}
                className={`nav-top ${current === entry.page ? 'active' : ''}`}
                onClick={() => go(entry.page)}
              >
                <span className="nav-icon">{entry.hint}</span>
                {entry.label}
              </button>
            );
          }
          const holdsCurrent = entry.items.some((i) => i.page === current);
          const isOpen = openMenu === entry.label;
          return (
            <div key={entry.label} className="nav-group">
              <button
                className={`nav-top ${holdsCurrent ? 'active' : ''} ${isOpen ? 'open' : ''}`}
                onClick={() => setOpenMenu(isOpen ? null : entry.label)}
                aria-expanded={isOpen}
              >
                <span className="nav-icon">{entry.icon}</span>
                {entry.label}
                <span className="nav-caret">▾</span>
              </button>
              {isOpen && (
                <div className="nav-dropdown">
                  {entry.items.map((item) => (
                    <button
                      key={item.page}
                      className={current === item.page ? 'active' : ''}
                      onClick={() => go(item.page)}
                    >
                      <span className="nav-item-label">{item.label}</span>
                      <span className="nav-item-hint">{item.hint}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>
      {activeLabel && <div className="page-title">{activeLabel}</div>}
    </>
  );
}
