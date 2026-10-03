// Issue #160: when a reply's ```dsh-ui fence does not render, the model should
// get ONE actionable chance to fix it inside the same turn. These tests pin the
// bounds that keep the loop from becoming a retry storm: exact fence matching,
// one correction per turn, one per fence body, never for subagents, never for
// an aborted turn, and accounting before the steer.
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  createFeedbackMessage,
  extractDshUiFences,
  fenceCorrectionText,
  fenceFailures,
  fenceFingerprint,
  installFenceFeedback,
  planFenceFeedback,
  FEEDBACK_PLUGIN_NAME,
  FEEDBACK_SOURCE_KIND,
} from '../src/plugin/fence-feedback.ts'

/** A fence body that renders: one stat carrying a metric list (#172 case A). */
const STAT_GROUP = JSON.stringify({ items: [{
  type: 'stat',
  items: [{ label: '质量门进度', value: '1/5' }, { label: '阻塞项', value: '0' }],
}] })

/** A fence body that renders: bare data-component root (#172 case B). */
const BARE_STEPS = JSON.stringify({ type: 'steps', items: [{ title: '第一层' }] })

/** A fence body that cannot render: required field missing. */
const BROKEN = JSON.stringify({ items: [{ type: 'stat' }] })
const REPAIRABLE = '{"title":"x","items":[{"type":"text","content":"好",},]}'
const REPAIRED_SCHEMA_FAILURE = '{"items":[{"type":"stat","value":"好",},]}'
const ISSUE_200 = '{"type":"keyvalue","items":[{"label":"a","value":"b"}]}'
const CUT = '{"items":[{"type":"text","content":"补全"}'
const TIER2_ONLY = '{"title":"x","items":[{"type":"text","content":"半截'

function reply(...bodies: string[]): string {
  return bodies.map(body => `说明文字\n\`\`\`dsh-ui\n${body}\n\`\`\`\n`).join('\n')
}

interface Harness {
  ctx: Context
  emitSession: (event: unknown) => void
  disposeSession: () => void
  boundary: (payload: unknown) => void
  steer: ReturnType<typeof vi.fn>
  listeners: Map<string, (payload: unknown, ...rest: unknown[]) => unknown>
}

function harness(options: { parentSession?: string; enabled?: boolean } = {}): Harness {
  const listeners = new Map<string, (payload: unknown, ...rest: unknown[]) => unknown>()
  const ctx = {
    logger: { warn: vi.fn() },
    on: (name: string, handler: (payload: unknown, ...rest: unknown[]) => unknown) => {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    },
  } as unknown as Context
  installFenceFeedback(ctx, options.enabled ?? true)
  const session = {
    id: 'sess-1',
    header: options.parentSession === undefined ? { id: 'sess-1' } : { id: 'sess-1', parentSession: options.parentSession },
  }
  const steer = vi.fn()
  const agent = { session, steer }
  return {
    ctx,
    steer,
    listeners,
    emitSession: (event: unknown) => {
      listeners.get('session/event')?.(session, event)
    },
    disposeSession: () => {
      listeners.get('session/disposed')?.(session)
    },
    boundary: (payload: unknown) => {
      listeners.get('agent/turn-stopping')?.(payload)
    },
  }
}

const assistantEvent = (text: string): unknown => ({ type: 'assistant/message', seq: 3, time: 1, data: { message: { content: [{ type: 'text', text }] } } }) as unknown as SessionEvent
const userEvent = (): unknown => ({ type: 'user/message', seq: 2, time: 1, data: { content: [{ type: 'text', text: '问题' }], source: { kind: 'user' } } }) as unknown as SessionEvent

describe('exact fence matching', () => {
  it('extracts only a fence whose info string is exactly dsh-ui', () => {
    const text = [
      '```dsh-ui',
      BROKEN,
      '```',
      '```dsh-ui-dark',
      '{"items":[]}',
      '```',
      '```json',
      '{"items":[]}',
      '```',
      '正文里提到 dsh-ui 但不在围栏里',
    ].join('\n')
    const fences = extractDshUiFences(text)
    expect(fences).toHaveLength(1)
    expect(fences[0]!.raw).toBe(BROKEN)
    expect(fences[0]!.closed).toBe(true)
  })

  it('accepts trailing spaces and up to three spaces of indentation', () => {
    expect(extractDshUiFences('   ```dsh-ui   \n{}\n```')).toHaveLength(1)
    expect(extractDshUiFences('    ```dsh-ui\n{}\n```')).toHaveLength(0)
  })

  it('marks an unterminated fence instead of swallowing it silently', () => {
    const fences = extractDshUiFences('```dsh-ui\n{"items":[{"type":"text","content":"半截')
    expect(fences).toHaveLength(1)
    expect(fences[0]!.closed).toBe(false)
  })

  it('keeps multiple fences in document order with 1-based indices', () => {
    const fences = extractDshUiFences(reply(BROKEN, STAT_GROUP))
    expect(fences.map(fence => fence.index)).toEqual([1, 2])
  })

  it('fingerprints the body, not the surrounding whitespace', () => {
    expect(fenceFingerprint(` ${BROKEN} `)).toBe(fenceFingerprint(BROKEN))
    expect(fenceFingerprint(BROKEN)).not.toBe(fenceFingerprint(STAT_GROUP))
  })
})

