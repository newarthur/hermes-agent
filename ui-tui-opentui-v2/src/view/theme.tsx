/**
 * ThemeProvider — the Solid context that exposes the current Theme to the view
 * (spec v4 §7.5; mirrors opencode `context/theme.tsx`). The view reads
 * `useTheme()().color.*` / `.brand.*` and NEVER hardcodes styles.
 *
 * The theme is a reactive accessor: when the boundary applies a skin
 * (gateway.ready{skin} / skin.changed → store updates the theme), Solid
 * fine-grained reactivity re-styles only the affected cells.
 */
import { type Accessor, createContext, type JSX, useContext } from 'solid-js'

import { DEFAULT_THEME, type Theme } from '../logic/theme.ts'

const ThemeContext = createContext<Accessor<Theme>>(() => DEFAULT_THEME)

export interface ThemeProviderProps {
  /** Reactive theme accessor (from the store). Defaults to DEFAULT_THEME if omitted. */
  readonly theme?: Accessor<Theme>
  readonly children: JSX.Element
}

export function ThemeProvider(props: ThemeProviderProps) {
  return <ThemeContext.Provider value={props.theme ?? (() => DEFAULT_THEME)}>{props.children}</ThemeContext.Provider>
}

/** Read the current theme inside a component. Call it (`useTheme()()`) to get the Theme. */
export function useTheme(): Accessor<Theme> {
  return useContext(ThemeContext)
}
