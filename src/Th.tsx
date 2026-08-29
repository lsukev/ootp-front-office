import type { ReactNode } from 'react';
import { Tip } from './playerModal';
import { define } from './glossary';

/**
 * A table header that explains itself. If the label has a glossary entry it is
 * rendered with a hover definition; otherwise it falls back to a plain header,
 * so adding a term to the glossary is the only step needed to document a column.
 */
export function Th({
  children, tip, className, colSpan,
}: {
  children: ReactNode;
  /** Overrides the glossary, for a column whose meaning is page-specific. */
  tip?: string;
  className?: string;
  colSpan?: number;
}) {
  const label = typeof children === 'string' ? children : null;
  const definition = tip ?? (label ? define(label) : undefined);

  if (!definition) {
    return (
      <th className={className} colSpan={colSpan}>
        {children}
      </th>
    );
  }
  return (
    <th className={className} colSpan={colSpan}>
      <Tip label={children} tip={definition} />
    </th>
  );
}


/**
 * A header you can sort by, documented the same way as {@link Th}.
 *
 * Lives here rather than in the page because Player Search grew its own and
 * the draft board grew a third; a fourth private copy is how the position
 * names and the date key came to be scattered across ten files each.
 */
export function SortableTh({
  children, tip, className, active, dir, onSort,
}: {
  children: ReactNode;
  tip?: string;
  className?: string;
  /** Whether the table is currently sorted by this column. */
  active: boolean;
  dir: 1 | -1;
  onSort: () => void;
}) {
  const label = typeof children === 'string' ? children : null;
  const definition = tip ?? (label ? define(label) : undefined);
  return (
    <th className={[className, 'sortable', active ? 'sorted' : ''].filter(Boolean).join(' ')}>
      <button type="button" onClick={onSort}>
        {definition ? <Tip label={children} tip={definition} /> : children}
        {active && <span className="sort-arrow">{dir === 1 ? '▲' : '▼'}</span>}
      </button>
    </th>
  );
}
