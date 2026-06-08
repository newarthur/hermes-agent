/**
 * Phase 1 schema test (spec v4 §5 Layer 1/4). The gateway-contract decode: known
 * events decode with typed narrowing, unrecognized `type` and malformed payloads
 * are SKIPPED (Option.none) so a stray wire event never tears down the stream.
 */
import { describe, expect, test } from 'bun:test'
import { Option, Schema } from 'effect'

import { GatewayEventSchema } from '../boundary/schema/GatewayEvent.ts'

const decode = Schema.decodeUnknownOption(GatewayEventSchema)

describe('GatewayEvent schema decode (Phase 1)', () => {
  test('decodes a known event with typed narrowing', () => {
    const ev = decode({ type: 'message.delta', payload: { text: 'hi' }, session_id: 's1' })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'message.delta') {
      expect(ev.value.payload?.text).toBe('hi')
      expect(ev.value.session_id).toBe('s1')
    }
  })

  test('decodes gateway.ready carrying a skin', () => {
    const ev = decode({ type: 'gateway.ready', payload: { skin: { colors: { ui_primary: '#abc123' } } } })
    expect(Option.isSome(ev)).toBe(true)
    if (Option.isSome(ev) && ev.value.type === 'gateway.ready') {
      expect(ev.value.payload?.skin?.colors?.ui_primary).toBe('#abc123')
    }
  })

  test('decodes the 4 blocking prompt requests', () => {
    expect(Option.isSome(decode({ type: 'clarify.request', payload: { question: '?', request_id: 'r' } }))).toBe(true)
    expect(Option.isSome(decode({ type: 'approval.request', payload: { command: 'rm', description: 'd' } }))).toBe(true)
    expect(Option.isSome(decode({ type: 'sudo.request', payload: { request_id: 'r' } }))).toBe(true)
    expect(
      Option.isSome(decode({ type: 'secret.request', payload: { env_var: 'X', prompt: 'p', request_id: 'r' } }))
    ).toBe(true)
  })

  test('SKIPS an unrecognized event type (Option.none, no throw)', () => {
    expect(Option.isNone(decode({ type: 'totally.unknown.event', foo: 1 }))).toBe(true)
  })

  test('SKIPS a malformed payload (missing required field)', () => {
    // clarify.request requires request_id
    expect(Option.isNone(decode({ type: 'clarify.request', payload: { question: '?' } }))).toBe(true)
  })
})
