import { describe, expect, it } from 'vitest'
import { processGenuiSpec, validateGenuiSpec } from '../src/client/guard.ts'
import type { GenuiSpec } from '../src/client/spec.ts'
import { analyzeSubmissionRegistry, compileSubmissionRegistry, isSubmissionMemberAnswered, resolveSubmitState } from '../src/client/submission-registry.ts'
import type { SubmitInteractionState } from '../src/client/submission-registry.ts'
import { walkGenuiNodes } from '../src/client/walk-spec.ts'

const emptyState: SubmitInteractionState = { answers: {}, multiAnswers: {}, fields: {}, secretFields: new Set() }

describe('submission registry', () => {
  it('visits every current GenUI node container with stable paths', () => {
    const spec = { items: [
      { type: 'row', items: [{ type: 'input', id: 'row' }] },
      { type: 'col', items: [{ type: 'textarea', id: 'col' }] },
      { type: 'grid', cols: 1, items: [{ type: 'select', id: 'grid', options: ['A'] }] },
      { type: 'card', items: [{ type: 'slider', id: 'card' }] },
      { type: 'tabs', tabs: [{ label: 'T', items: [{ type: 'radio', group: 'tab', options: ['A'] }] }] },
      { type: 'accordion', items: [{ title: 'A', items: [{ type: 'checkbox', group: 'fold', label: 'A' }] }] },
      { type: 'list', items: [{ type: 'input', id: 'list' }] },
    ] } as GenuiSpec
    const paths: string[] = []
    walkGenuiNodes(spec, (node, path) => { if ('id' in node || 'group' in node) paths.push(path) })
    expect(paths).toEqual([
      'items[0].items[0]', 'items[1].items[0]', 'items[2].items[0]', 'items[3].items[0]',
      'items[4].tabs[0].items[0]', 'items[5].items[0].items[0]', 'items[6].items[0]',
    ])
    expect([...compileSubmissionRegistry(spec).members.keys()]).toEqual(['row', 'col', 'grid', 'card', 'tab', 'fold', 'list'])
  })

  it('compiles static radio, checkbox, and field members', () => {
    const spec = { items: [
      { type: 'radio', group: 'q1', label: 'Question', options: ['A', 'B'], answer: 1, explanation: 'Because' },
      { type: 'checkbox', group: 'styles', label: 'A' },
      { type: 'checkbox', group: 'styles', label: 'B' },
      { type: 'input', id: 'secret', inputType: 'password' },
      { type: 'textarea', id: 'note' },
      { type: 'select', id: 'choice', options: ['A'] },
      { type: 'slider', id: 'amount' },
    ] } as GenuiSpec
    const { registry, diagnostics } = analyzeSubmissionRegistry(spec)
    expect(diagnostics).toEqual([])
    expect([...registry.members.values()]).toEqual([
      { kind: 'radio', key: 'q1', label: 'Question', options: ['A', 'B'], answer: 1, explanation: 'Because' },
      { kind: 'checkbox', key: 'styles' },
      { kind: 'field', key: 'secret', fieldType: 'input', secret: true },
      { kind: 'field', key: 'note', fieldType: 'textarea', secret: false },
      { kind: 'field', key: 'choice', fieldType: 'select', secret: false },
      { kind: 'field', key: 'amount', fieldType: 'slider', secret: false },
    ])
  })

  it('reports unknown, duplicate, secret, and colliding keys at their paths', () => {
    const cases: Array<{ items: GenuiSpec['items']; fragment: string }> = [
      { items: [{ type: 'submit', label: 'Send', groups: ['missing'] }], fragment: "items[0].groups[0]: submit.groups references unknown submission member 'missing'" },
      { items: [{ type: 'input', id: 'name' }, { type: 'submit', label: 'Send', groups: ['name', 'name'] }], fragment: "items[1].groups[1]: duplicate submission member 'name'" },
      { items: [{ type: 'input', id: 'name' }, { type: 'textarea', id: 'name' }], fragment: "items[1].id conflicts with items[0].id" },
      { items: [{ type: 'radio', group: 'q', options: ['A'] }, { type: 'radio', group: 'q', options: ['B'] }], fragment: "items[1].group conflicts with items[0].group" },
      { items: [{ type: 'radio', group: 'q', options: ['A'] }, { type: 'checkbox', group: 'q', label: 'B' }], fragment: "items[1].group conflicts with items[0].group" },
      { items: [{ type: 'radio', group: 'q', options: ['A'] }, { type: 'input', id: 'q' }], fragment: "items[1].id conflicts with items[0].group" },
      { items: [{ type: 'checkbox', group: 'q', label: 'A' }, { type: 'input', id: 'q' }], fragment: "items[1].id conflicts with items[0].group" },
      { items: [{ type: 'input', id: 'password', inputType: 'password' }, { type: 'submit', label: 'Send', groups: ['password'] }], fragment: "items[1].groups[0]: submit.groups cannot require secret field 'password'" },
    ]
    for (const { items, fragment } of cases) {
      const result = validateGenuiSpec({ items })
      expect(result.ok).toBe(false)
      expect(result.errors.some(error => error.includes(fragment)), fragment).toBe(true)
    }
    expect(validateGenuiSpec({ items: [
      { type: 'checkbox', group: 'styles', label: 'A' }, { type: 'checkbox', group: 'styles', label: 'B' },
      { type: 'submit', label: 'Send', action: 'send', groups: ['styles'] },
    ] }).ok).toBe(true)
    expect(processGenuiSpec({ items: [{ type: 'submit', label: 'Send', groups: ['missing'] }] }).errors)
      .toContain("items[0].groups[0]: submit.groups references unknown submission member 'missing'")
    expect(validateGenuiSpec({ items: [
      { type: 'tabs', tabs: [{ label: 'T', items: [{ type: 'input', id: 'key' }] }] },
      { type: 'accordion', items: [{ title: 'A', items: [{ type: 'radio', group: 'key', options: ['A'] }] }] },
    ] }).errors.some(error => error.includes('items[1].items[0].items[0].group conflicts with items[0].tabs[0].items[0].id'))).toBe(true)
  })

  it('uses the single answered rule for all member kinds', () => {
    const registry = compileSubmissionRegistry({ items: [
      { type: 'radio', group: 'radio', options: ['A'] },
      { type: 'checkbox', group: 'check', label: 'A' },
      { type: 'input', id: 'field' },
      { type: 'input', id: 'secret', inputType: 'password' },
    ] })
    const radio = registry.members.get('radio')!
    const check = registry.members.get('check')!
    const field = registry.members.get('field')!
    const secret = registry.members.get('secret')!
    expect([radio, check, field, secret].map(member => isSubmissionMemberAnswered(member, emptyState))).toEqual([false, false, false, false])
    const state = { answers: { radio: 'A' }, multiAnswers: { check: ['A'] }, fields: { field: '  ', secret: 'hidden' }, secretFields: new Set(['secret']) }
    expect([radio, check, field, secret].map(member => isSubmissionMemberAnswered(member, state))).toEqual([true, true, false, false])
    expect(isSubmissionMemberAnswered(field, { ...state, fields: { ...state.fields, field: ' x ' } })).toBe(true)
  })

  it('counts explicit and implicit scope and preserves action delivery for other payload state', () => {
    const registry = compileSubmissionRegistry({ items: [
      { type: 'radio', group: 'q1', options: ['A', 'B'], answer: 1 },
      { type: 'input', id: 'one' }, { type: 'input', id: 'two' },
      { type: 'checkbox', group: 'extras', label: 'X' },
    ] })
    const state = { ...emptyState, answers: { q1: 'B' }, fields: { one: '1', two: '2' } }
    expect(resolveSubmitState({ registry, groups: ['one', 'two'], state })).toMatchObject({ answered: 2, total: 2, canGradeLocally: false })
    expect(resolveSubmitState({ registry, state })).toMatchObject({ answered: 3, total: 3, canGradeLocally: false })
    expect(resolveSubmitState({ registry, groups: ['q1'], state })).toMatchObject({ answered: 1, total: 1, canGradeLocally: false })
    expect(resolveSubmitState({ registry, groups: ['q1'], state: { ...emptyState, answers: { q1: 'B' } } })).toMatchObject({ answered: 1, total: 1, canGradeLocally: true })
    expect(resolveSubmitState({ registry, state: { ...emptyState, answers: { q1: 'B' } } })).toMatchObject({ answered: 1, total: 1, canGradeLocally: true })
    expect(resolveSubmitState({ registry, groups: ['q1', 'missing'], state: { ...emptyState, answers: { q1: 'B' } } })).toMatchObject({ answered: 1, total: 2, canGradeLocally: false })
    expect(resolveSubmitState({ registry, groups: ['q1'], state: { ...emptyState, answers: { q1: 'B' }, multiAnswers: { extras: [] } } }).canGradeLocally).toBe(false)
  })
})