describe('fenceFailures: only fences that would stay a code block', () => {
  it('passes the #172 bodies the guard now renders', () => {
    expect(fenceFailures(reply(STAT_GROUP))).toEqual([])
    expect(fenceFailures(reply(BARE_STEPS))).toEqual([])
  })

  it('reports the actionable field diagnosis of a dropped node', () => {
    const failures = fenceFailures(reply(BROKEN))
    expect(failures).toHaveLength(1)
    expect(failures[0]!.detail).toContain("type 'stat' requires label")
    expect(failures[0]!.detail).not.toContain('[genui-validation]')
    expect(failures[0]!.detail).not.toContain('next=fix_and_revalidate')
    expect(failures[0]!.detail).not.toContain('reply_language=conversation')
    expect(failures[0]!.fingerprint).toBe(fenceFingerprint(BROKEN))
  })

  it('reports unparseable and unterminated bodies distinctly', () => {
    expect(fenceFailures('```dsh-ui\n{ not json\n```')[0]!.detail).toContain('error=invalid_json')
    expect(fenceFailures('```dsh-ui\n{"items":[]}')[0]!.detail).toContain('error=unterminated_fence')
  })

  it('accepts bodies repaired by the settled renderer pipeline', () => {
    expect(fenceFailures(reply(REPAIRABLE))).toEqual([])
  })

  it('reports schema errors after tier-1 JSON repair', () => {
    const failures = fenceFailures(reply(REPAIRED_SCHEMA_FAILURE))
    expect(failures).toHaveLength(1)
    expect(failures[0]!.detail).toContain("type 'stat' requires label")
    expect(failures[0]!.detail).not.toContain('不是合法 JSON')
  })

  it('accepts a settled body repaired by tier-2 completion', () => {
    expect(fenceFailures(reply(CUT))).toEqual([])
    expect(fenceFailures(reply(TIER2_ONLY))).toEqual([])
  })

  it('accepts the issue #200 keyvalue alias shape', () => {
    expect(fenceFailures(reply(ISSUE_200))).toEqual([])
  })

  it('ignores JSON fences and prose', () => {
    expect(fenceFailures('```json\n{"items":[{"type":"stat"}]}\n```\n正文 dsh-ui')).toEqual([])
  })
})

