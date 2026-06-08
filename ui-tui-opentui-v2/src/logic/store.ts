/**
 * Session/message store — the SOLID side (spec v4 §1, §7.5). Plain `createStore`
 * + an `apply(event)` reducer, à la opencode `context/sync-v2.tsx`. NOT Effect.
 * The boundary calls `apply` with already-decoded `GatewayEvent`s via
 * GatewayService.subscribe.
 *
 * Phase 1 scope:
 *  - streaming text reducer (start/delta/complete; prefer `text` over `rendered`)
 *  - reactive `theme` updated from gateway.ready{skin} / skin.changed → fromSkin
 *  - LRU id-dedup (events carrying a stable id applied at most once)
 *  - hydrate-while-buffering hook (resume): snapshot replaces history, live
 *    events that arrive mid-hydrate are buffered then replayed
 * Phase 2 grows the message model into ordered parts (text/tool/reasoning, §7).
 */
import { createStore, produce } from 'solid-js/store'

import type { GatewayEvent, GatewaySkinDecoded } from '../boundary/schema/GatewayEvent.ts'
import { DEFAULT_THEME, type Theme, themeFromSkin } from './theme.ts'

export interface Message {
  readonly role: 'user' | 'assistant' | 'system'
  text: string
  streaming?: boolean
}

export interface StoreState {
  ready: boolean
  messages: Message[]
  theme: Theme
}

const LRU_LIMIT = 1000

export function createSessionStore() {
  const [state, setState] = createStore<StoreState>({
    ready: false,
    messages: [],
    theme: DEFAULT_THEME
  })

  // LRU id-dedup: events that carry a stable id are applied at most once.
  const applied = new Set<string>()
  function duplicate(id: string | undefined): boolean {
    if (!id) return false
    if (applied.has(id)) return true
    applied.add(id)
    if (applied.size > LRU_LIMIT) {
      const oldest = applied.values().next()
      if (!oldest.done) applied.delete(oldest.value)
    }
    return false
  }

  // Hydrate-while-buffering (resume): while a snapshot is loading, live events
  // queue here and replay after the snapshot is reconciled (opencode sync-v2).
  let buffering: GatewayEvent[] | null = null

  function setSkin(skin: GatewaySkinDecoded | undefined): void {
    setState('theme', themeFromSkin(skin))
  }

  /** Push a user message (composer submit). */
  function pushUser(text: string) {
    setState(
      produce(draft => {
        draft.messages.push({ role: 'user', text })
      })
    )
  }

  /** Reduce a decoded gateway event into the store. The sole boundary->Solid sink. */
  function apply(event: GatewayEvent): void {
    if (buffering) {
      buffering.push(event)
      return
    }
    applyNow(event)
  }

  function applyNow(event: GatewayEvent): void {
    switch (event.type) {
      case 'gateway.ready':
        setState('ready', true)
        setSkin(event.payload?.skin)
        break
      case 'skin.changed':
        setSkin(event.payload)
        break
      case 'message.start':
        setState(
          produce(draft => {
            draft.messages.push({ role: 'assistant', text: '', streaming: true })
          })
        )
        break
      case 'message.delta': {
        // prefer `text` over `rendered` (gotcha §8 #4 — rendered is incremental Rich-ANSI).
        const text = event.payload?.text ?? ''
        if (!text) break
        setState(
          produce(draft => {
            const live = draft.messages[draft.messages.length - 1]
            if (live && live.role === 'assistant' && live.streaming) live.text += text
          })
        )
        break
      }
      case 'message.complete':
        setState(
          produce(draft => {
            const live = draft.messages[draft.messages.length - 1]
            if (live && live.role === 'assistant' && live.streaming) {
              const finalText = event.payload?.text
              if (finalText) live.text = finalText
              live.streaming = false
            }
          })
        )
        break
      // Other event types (tools, prompts, chrome, subagents) are reduced in
      // later phases; unhandled members are intentionally ignored here.
    }
  }

  /**
   * Begin a resume hydrate: buffer live events, replace history with the
   * snapshot, then replay buffered events. `loadSnapshot` maps the gateway's
   * historical messages into the store's Message[] (Phase 4 fills the mapping).
   */
  function hydrate(loadSnapshot: () => Message[]): void {
    buffering = []
    const snapshot = loadSnapshot()
    setState('messages', snapshot)
    const pending = buffering
    buffering = null
    for (const event of pending) applyNow(event)
  }

  return { state, apply, pushUser, hydrate, duplicate } as const
}

export type SessionStore = ReturnType<typeof createSessionStore>
