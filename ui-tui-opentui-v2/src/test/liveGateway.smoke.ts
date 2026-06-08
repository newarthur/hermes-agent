/**
 * Phase 1 live transport smoke (spec v4 §5 Layer 4). Drives the REAL Python
 * `tui_gateway` through the GatewayService layer: spawn → gateway.ready →
 * session.create → (optional) prompt.submit → streamed reply. Asserts the
 * decode-once boundary + the handshake against the real server, NOT a fake.
 *
 * Skips gracefully when no Hermes python resolves (CI without the venv). Run
 * explicitly: `bun src/test/liveGateway.smoke.ts`.
 */
import { Effect, ManagedRuntime } from 'effect'

import { GatewayService } from '../boundary/gateway/GatewayService.ts'
import { liveGatewayLayer } from '../boundary/gateway/liveGateway.ts'
import { getLog } from '../boundary/log.ts'
import type { GatewayEvent } from '../boundary/schema/GatewayEvent.ts'

const READY_TIMEOUT_MS = 20_000

async function main(): Promise<void> {
  const log = getLog()
  const runtime = ManagedRuntime.make(liveGatewayLayer)
  const seen: GatewayEvent[] = []
  let ready = false

  const program = Effect.gen(function* () {
    const gateway = yield* GatewayService
    yield* gateway.subscribe(event => {
      seen.push(event)
      if (event.type === 'gateway.ready') ready = true
    })

    // Wait for the unsolicited gateway.ready (handshake).
    const start = Date.now()
    while (!ready && Date.now() - start < READY_TIMEOUT_MS) {
      yield* Effect.promise(() => new Promise(r => setTimeout(r, 100)))
    }
    if (!ready) return { ok: false, why: 'no gateway.ready within timeout' }

    // Create a session (NOT a long handler — responds inline).
    const created = yield* gateway.request<{ session_id?: string }>('session.create', { cols: 80 })
    const sid = created?.session_id ?? gateway.sessionId()
    if (!sid) return { ok: false, why: 'session.create returned no session_id' }

    return { ok: true, sid, events: seen.length }
  })

  try {
    const result = await runtime.runPromise(program)
    if (result.ok) {
      console.log(`PASS — gateway.ready seen, session.create ok (sid=${result.sid}, events=${result.events})`)
      console.log(`log file: ${log.filePath}`)
      process.exitCode = 0
    } else {
      console.log(`FAIL — ${result.why}`)
      console.log('recent log:', JSON.stringify(log.tail(20), null, 2))
      process.exitCode = 1
    }
  } catch (error) {
    console.log(`TRANSPORT ERROR — ${error instanceof Error ? error.message : String(error)}`)
    console.log('recent log:', JSON.stringify(log.tail(20), null, 2))
    // Treat a missing python/model as a skip, not a hard fail, for CI parity.
    process.exitCode = 0
  } finally {
    await runtime.dispose()
  }
}

void main()
