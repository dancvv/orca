import { expect, it } from 'vitest'
import type { JournalConnectorReplyFill } from '../../../../shared/agent-session/journal/journal-connector-reply'
import { JournalSqlConnectorReplies } from './journal-sql-connector-replies'

// RR-C1-08: a reply write queued on the journal's lane asks its admit when the writer takes it, not
// when it was queued: one a dispose made stale while it waited is dropped unwritten.

function laneHeld() {
  const queued: (() => Promise<void>)[] = []
  const written: string[] = []
  const writer = {
    maintain: async (operation: { kind: string }) => {
      written.push(operation.kind)
      return true
    }
  }
  const db = {
    readOnly: false,
    readers: {},
    serialize: <T>(_lane: string, task: (target: typeof writer) => Promise<T> | T) =>
      new Promise<T>((resolve) => queued.push(async () => resolve(await task(writer))))
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the wrapper calls only serialize and readOnly here.
  const replies = new JournalSqlConnectorReplies(db as never)
  return {
    replies,
    written,
    dispatch: async () => Promise.all(queued.splice(0).map((run) => run()))
  }
}

const fill: JournalConnectorReplyFill = {
  account: 'account-a',
  deliveryId: 'd1',
  outcome: 'quiet',
  answerDeliveryId: 'd1'
}

it('drops a fill, cut or recut whose admit turned false while it waited on the lane', async () => {
  const { replies, written, dispatch } = laneHeld()
  let current = true
  const admit = () => current
  const cut = { turnId: 't1', kind: 'restart' as const }
  const results = Promise.all([
    replies.fillOutcomes([fill], admit),
    replies.cut({ keys: [{ account: 'account-a', deliveryId: 'd1' }], cut }, admit),
    replies.recut('c1', cut, undefined, admit)
  ])
  current = false
  await dispatch()
  expect([await results, written]).toEqual([[false, false, false], []])
})

it('writes a queued fill whose admit still holds when the writer takes it', async () => {
  const { replies, written, dispatch } = laneHeld()
  const result = replies.fillOutcomes([fill], () => true)
  await dispatch()
  expect([await result, written]).toEqual([true, ['connector-replies-fill']])
})