describe('planFenceFeedback: the bounds that prevent a retry storm', () => {
  const base = { text: reply(BROKEN), turn: 1, lastCorrectedTurn: undefined, corrected: new Set<string>(), aborted: false }

  it('plans one correction for a rejected fence', () => {
    const plan = planFenceFeedback(base)
    expect(plan).not.toBeNull()
    expect(plan!.turn).toBe(1)
    expect(plan!.fingerprints).toEqual([fenceFingerprint(BROKEN)])
    expect(plan!.text).toContain('next=resend_corrected_fence_only')
  })

  it('checks the final reply body even when an earlier validated body was valid', () => {
    expect(fenceFailures(reply(STAT_GROUP))).toEqual([])
    const finalReply = planFenceFeedback({ ...base, text: reply(BROKEN) })
    expect(finalReply).not.toBeNull()
    expect(finalReply!.text).toContain("type 'stat' requires label")
  })

  it('allows a SECOND correction in the same turn, never a third', () => {
    // Evidence (session-ccc8f3e2, 2026-09-29): the render-failure correction was
    // answered with another reasoning-only turn 4 times out of 4. Under a
    // one-per-turn budget those turns ended with an empty body — the second
    // slot is what lets the reasoning-only correction land.
    expect(planFenceFeedback({ ...base, lastCorrectedTurn: 1 })).not.toBeNull()
    expect(planFenceFeedback({ ...base, lastCorrectedTurn: 0 })).not.toBeNull()
    expect(planFenceFeedback({ ...base, correctionsThisTurn: 2 })).toBeNull()
    expect(planFenceFeedback({ ...base, correctionsThisTurn: 1 })).not.toBeNull()
  })

  it('stays silent for a fence body already corrected', () => {
    expect(planFenceFeedback({ ...base, corrected: new Set([fenceFingerprint(BROKEN)]) })).toBeNull()
  })

  it('corrects only the new fences when a reply repeats an old broken one', () => {
    const plan = planFenceFeedback({ ...base, text: reply(BROKEN, STAT_GROUP), corrected: new Set([fenceFingerprint(BROKEN)]) })
    expect(plan).toBeNull()
    const other = planFenceFeedback({ ...base, text: reply(BROKEN, '{"items":[{"type":"table"}]}'), corrected: new Set([fenceFingerprint(BROKEN)]) })
    expect(other!.fingerprints).toEqual([fenceFingerprint('{"items":[{"type":"table"}]}')])
  })

  it('stays silent when the turn is aborted or the reply renders', () => {
    expect(planFenceFeedback({ ...base, aborted: true })).toBeNull()
    expect(planFenceFeedback({ ...base, text: reply(STAT_GROUP) })).toBeNull()
    expect(planFenceFeedback({ ...base, text: '   ' })).toBeNull()
  })

  it('asks for the fence in the body when the reply only composed it in reasoning', () => {
    // Real session (2026-09-29): the model validated a spec, wrote the whole
    // fence into its reasoning block, and ended the turn with an empty body —
    // nothing mounted and the reader saw only a collapsed "thinking" card.
    const fingerprint = fenceFingerprint(BROKEN)
    const plan = planFenceFeedback({ ...base, text: '', reasoningFence: fingerprint })
    expect(plan).not.toBeNull()
    expect(plan!.fingerprints).toEqual([fingerprint])
    expect(plan!.text).toContain('next=emit_fence_in_body')
    expect(plan!.text).toContain('status=fence_in_reasoning_only')
    // The correction NEVER carries the draft: a fence in the reasoning block is
    // not proof that the model chose to deliver it, and there may be several
    // candidates (maintainer boundary on #236).
    const reminder = planFenceFeedback({ ...base, text: '', reasoningFence: fingerprint })
    expect(reminder!.text).not.toContain('```')
    expect(reminder!.text).not.toContain(BROKEN)
    expect(reminder!.text).toContain('本轮尚未产生正式回答')
    // A turn that already delivered text or a render_ui card is DONE.
    expect(planFenceFeedback({ ...base, text: '', reasoningFence: fingerprint, bodyDelivered: true })).toBeNull()
    // A retry of the same fence identity is still allowed (the ledger must not
    // eat the only retry that can land).
    const again = planFenceFeedback({ ...base, text: '', reasoningFence: fingerprint, corrected: new Set([fingerprint]) })
    expect(again).not.toBeNull()
    const second = planFenceFeedback({ ...base, text: '', reasoningFence: fingerprint, correctionsThisTurn: 1 })
    expect(second!.text).toContain('第 2 次提醒')

    // Bounds: the per-turn budget still applies.
    expect(planFenceFeedback({ ...base, text: '', reasoningFence: fingerprint, aborted: true })).toBeNull()
    expect(planFenceFeedback({ ...base, text: '', reasoningFence: fingerprint, correctionsThisTurn: 2 })).toBeNull()
    // An empty body with no composed fence stays silent.
    expect(planFenceFeedback({ ...base, text: '' })).toBeNull()
  })
})

describe('the steered correction message', () => {
  it('uses the producer-owned source kind for Session format v4', () => {
    const failures = fenceFailures(reply(BROKEN))
    const text = fenceCorrectionText(failures)
    expect(text).toContain(`[genui-fence-repair #${failures[0]!.fingerprint}]`)
    expect(text).toContain('[genui-fence-repair]')
    expect(text).toContain('reply_language=conversation')
    expect(text).toContain("type 'stat' requires label")
    expect(text).not.toContain('[genui-validation]')
    expect(text).not.toContain('next=fix_and_revalidate')
    expect(text).not.toContain('围栏没有渲染成界面')
    expect(text).not.toContain('请只重发修正后的')
    const message = createFeedbackMessage(text, 4)
    expect(message.role).toBe('user')
    expect(typeof message.id).toBe('string')
    expect(message.source).toEqual({
      kind: FEEDBACK_SOURCE_KIND,
      form: 'notice',
      summary: 'genui fence repair requested',
    })
    expect(Object.isFrozen(message)).toBe(true)
    // No triple backticks: the notice renders as markdown in the transcript.
    expect(text).not.toContain('```')
  })

  it('uses the legacy plugin source on older Session formats', () => {
    const message = createFeedbackMessage('repair', 0)

    expect(message.source).toEqual({
      kind: 'plugin',
      plugin: FEEDBACK_PLUGIN_NAME,
      form: 'notice',
      summary: 'genui fence repair requested',
    })
  })

  it('numbers each broken fence when a reply has several', () => {
    const failures = fenceFailures(reply(BROKEN, '{"items":[{"type":"table"}]}'))
    expect(failures).toHaveLength(2)
    const text = fenceCorrectionText(failures)
    expect(text).toContain('fence=1')
    expect(text).toContain('fence=2')
  })
})

