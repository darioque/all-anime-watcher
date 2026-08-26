/** Time formatting shared by the UI. No extension APIs, so it stays importable anywhere. */

/** Far enough out to mean "not scheduled" without needing a null case in the DB index. */
export const NEVER = 8_640_000_000_000_000

/** "3m ago", "2d ago". For a timestamp of 0, "never". */
export function relativePast(ts: number, now = Date.now()): string {
    if (!ts) return "never"
    const seconds = Math.floor((now - ts) / 1000)
    if (seconds < 60) return "just now"
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ago`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h ago`
    const days = Math.floor(hours / 24)
    return days < 30 ? `${days}d ago` : `${Math.floor(days / 30)}mo ago`
}

/** "in 3h", "tomorrow", "due now". */
export function relativeFuture(at: number, now = Date.now()): string {
    if (at >= NEVER) return "not scheduled"
    if (at <= now) return "due now"

    const seconds = Math.floor((at - now) / 1000)
    if (seconds < 90) return "in under a minute"
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `in ${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `in ${hours}h`
    const days = Math.floor(hours / 24)
    return days === 1 ? "tomorrow" : `in ${days}d`
}
