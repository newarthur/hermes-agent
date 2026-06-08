/**
 * Low-level JSON-RPC-over-stdio client for the Python `tui_gateway` (spec v4 §4).
 * Re-authored minimal (NOT the Ink client's 740-LOC attach-mode/buffering) but
 * the WIRE CONTRACT is identical (verified against ui-tui/src/gatewayClient.ts +
 * tui_gateway/server.py + entry.py + transport.py):
 *
 *  - spawn: `python -m tui_gateway.entry`, cwd=srcRoot, env={...process.env,
 *    PYTHONPATH=srcRoot:…, HERMES_PYTHON_SRC_ROOT=srcRoot}, stdio piped.
 *  - framing: newline-delimited compact JSON, BOTH directions, on ONE stdout.
 *  - request:  {id:"r<n>", jsonrpc:"2.0", method, params} + "\n".
 *  - response: {jsonrpc, id, result} | {jsonrpc, id, error:{code,message}} — match by id.
 *  - event:    {jsonrpc, method:"event", params:{type, session_id?, payload?}} (NO id).
 *  - handshake: child emits {event, params:{type:"gateway.ready", payload:{skin}}}
 *    UNSOLICITED first; no subscribe RPC. Then client drives session.create /
 *    session.resume / prompt.submit / *.respond.
 *  - GOTCHA: session.resume/prompt.submit/slash.exec are LONG handlers — their
 *    {id,result} arrives async, interleaved with events. Keep the pending map
 *    authoritative; never assume in-order response delivery.
 *
 * Raw events are surfaced as `unknown` (the params object). The liveGateway
 * layer Schema-decodes them once at the boundary (spec v4 §3.3); this client
 * stays decode-agnostic so the transport and the schema evolve independently.
 */
import type { Log } from '../log.ts'
import { resolvePython, resolveSrcRoot } from './python.ts'

interface Pending {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  method: string
}

export interface RawClientOptions {
  readonly log: Log
  /** Called with each server-pushed event's `params` object (still unknown — decoded upstream). */
  readonly onEvent: (params: unknown) => void
  /** Called when the child exits / errors (so the layer can reject pending + reconnect). */
  readonly onExit?: (reason: string) => void
}

const REQUEST_TIMEOUT_MS = 120_000

export class RawGatewayClient {
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private pending = new Map<string, Pending>()
  private reqId = 0
  private stdinBuffer = ''
  private readonly log: Log
  private readonly onEvent: (params: unknown) => void
  private readonly onExit?: (reason: string) => void

  constructor(options: RawClientOptions) {
    this.log = options.log
    this.onEvent = options.onEvent
    if (options.onExit) this.onExit = options.onExit
  }

  /** Spawn the gateway child and begin reading frames. Idempotent. */
  start(): void {
    if (this.proc) return
    const srcRoot = resolveSrcRoot()
    const python = resolvePython(srcRoot)
    const cwd = process.env.HERMES_CWD?.trim() || srcRoot
    const env: Record<string, string> = { ...(process.env as Record<string, string>) }
    env.PYTHONPATH = env.PYTHONPATH ? `${srcRoot}:${env.PYTHONPATH}` : srcRoot
    env.HERMES_PYTHON_SRC_ROOT = srcRoot

    this.log.info('gateway', 'spawning tui_gateway', { python, cwd, srcRoot })

    const proc = Bun.spawn([python, '-m', 'tui_gateway.entry'], {
      cwd,
      env,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      onExit: (_p, code, signal) => {
        const reason = `gateway exited (code=${code ?? 'null'} signal=${signal ?? 'null'})`
        this.log.warn('gateway', reason)
        this.rejectAll(reason)
        this.proc = null
        this.onExit?.(reason)
      }
    })
    this.proc = proc
    void this.readStdout(proc)
    void this.readStderr(proc)
  }

  private async readStdout(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const stream = proc.stdout
    if (!(stream instanceof ReadableStream)) return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        this.stdinBuffer += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = this.stdinBuffer.indexOf('\n')) >= 0) {
          const line = this.stdinBuffer.slice(0, nl)
          this.stdinBuffer = this.stdinBuffer.slice(nl + 1)
          if (line.trim()) this.dispatch(line)
        }
      }
    } catch (cause) {
      this.log.error('gateway', 'stdout read loop failed', { cause: String(cause) })
    }
  }

  private async readStderr(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    const stream = proc.stderr
    if (!(stream instanceof ReadableStream)) return
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (line.trim()) {
            this.log.debug('gateway.stderr', line)
            // Surface as a synthetic gateway.stderr event (matches Ink).
            this.onEvent({ type: 'gateway.stderr', payload: { line } })
          }
        }
      }
    } catch {
      // stderr pipe closing on exit is expected; ignore.
    }
  }

  private dispatch(line: string): void {
    let msg: unknown
    try {
      msg = JSON.parse(line)
    } catch {
      this.log.warn('gateway', 'unparseable frame', { preview: line.slice(0, 120) })
      this.onEvent({ type: 'gateway.protocol_error', payload: { preview: line.slice(0, 120) } })
      return
    }
    if (!msg || typeof msg !== 'object') return
    const frame = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }

    // Response: has an id matching a pending request.
    if (typeof frame.id === 'string' && this.pending.has(frame.id)) {
      const p = this.pending.get(frame.id)!
      this.pending.delete(frame.id)
      if (frame.error) {
        const err = frame.error as { code?: number; message?: string }
        p.reject(new Error(err.message ?? `rpc error (${err.code ?? '?'})`))
      } else {
        p.resolve(frame.result)
      }
      return
    }

    // Event push: method === "event", no id. Surface params (decoded upstream).
    if (frame.method === 'event' && frame.params && typeof frame.params === 'object') {
      this.onEvent(frame.params)
      return
    }

    this.log.warn('gateway', 'unroutable frame', { preview: line.slice(0, 120) })
  }

  /** Send a JSON-RPC request; resolves with `result` (long handlers reply async). */
  request<A = unknown>(method: string, params: unknown): Promise<A> {
    if (!this.proc) this.start()
    const proc = this.proc
    const stdin = proc?.stdin
    if (!stdin || typeof stdin === 'number') return Promise.reject(new Error('gateway not running'))

    const id = `r${++this.reqId}`
    const frame = JSON.stringify({ id, jsonrpc: '2.0', method, params: params ?? {} }) + '\n'

    return new Promise<A>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, {
        method,
        resolve: result => {
          clearTimeout(timer)
          resolve(result as A)
        },
        reject: error => {
          clearTimeout(timer)
          reject(error)
        }
      })

      try {
        stdin.write(frame)
        stdin.flush()
      } catch (cause) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
    })
  }

  private rejectAll(reason: string): void {
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
  }

  /** Close stdin (EOF → child exits) and stop. */
  stop(): void {
    this.rejectAll('gateway stopping')
    const stdin = this.proc?.stdin
    if (stdin && typeof stdin !== 'number') {
      try {
        stdin.end()
      } catch {
        // already gone
      }
    }
    this.proc = null
  }
}
