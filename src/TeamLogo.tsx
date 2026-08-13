import { useEffect, useState } from 'react';

/*
 * Which save the logos belong to.
 *
 * Team ids repeat across saves, so /api/logo/18 names a different picture in
 * each one — and with a day's cache on it the browser kept serving the first,
 * putting one league's badges against another's clubs. The token goes in the
 * URL so each save gets its own cache entry. Held in a module rather than
 * passed down because logos are drawn from a dozen places, several of them
 * outside the page tree.
 */
let saveToken = '';

export function setLogoToken(token: string | undefined): void {
  saveToken = token ?? '';
}

/**
 * Team logo served from the user's own OOTP save. Renders nothing if the save
 * has no logo for that team, so custom leagues without art degrade cleanly.
 */
export function TeamLogo({
  teamId, size, className, alt,
}: { teamId: number; size?: 40 | 50 | 110; className?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);

  // A new save may not have art for this club even if the last one did
  useEffect(() => setFailed(false), [teamId, saveToken]);
  if (failed) return null;

  const params = new URLSearchParams();
  if (size) params.set('size', String(size));
  if (saveToken) params.set('v', saveToken);
  const query = params.toString();
  const src = `/api/logo/${teamId}${query ? `?${query}` : ''}`;
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
