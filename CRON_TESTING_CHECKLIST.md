# Cron Testing Checklist

Manual scenarios to verify cron fixes work in practice with real jobs.

## Error Backoff

- [ ] **Bad model backoff**: Create a cron job with `payload.kind: "agentTurn"` targeting a non-existent or invalid model. Verify consecutive errors increment and nextRunAtMs increases according to the backoff schedule (30s → 1m → 5m → 15m → 60m).
- [ ] **Backoff recovery**: After a job enters backoff, fix the underlying issue (e.g. switch to a valid model). Verify the next successful run resets `consecutiveErrors` to 0 and nextRunAtMs returns to the normal schedule.
- [ ] **Backoff ceiling**: Trigger 5+ consecutive errors. Verify the backoff caps at 60 minutes and doesn't grow beyond that.
- [ ] **Backoff vs natural schedule**: For a job with `every: 120_000` (2 min), trigger 1 error. Verify nextRunAtMs is `max(normalNext, endedAt + 30_000)` — the natural interval wins since 2 min > 30 s backoff.

## One-Shot Auto-Disable

- [ ] **One-shot success**: Create an `at`-schedule job. After it runs successfully, verify `enabled` is false and `nextRunAtMs` is undefined.
- [ ] **One-shot with deleteAfterRun**: Create an `at`-schedule job with `deleteAfterRun: true`. After success, verify the job is completely removed from the store.
- [ ] **One-shot error**: Create an `at`-schedule job that will fail (e.g. bad agentTurn config). Verify the job is disabled after the error (not retried in a loop).
- [ ] **One-shot skip**: Create an `at`-schedule main job with empty systemEvent text. Verify the job is disabled after being skipped.

## Cron Expression Boundary Timing

- [ ] **Minute boundary**: Create a `* * * * *` cron job at T-1s before a minute boundary. Verify it fires at the next minute boundary and nextRunAtMs advances to the following minute.
- [ ] **Late timer fire**: Verify that when the setTimeout fires a few ms late (normal OS jitter), the job still fires correctly and nextRunAtMs advances to the correct next boundary (not a past time).
- [ ] **Hour boundary**: Create a `0 * * * *` cron job near an hour boundary. Verify correct firing and correct next-hour scheduling.
- [ ] **Timezone handling**: Create a cron job with a specific `tz` value. Verify it fires at the correct local time, especially around DST transitions.

## Every-Interval Jobs

- [ ] **Basic interval**: Create an `every: 10_000` job. Verify it fires every ~10 seconds and nextRunAtMs always advances by 10s from the anchor.
- [ ] **Anchor preservation**: After restart, verify `every`-type jobs maintain their original anchor and don't drift.
- [ ] **Schedule change**: Update an `every` job's interval. Verify the new interval takes effect immediately and the anchor is preserved or correctly recomputed.

## Delivery Target / threadId Behavior

- [ ] **Main session delivery**: Create a `sessionTarget: "main"` job. Verify the systemEvent is enqueued and heartbeat is requested.
- [ ] **Isolated agentTurn delivery**: Create a `sessionTarget: "isolated"` job with `payload.kind: "agentTurn"`. Verify it runs in an isolated session and the summary is announced back.
- [ ] **Delivery plan with threadId**: If the job has a `deliveryTarget.threadId`, verify the response is delivered to the correct thread.
- [ ] **bestEffortDeliver**: Verify that jobs with `bestEffortDeliver: true` still attempt delivery even if the channel isn't fully configured.
- [ ] **Wake mode "now" vs "next-heartbeat"**: Verify `wakeMode: "now"` triggers an immediate heartbeat, while `"next-heartbeat"` only enqueues.

## Heartbeat Cron Events

- [ ] **Event emission**: Verify that `started`, `finished`, and `removed` events are emitted correctly during job lifecycle.
- [ ] **Event data**: Verify events include correct `jobId`, `status`, `durationMs`, `nextRunAtMs`, and `sessionId`/`sessionKey` for isolated jobs.
- [ ] **Heartbeat trigger from cron**: Verify that a main-session cron job with `wakeMode: "now"` triggers `runHeartbeatOnce` and waits for completion.
- [ ] **Heartbeat retry on requests-in-flight**: Verify the retry loop when heartbeat returns `skipped` due to `requests-in-flight`.

## Timer Leak (Regression)

- [ ] **No leaked timers**: After a job completes, verify no stale setTimeout handles remain in the event loop. The Promise.race timeout should be cleaned up via `.finally()`.
- [ ] **Timeout actually fires**: Create a job that hangs (e.g. never-resolving promise in test). Verify the 10-minute (or custom) timeout fires and the job is marked as errored.

## Store Persistence

- [ ] **list() persists stale state**: Call `list()` when nextRuns need recomputation (e.g. after a clock jump). Verify the recomputed state is persisted to disk.
- [ ] **status() persists stale state**: Same as above but for `status()`.
- [ ] **Restart recovery**: Kill the process and restart. Verify all job states are correctly restored from disk and missed jobs are detected and run.
- [ ] **Concurrent access**: Verify the file-lock mechanism prevents corruption when multiple operations happen simultaneously.

## Stuck Job Recovery

- [ ] **Stuck running marker**: Manually set `runningAtMs` to a time > 10 minutes ago. Verify `recomputeNextRuns` clears it on the next tick.
- [ ] **Process crash during execution**: Kill the process while a job is running. On restart, verify the stale `runningAtMs` is cleared and the job is eligible to run again.

## Edge Cases

- [ ] **Disabled job re-enable**: Disable a recurring job, wait past its schedule, re-enable it. Verify it computes the correct next run time (not in the past).
- [ ] **Rapid add/remove**: Add and immediately remove a job. Verify no orphaned timers or state.
- [ ] **Empty job list**: Verify the system is stable with zero jobs (no null pointer errors, timer not armed).
- [ ] **Store migration**: Start with a v0 store format. Verify it migrates to v1 correctly on load.
