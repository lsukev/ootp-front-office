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
