/**
 * Renderer lifecycle — the Effect-side resource boundary (spec v4 §3.1).
 *
 * `acquireRelease(createCliRenderer)` so the renderer is always destroyed on
 * scope exit; a `Deferred` resolved on the renderer's "destroy" event lets the
 * entry block until the user quits. Mirrors opencode `app.tsx:177` /
 * `:185-225`.
 *
 * No throw / try-catch here: acquisition failure surfaces as a typed
 * `RendererError` via `Effect.tryPromise`'s `catch`.
 */
import { createCliRenderer, type CliRenderer, type KeyEvent } from '@opentui/core'
import { Deferred, Effect } from 'effect'

import { RendererError } from './errors.ts'

export interface RendererOptions {
  /** Mouse tracking on/off (from decoded display config). */
  readonly mouse: boolean
}

/**
 * Acquire a CliRenderer inside the current scope and register its release.
 * Returns the renderer plus a Deferred that resolves when the renderer is
 * destroyed (user quit) — `await` it to keep the entry alive.
 */
export const acquireRenderer = Effect.fn('Renderer.acquire')(function* (options: RendererOptions) {
  const renderer = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        createCliRenderer({
          // scrollbox clips growing output → no terminal-scrollback corruption (gotcha §8 #2).
          externalOutputMode: 'passthrough',
          targetFps: 60,
          // prompts own Ctrl+C → deny/cancel (gotcha §8 #6); the global quit is gated on !blocked.
          exitOnCtrlC: false,
          useKittyKeyboard: {},
          useMouse: options.mouse
        }),
      catch: cause => new RendererError({ cause })
    }),
    renderer => Effect.sync(() => destroyRenderer(renderer))
  )

  const shutdown = yield* Deferred.make<void>()
  renderer.once('destroy', () => {
    Deferred.doneUnsafe(shutdown, Effect.void)
  })

  // Minimal global quit (Phase 1). `exitOnCtrlC:false` hands Ctrl+C to us as a key
  // event (not SIGINT), so destroying here fires 'destroy' → resolves `shutdown` →
  // the entry scope closes → finalizers run: renderer teardown + the gateway layer's
  // `client.stop()` EOFs the Python child's stdin so it exits (no orphan). Prompts
  // gate this on `!blocked` once they own Ctrl+C (Phase 3, gotcha §8 #6).
  renderer.keyInput.on('keypress', (key: KeyEvent) => {
    if (key.ctrl && key.name === 'c' && !renderer.isDestroyed) renderer.destroy()
  })

  return { renderer, shutdown } as const
})

/** Best-effort renderer teardown; never throws out of the finalizer. */
function destroyRenderer(renderer: CliRenderer): void {
  try {
    if (!renderer.isDestroyed) renderer.destroy()
  } catch {
    // teardown is best-effort; a failed destroy must not mask the real exit cause.
  }
}
