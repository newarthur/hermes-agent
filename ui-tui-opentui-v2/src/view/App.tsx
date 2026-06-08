/**
 * App — the Solid view shell (spec v4 §2 `view/App.tsx`). Phase 1: header +
 * transcript, fully themed via `useTheme()` — NO hardcoded styles (spec §7.5).
 * The streamed message + skin both come from the store; the boundary feeds them.
 *
 * Rich text uses <b>/<span> children, never an attributes bitmask (gotcha §8 #1).
 * Inline color goes in `style={{ fg }}` on <span>; <text> accepts `fg` directly.
 */
import { For, Show } from 'solid-js'

import type { SessionStore } from '../logic/store.ts'
import { useTheme } from './theme.tsx'

export interface AppProps {
  readonly store: SessionStore
}

export function App(props: AppProps) {
  const theme = useTheme()

  return (
    <box style={{ flexDirection: 'column', flexGrow: 1, padding: 1 }}>
      <box style={{ flexShrink: 0 }}>
        <text>
          <b>{theme().brand.name}</b>
          <span style={{ fg: theme().color.muted }}> · opentui · </span>
          <Show when={props.store.state.ready} fallback={<span style={{ fg: theme().color.muted }}>connecting…</span>}>
            <span style={{ fg: theme().color.ok }}>ready</span>
          </Show>
        </text>
      </box>
      <box style={{ flexDirection: 'column', flexGrow: 1, minHeight: 0, marginTop: 1 }}>
        <For each={props.store.state.messages}>
          {message => (
            <text>
              <span style={{ fg: message.role === 'assistant' ? theme().color.accent : theme().color.prompt }}>
                {message.role === 'assistant' ? `${theme().brand.icon} ` : `${theme().brand.prompt} `}
              </span>
              <span style={{ fg: theme().color.text }}>{message.text}</span>
              <Show when={message.streaming}>
                <span style={{ fg: theme().color.muted }}>▍</span>
              </Show>
            </text>
          )}
        </For>
      </box>
    </box>
  )
}
