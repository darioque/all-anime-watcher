import browser from "webextension-polyfill"
import type { Action, Envelope, Reply } from "~/shared/messages"
import { loadSettings, loadSourceSettings } from "~/settings/storage"
import { log } from "~/shared/logger"
import { isExpected } from "~/shared/errors"

const logger = log("router")

type Handler = (payload: unknown, sender: browser.Runtime.MessageSender) => Promise<unknown>

const handlers = new Map<string, Handler>()

/**
 * Register one action. Typed at the call site via the MessageMap, so a handler
 * whose return type drifts from the declared response fails to compile.
 */
export function on<A extends Action>(
    action: A,
    handler: (payload: Envelope<A>["payload"], sender: browser.Runtime.MessageSender) => Promise<unknown>
) {
    if (handlers.has(action)) throw new Error(`duplicate handler for "${action}"`)
    handlers.set(action, handler as Handler)
}

/**
 * Single onMessage listener, registered at the top level so it survives service
 * worker restarts. `ready` gates every message on initialisation finishing —
 * AMR learned this the hard way: a popup opened during startup would otherwise
 * read a half-empty store.
 */
export function installRouter(ready: Promise<unknown>) {
    browser.runtime.onMessage.addListener(
        async (message: unknown, sender: browser.Runtime.MessageSender): Promise<Reply<unknown>> => {
            const envelope = message as Partial<Envelope> | undefined
            if (!envelope?.action) {
                return { ok: false, error: "message had no action" }
            }

            const handler = handlers.get(envelope.action)
            if (!handler) {
                logger.error(`no handler for "${envelope.action}"`)
                return { ok: false, error: `no handler for "${envelope.action}"` }
            }

            try {
                await ready
                // Cheap when the cache is warm, and the only guarantee that a
                // handler reading settings synchronously never sees defaults —
                // the worker can be restarted between any two messages.
                await Promise.all([loadSettings(), loadSourceSettings()])
                const data = await handler(envelope.payload ?? {}, sender)
                return { ok: true, data }
            } catch (error) {
                const text = error instanceof Error ? error.message : String(error)
                logger.error(`"${envelope.action}" failed:`, error)
                return { ok: false, error: text }
            }
        }
    )
    logger.info(`router installed with ${handlers.size} handlers`)
}
