/**
 * Long AI generations, run in the background.
 *
 * Storylines and the briefing take the better part of a minute, and both used
 * to hold the request open for the whole of it — so the page that started one
 * had to sit there, and navigating away lost the wait rather than the work.
 * A job is started, the request returns immediately, and the page asks how it
 * is getting on whenever it likes.
 *
 * Deliberately in memory rather than on disk. A job only lives as long as the
 * process that is running it, and a server restart genuinely does abandon it —
 * recording "running" somewhere durable would only produce jobs that are
 * remembered as running forever. What survives a restart is the finished
 * article, which both features already write to the data directory.
 */

export type JobState = 'idle' | 'running' | 'done' | 'error';

export interface JobStatus {
  state: JobState;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

interface Job extends JobStatus {
  promise: Promise<unknown> | null;
}

const jobs = new Map<string, Job>();

const idle = (): Job => ({
  state: 'idle', startedAt: null, finishedAt: null, error: null, promise: null,
});

const keyOf = (kind: string, orgId: number): string => `${kind}:${orgId}`;

export function jobStatus(kind: string, orgId: number): JobStatus {
  const job = jobs.get(keyOf(kind, orgId)) ?? idle();
  const { promise: _promise, ...status } = job;
  return status;
}

/**
 * Starts a job unless one of the same kind is already running for this club.
 *
 * Returning the existing job rather than queueing a second is deliberate: two
 * generations racing to write the same cache file would leave whichever
 * finished last, having paid for both.
 */
export function startJob(
  kind: string,
  orgId: number,
  work: () => Promise<unknown>
): { started: boolean; status: JobStatus } {
  const key = keyOf(kind, orgId);
  const existing = jobs.get(key);
  if (existing?.state === 'running') {
    return { started: false, status: jobStatus(kind, orgId) };
  }

  const job: Job = {
    state: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    error: null,
    promise: null,
  };
  jobs.set(key, job);

  /*
   * Deferred to the next tick so the response is already on its way.
   *
   * Both of these assemble their context with a long run of synchronous
   * database work before they ever reach an await, and calling work() here
   * would run all of it inside the request — which is how "starts in the
   * background" still took two seconds to come back.
   */
  job.promise = Promise.resolve()
    .then(work)
    .then(() => {
      job.state = 'done';
      job.finishedAt = new Date().toISOString();
    })
    .catch((err: Error) => {
      job.state = 'error';
      job.finishedAt = new Date().toISOString();
      job.error = err.message;
      // The page may not be watching when this lands, so it goes to the log too
      console.error(`[job:${kind}]`, err);
    });

  return { started: true, status: jobStatus(kind, orgId) };
}

/** Waits for a running job, for callers that genuinely need the result. */
export async function awaitJob(kind: string, orgId: number): Promise<void> {
  await jobs.get(keyOf(kind, orgId))?.promise;
}