describe('installFenceFeedback wiring', () => {
  it('is inert when explicitly disabled', () => {
    const h = harness({ enabled: false })
    expect(h.listeners.size).toBe(0)
  })

  it('steers once per turn when the reply has an unrenderable fence', () => {
    const h = harness()
    h.emitSession(userEvent())
    h.emitSession(assistantEvent(reply(BROKEN)))
    const agent = { session: { id: 'sess-1', header: { id: 'sess-1', version: 4 } }, steer: h.steer }
    h.boundary({ agent, turn: 4, signal: new AbortController().signal })
    expect(h.steer).toHaveBeenCalledTimes(1)
    const message = h.steer.mock.calls[0]![0] as { source: { kind: string } }
    expect(message.source.kind).toBe(FEEDBACK_SOURCE_KIND)
    // A second boundary of the same turn must not steer again.
    h.boundary({ agent, turn: 4, signal: new AbortController().signal })
    expect(h.steer).toHaveBeenCalledTimes(1)
  })

  it('steers when the fence exists only in the reasoning block', () => {
    const h = harness()
    h.emitSession(userEvent())
    h.emitSession({
      type: 'assistant/message',
      seq: 3,
      time: 1,
      data: { message: { content: [{ type: 'reasoning', text: reply(BROKEN) }] } },
    } as unknown as SessionEvent)
    const agent = { session: { id: 'sess-1', header: { id: 'sess-1', version: 4 } }, steer: h.steer }
    h.boundary({ agent, turn: 7, signal: new AbortController().signal })
    expect(h.steer).toHaveBeenCalledTimes(1)
    const message = h.steer.mock.calls[0]![0] as { content: Array<{ text: string }> }
    expect(message.content[0]!.text).toContain('next=emit_fence_in_body')
    // The same reasoning-only stall gets a second chance in the same turn (the
    // model answered a real retry with a byte-identical reasoning block), and
    // then the per-turn budget closes the turn.
    h.boundary({ agent, turn: 7, signal: new AbortController().signal })
    expect(h.steer).toHaveBeenCalledTimes(2)
    const retry = h.steer.mock.calls[1]![0] as { content: Array<{ text: string }> }
    expect(retry.content[0]!.text).toContain('第 2 次提醒')
    h.boundary({ agent, turn: 7, signal: new AbortController().signal })
    expect(h.steer).toHaveBeenCalledTimes(2)
  })

  it('steers a second time in the same turn when the first correction was answered empty', () => {
    // The whole point of the two-slot budget: correction #1 (render failure) is
    // answered with another reasoning-only turn, so #2 asks for the body.
    const h = harness()
    h.emitSession(userEvent())
    h.emitSession(assistantEvent(reply(BROKEN)))
    const agent = { session: { id: 'sess-1', header: { id: 'sess-1', version: 4 } }, steer: h.steer }
    h.boundary({ agent, turn: 9, signal: new AbortController().signal })
    expect(h.steer).toHaveBeenCalledTimes(1)

    // The model answers with a reasoning-only message carrying the FIXED fence
    // (a different body → its own fingerprint, so the ledger allows it).
    h.emitSession({
      type: 'assistant/message',
      seq: 5,
      time: 2,
      data: { message: { content: [{ type: 'reasoning', text: reply(STAT_GROUP) }] } },
    } as unknown as SessionEvent)
    h.boundary({ agent, turn: 9, signal: new AbortController().signal })
    expect(h.steer).toHaveBeenCalledTimes(2)
    const second = h.steer.mock.calls[1]![0] as { content: Array<{ text: string }> }
    expect(second.content[0]!.text).toContain('next=emit_fence_in_body')
    expect(second.content[0]!.text).not.toContain(STAT_GROUP)

    // A third boundary in the same turn stays silent.
    h.boundary({ agent, turn: 9, signal: new AbortController().signal })
    expect(h.steer).toHaveBeenCalledTimes(2)
  })

  it('never steers for a subagent session', () => {
    const h = harness({ parentSession: 'parent-1' })
    h.emitSession(assistantEvent(reply(BROKEN)))
    h.boundary({
      agent: { session: { id: 'sess-1', header: { id: 'sess-1', parentSession: 'parent-1' } }, steer: h.steer },
      turn: 1,
      signal: new AbortController().signal,
    })
    expect(h.steer).not.toHaveBeenCalled()
  })

  it('never steers into an aborted turn', () => {
    const h = harness()
    h.emitSession(assistantEvent(reply(BROKEN)))
    const controller = new AbortController()
    controller.abort()
    h.boundary({ agent: { session: { id: 'sess-1', header: { id: 'sess-1' } }, steer: h.steer }, turn: 1, signal: controller.signal })
    expect(h.steer).not.toHaveBeenCalled()
  })

  it('adopts the fingerprints of its own correction so a reload cannot repeat it', () => {
    const h = harness()
    const failures = fenceFailures(reply(BROKEN))
    h.emitSession({
      type: 'user/message',
      seq: 4,
      time: 1,
      data: {
        content: [{ type: 'text', text: fenceCorrectionText(failures) }],
        source: { kind: FEEDBACK_SOURCE_KIND, form: 'notice', summary: 'x' },
      },
    } as unknown as SessionEvent)
    h.emitSession(assistantEvent(reply(BROKEN)))
    h.boundary({ agent: { session: { id: 'sess-1', header: { id: 'sess-1' } }, steer: h.steer }, turn: 9, signal: new AbortController().signal })
    expect(h.steer).not.toHaveBeenCalled()
  })

  it('adopts fingerprints from legacy repair markers', () => {
    const h = harness()
    const fingerprint = fenceFingerprint(BROKEN)
    h.emitSession({
      type: 'user/message',
      seq: 4,
      time: 1,
      data: {
        content: [{ type: 'text', text: `[genui 自修 #${fingerprint}]\nlegacy repair notice` }],
        source: { kind: FEEDBACK_SOURCE_KIND, form: 'notice', summary: 'legacy' },
      },
    } as unknown as SessionEvent)
    h.emitSession(assistantEvent(reply(BROKEN)))
    h.boundary({ agent: { session: { id: 'sess-1', header: { id: 'sess-1' } }, steer: h.steer }, turn: 9, signal: new AbortController().signal })
    expect(h.steer).not.toHaveBeenCalled()
  })

  it('recognizes original legacy plugin source wrappers', () => {
    const h = harness()
    const failures = fenceFailures(reply(BROKEN))
    h.emitSession({
      type: 'user/message',
      seq: 4,
      time: 1,
      data: {
        content: [{ type: 'text', text: fenceCorrectionText(failures) }],
        source: { kind: 'plugin', plugin: FEEDBACK_PLUGIN_NAME, form: 'notice', summary: 'legacy' },
      },
    } as unknown as SessionEvent)
    h.emitSession(assistantEvent(reply(BROKEN)))
    h.boundary({ agent: { session: { id: 'sess-1', header: { id: 'sess-1' } }, steer: h.steer }, turn: 9, signal: new AbortController().signal })
    expect(h.steer).not.toHaveBeenCalled()
  })

  it('stays silent when the reply renders', () => {
    const h = harness()
    h.emitSession(assistantEvent(reply(STAT_GROUP, BARE_STEPS)))
    h.boundary({ agent: { session: { id: 'sess-1', header: { id: 'sess-1' } }, steer: h.steer }, turn: 1, signal: new AbortController().signal })
    expect(h.steer).not.toHaveBeenCalled()
  })

  it('clears the latest reply when a plain assistant message replaces it', () => {
    const h = harness()
    h.emitSession(assistantEvent(reply(BROKEN)))
    h.emitSession(assistantEvent('普通文本'))
    h.boundary({ agent: { session: { id: 'sess-1', header: { id: 'sess-1' } }, steer: h.steer }, turn: 1, signal: new AbortController().signal })
    expect(h.steer).not.toHaveBeenCalled()
  })

  it('releases session feedback state after session disposal', () => {
    const h = harness()
    h.emitSession(assistantEvent(reply(BROKEN)))
    h.disposeSession()
    h.boundary({ agent: { session: { id: 'sess-1', header: { id: 'sess-1' } }, steer: h.steer }, turn: 1, signal: new AbortController().signal })
    expect(h.steer).not.toHaveBeenCalled()
  })
})
