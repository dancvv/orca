import { randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type {
  JournalConnectorReplyAdmit,
  JournalConnectorReplyFill,
  JournalConnectorReplyRow
} from '../../shared/agent-session/journal/journal-connector-reply'
import type { ConnectorReplyJournal } from '../connector-cloud/connector-reply-outbox'

// Answers too old to post (item 964). An answer recovery finds long after its turn ended, or one to
// a request a restart left open for a day, reaches a thread that has moved on; its request closes
// `quiet` instead (the cloud closes it and posts nothing), with why kept in the row's local
// expired_reason.

/** An answer recovery finds posts only if the turn that wrote it ended at most this long ago. */
export const REPLY_FRESH_MS = 60 * 60_000

/** A request admitted before this process started (a restart left it open) and longer ago than
 *  this closes quietly when filled, however fresh its answer. */
export const REPLY_REQUEST_MAX_AGE_MS = 24 * 60 * 60_000

/** When this process started: a request admitted before it crossed a restart. */
export const PROCESS_STARTED_AT = performance.timeOrigin

export type ReplyStaleness =
  | { kind: 'stale_answer'; endedAt: number }
  | { kind: 'old_request'; admittedAt: number }

/**
 * Why a fill is too old to post, or null. The request's clock runs only for a request a restart
 * left open: a live turn's, even a retry's, is never old. A row with no admission date (an older
 * build's) never ages by it, on any path, nor does a row a usage-limit pause ever owed (its thread
 * was told the work resumes). `endedAt`: when the answer a fill recovers was written; its clock runs
 * for every row.
 */
export function replyStaleness(input: {
  row: JournalConnectorReplyRow
  endedAt: number | undefined
  processStartedAt: number
  now: number
}): ReplyStaleness | null {
  const { row, endedAt, processStartedAt, now } = input
  const { admittedAt } = row
  const paused = row.paused === true || row.cut?.kind === 'usage_limit'
  if (
    !paused &&
    admittedAt !== undefined &&
    admittedAt < processStartedAt &&
    now - admittedAt > REPLY_REQUEST_MAX_AGE_MS
  ) {
    return { kind: 'old_request', admittedAt }
  }
  if (endedAt !== undefined && now - endedAt > REPLY_FRESH_MS) {
    return { kind: 'stale_answer', endedAt }
  }
  return null
}

let settledQuietly = 0

/** Requests this process closed quietly as too old to post: rows its writes actually changed. */
export function staleRepliesSettled(): number {
  return settledQuietly
}

/** One batch of fills: each too old to post becomes a quiet close, which `write` counts and logs
 *  only once its own write changed its row, not when it is proposed. */
export function staleCloser(processStartedAt: number) {
  const now = Date.now()
  // Names this batch's writes: a close another batch or writer made is never counted here.
  const attempt = randomBytes(4).toString('hex')
  const proposed: { fill: JournalConnectorReplyFill; kind: ReplyStaleness['kind'] }[] = []
  return {
    isStale: (row: JournalConnectorReplyRow, endedAt?: number): boolean =>
      replyStaleness({ row, endedAt, processStartedAt, now }) !== null,
    /** The fill, or its quiet close when too old to post: its key, expected state, answer key and
     *  turn kept, its words dropped. */
    close(
      row: JournalConnectorReplyRow,
      fill: JournalConnectorReplyFill,
      endedAt?: number
    ): JournalConnectorReplyFill {
      const staleness = replyStaleness({ row, endedAt, processStartedAt, now })
      if (!staleness) {
        return fill
      }
      const quiet: JournalConnectorReplyFill = {
        account: fill.account,
        deliveryId: fill.deliveryId,
        ...(fill.expect ? { expect: fill.expect } : {}),
        outcome: 'quiet',
        answerDeliveryId: fill.answerDeliveryId,
        ...(fill.turnItemId === undefined ? {} : { turnItemId: fill.turnItemId }),
        ...(fill.turnStartedAt === undefined ? {} : { turnStartedAt: fill.turnStartedAt }),
        expiredReason: `${staleReason(staleness, fill.outcome, now)} (${attempt})`
      }
      proposed.push({ fill: quiet, kind: staleness.kind })
      return quiet
    },
    /** Writes the batch: the rest in one call, each quiet close in a call of its own, so its own
     *  commit result says whether it closed. A close is counted and logged only when its write
     *  changed its row; one whose call threw is looked up once by key, and one still unconfirmed is
     *  logged as such, never counted. A call's failure is rethrown once the batch is done. */
    async write(
      journal: ConnectorReplyJournal,
      sessionId: string,
      fills: readonly JournalConnectorReplyFill[],
      admit?: JournalConnectorReplyAdmit
    ): Promise<boolean> {
      const quiet = new Map(proposed.map((entry) => [entry.fill, entry.kind]))
      const rest = fills.filter((fill) => !quiet.has(fill))
      const failures: unknown[] = []
      let changed =
        rest.length > 0 &&
        (await journal
          .fillOutcomes(rest, admit)
          .catch((error: unknown) => (failures.push(error), false)))
      for (const fill of fills) {
        const kind = quiet.get(fill)
        if (!kind) {
          continue
        }
        const applied = await journal
          .fillOutcomes([fill], admit)
          .catch((error: unknown) => (failures.push(error), landed(journal, sessionId, fill)))
        changed ||= applied === true
        if (applied !== false) {
          if (applied) {
            settledQuietly += 1
          }
          console.warn(
            applied
              ? '[connector] closed a Slack request without posting its answer'
              : '[connector] may have closed a Slack request without posting its answer',
            { sessionId, reason: kind, settled: settledQuietly }
          )
        }
      }
      if (failures.length > 0) {
        throw failures[0]
      }
      return changed
    }
  }
}

/** Whether a close whose call threw committed: its row holds this attempt's reason (true), holds
 *  another state (false), or is gone or unreadable (undefined). */
async function landed(
  journal: ConnectorReplyJournal,
  sessionId: string,
  fill: JournalConnectorReplyFill
): Promise<boolean | undefined> {
  const rows = await journal.read(sessionId).catch(() => undefined)
  const row = rows?.find(
    (candidate) => candidate.account === fill.account && candidate.deliveryId === fill.deliveryId
  )
  return row ? row.fill?.expiredReason === fill.expiredReason : undefined
}

export type StaleCloser = ReturnType<typeof staleCloser>

function staleReason(staleness: ReplyStaleness, outcome: string, now: number): string {
  const at = (ms: number) => new Date(ms).toISOString()
  return staleness.kind === 'stale_answer'
    ? `stale_answer: ${outcome} ended at ${at(staleness.endedAt)}, filled at ${at(now)}`
    : `old_request: ${outcome} for a request admitted at ${at(staleness.admittedAt)}, filled at ${at(now)}`
}
