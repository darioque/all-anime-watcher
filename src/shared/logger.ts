type Level = "silent" | "error" | "warn" | "info" | "debug"

const ORDER: Record<Level, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }

let current: Level = "debug"

export function setLogLevel(level: Level) {
    current = level
}

function enabled(level: Exclude<Level, "silent">) {
    return ORDER[level] <= ORDER[current]
}

/**
 * Scoped logger. `log("sources:lmanime").debug(...)` prints `[sources:lmanime]`,
 * which is what makes background noise readable once a dozen subsystems are live.
 */
export function log(scope: string) {
    const tag = `[${scope}]`
    return {
        debug: (...a: unknown[]) => enabled("debug") && console.debug(tag, ...a),
        info: (...a: unknown[]) => enabled("info") && console.info(tag, ...a),
        warn: (...a: unknown[]) => enabled("warn") && console.warn(tag, ...a),
        error: (...a: unknown[]) => enabled("error") && console.error(tag, ...a)
    }
}

export type Logger = ReturnType<typeof log>
