/**
 * Log — TUI diagnostics sink (glitch: "v. important … hook into logs to figure
 * out TUI state"). Design mirrors opencode's `util/log.ts` (levels + priority
 * filter, scoped/child loggers, a `.time()` span helper) but adds a dual sink:
 *
 *   1. an in-memory RING BUFFER (queryable at runtime — a `/logs` overlay or a
 *      test asserting TUI state transitions can read it live), AND
 *   2. an append-only NDJSON FILE (default `~/.hermes/logs/opentui-v2.log`,
 *      override via HERMES_TUI_LOG_FILE) so a live session is `tail -f`-able.
 *
 * The ring buffer is the key advantage over opencode's file-only logger: it lets
 * us inspect engine state from inside the running TUI without leaving it.
 *
 * CRITICAL: OpenTUI HIJACKS `console.*` and stdout (opentui skill / gotcha) —
 * logging to the terminal corrupts the rendered frame. So this NEVER touches
 * console/stdout/stderr; file + ring only. It's the single approved logging path
 * for the whole engine. Level filter via HERMES_TUI_LOG_LEVEL (default INFO).
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const PRIORITY: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export interface LogEntry {
  readonly t: number // epoch ms
  readonly level: LogLevel
  readonly scope: string
  readonly msg: string
  readonly data?: unknown
}

const RING_LIMIT = 2000

function defaultLogFile(): string {
  const explicit = process.env.HERMES_TUI_LOG_FILE?.trim()
  if (explicit) return explicit
  return join(homedir(), '.hermes', 'logs', 'opentui-v2.log')
}

function defaultLevel(): LogLevel {
  const raw = process.env.HERMES_TUI_LOG_LEVEL?.trim().toLowerCase()
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info'
}

/** A timing span — call `.stop()` (or `using` it) to log completion + duration. */
export interface TimeSpan {
  stop: () => void
  [Symbol.dispose]: () => void
}

export class Log {
  private ring: LogEntry[] = []
  private file: string | null
  private fileBroken = false
  private minPriority: number

  constructor(file: string | null = defaultLogFile(), level: LogLevel = defaultLevel()) {
    this.file = file
    this.minPriority = PRIORITY[level]
    if (this.file) {
      try {
        mkdirSync(dirname(this.file), { recursive: true })
      } catch {
        this.fileBroken = true
      }
    }
  }

  setLevel(level: LogLevel): void {
    this.minPriority = PRIORITY[level]
  }

  private write(level: LogLevel, scope: string, msg: string, data?: unknown): void {
    if (PRIORITY[level] < this.minPriority) return
    const entry: LogEntry =
      data === undefined ? { t: Date.now(), level, scope, msg } : { t: Date.now(), level, scope, msg, data }
    this.ring.push(entry)
    if (this.ring.length > RING_LIMIT) this.ring.shift()

    if (this.file && !this.fileBroken) {
      try {
        appendFileSync(this.file, JSON.stringify(entry) + '\n')
      } catch {
        this.fileBroken = true // stop hammering a broken path; the ring keeps working
      }
    }
  }

  debug(scope: string, msg: string, data?: unknown): void {
    this.write('debug', scope, msg, data)
  }
  info(scope: string, msg: string, data?: unknown): void {
    this.write('info', scope, msg, data)
  }
  warn(scope: string, msg: string, data?: unknown): void {
    this.write('warn', scope, msg, data)
  }
  error(scope: string, msg: string, data?: unknown): void {
    this.write('error', scope, msg, data)
  }

  /** A logger bound to a fixed scope (opencode's tagged-logger ergonomics). */
  child(scope: string): ScopedLog {
    return new ScopedLog(this, scope)
  }

  /** Time an operation: logs `<msg> started` now and `<msg> completed` + duration on stop. */
  time(scope: string, msg: string, data?: Record<string, unknown>): TimeSpan {
    const started = Date.now()
    this.info(scope, `${msg} started`, data)
    const stop = () => this.info(scope, `${msg} completed`, { ...data, duration_ms: Date.now() - started })
    return { stop, [Symbol.dispose]: stop }
  }

  /** Snapshot of the in-memory ring (newest last). For a `/logs` overlay or tests. */
  tail(n = RING_LIMIT): LogEntry[] {
    return n >= this.ring.length ? [...this.ring] : this.ring.slice(this.ring.length - n)
  }

  /** Where the file log is written (for surfacing in the UI / `/logs`). */
  get filePath(): string | null {
    return this.fileBroken ? null : this.file
  }

  clear(): void {
    this.ring = []
  }
}

/** A logger with a fixed scope — forwards to the parent Log. */
export class ScopedLog {
  constructor(
    private readonly parent: Log,
    private readonly scope: string
  ) {}
  debug(msg: string, data?: unknown): void {
    this.parent.debug(this.scope, msg, data)
  }
  info(msg: string, data?: unknown): void {
    this.parent.info(this.scope, msg, data)
  }
  warn(msg: string, data?: unknown): void {
    this.parent.warn(this.scope, msg, data)
  }
  error(msg: string, data?: unknown): void {
    this.parent.error(this.scope, msg, data)
  }
  time(msg: string, data?: Record<string, unknown>): TimeSpan {
    return this.parent.time(this.scope, msg, data)
  }
}

let _singleton: Log | null = null

/** Module-singleton logger for the live engine. Tests construct their own `new Log(null)`. */
export function getLog(): Log {
  _singleton ??= new Log()
  return _singleton
}
