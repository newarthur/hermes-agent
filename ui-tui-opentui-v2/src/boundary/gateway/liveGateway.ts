/**
 * liveGateway — the GatewayService layer backed by the real Python `tui_gateway`
 * (spec v4 §2/§3.2). Adapts RawGatewayClient to GatewayServiceShape:
 *   - decodes each raw event ONCE with the GatewayEvent Schema
 *     (decodeUnknownOption → unrecognized/malformed events skipped, never crash),
 *   - coalesces decoded events on a 16ms debounce flushed inside Solid `batch()`
 *     so a burst of deltas is ONE repaint (opencode sdk.tsx:54-80),
 *   - tracks the session id (set from session.create/resume result) for
 *     approval.respond {session_id},
 *   - maps request failures to a typed GatewayError (never throws).
 *
 * The 16ms batch + `batch()` call is the boundary handing decoded events to
 * Solid — one of the two approved Effect<->Solid contact points (spec v4 §1).
 */
import { Effect, Layer, Option, Schema } from 'effect'
import { batch } from 'solid-js'

import { GatewayError } from '../errors.ts'
import { getLog } from '../log.ts'
import { GatewayEventSchema, type GatewayEvent } from '../schema/GatewayEvent.ts'
import { GatewayService, type GatewayServiceShape } from './GatewayService.ts'
import { RawGatewayClient } from './client.ts'

const COALESCE_MS = 16

const decodeEvent = Schema.decodeUnknownOption(GatewayEventSchema)

function makeLiveGateway(): { service: GatewayServiceShape; stop: () => void } {
  const log = getLog()
  const handlers = new Set<(event: GatewayEvent) => void>()
  let sessionId: string | undefined

  // 16ms event coalescing → one batched repaint (opencode sdk.tsx model).
  let queue: GatewayEvent[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = 0

  const flush = () => {
    timer = undefined
    if (queue.length === 0) return
    const events = queue
    queue = []
    last = Date.now()
    batch(() => {
      for (const event of events) {
        for (const handler of handlers) handler(event)
      }
    })
  }

  const enqueue = (event: GatewayEvent) => {
    queue.push(event)
    if (timer) return
    // If we flushed recently (<16ms ago) batch with near-future events; else flush now.
    if (Date.now() - last < COALESCE_MS) {
      timer = setTimeout(flush, COALESCE_MS)
    } else {
      flush()
    }
  }

  const onRawEvent = (params: unknown) => {
    const decoded = decodeEvent(params)
    if (Option.isNone(decoded)) {
      const t = (params as { type?: unknown } | null)?.type
      log.debug('gateway', 'skipped undecodable event', { type: typeof t === 'string' ? t : '(none)' })
      return
    }
    enqueue(decoded.value)
  }

  const client = new RawGatewayClient({
    log,
    onEvent: onRawEvent,
    onExit: reason => log.warn('gateway', 'transport exited', { reason })
  })

  const service: GatewayServiceShape = {
    subscribe: handler =>
      Effect.sync(() => {
        handlers.add(handler)
        // Lazily spawn on first subscription so the child + its gateway.ready land.
        client.start()
        return () => {
          handlers.delete(handler)
        }
      }),

    request: <A>(method: string, params: unknown) =>
      Effect.tryPromise({
        try: () => client.request<A>(method, params),
        catch: cause => {
          const message = cause instanceof Error ? cause.message : String(cause)
          const reason = message.startsWith('timeout:')
            ? ('timeout' as const)
            : message.includes('not running') || message.includes('stopping')
              ? ('transport-down' as const)
              : ('rpc-error' as const)
          return new GatewayError({ method, reason, message })
        }
      }).pipe(
        // Capture session id from create/resume results so approval.respond works.
        Effect.tap(result =>
          Effect.sync(() => {
            if ((method === 'session.create' || method === 'session.resume') && result && typeof result === 'object') {
              const sid = (result as { session_id?: unknown }).session_id
              if (typeof sid === 'string') sessionId = sid
            }
          })
        )
      ),

    sessionId: () => sessionId
  }

  return { service, stop: () => client.stop() }
}

/**
 * The live GatewayService layer (spawns + talks to the real Python tui_gateway).
 * Scoped so the child process is stopped (stdin EOF → exit) on scope teardown —
 * no orphaned gateway children when the renderer is destroyed.
 */
export const liveGatewayLayer: Layer.Layer<GatewayService> = Layer.effect(
  GatewayService,
  Effect.acquireRelease(Effect.sync(makeLiveGateway), ({ stop }) => Effect.sync(stop)).pipe(
    Effect.map(({ service }) => service)
  )
)
