import { useEffect, useState } from 'react';

/**
 * Team logo served from the user's own OOTP save. Renders nothing if the save
 * has no logo for that team, so custom leagues without art degrade cleanly.
 */
export function TeamLogo({
  teamId, size, className, alt,
}: { teamId: number; size?: 40 | 50 | 110; className?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [teamId]);
  if (failed) return null;

  const src = `/api/logo/${teamId}${size ? `?size=${size}` : ''}`;
  return (
    <img
      className={className ?? 'team-logo'}
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
