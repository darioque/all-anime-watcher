/** Hostname with a leading `www.` removed. Returns "" for unparseable input. */
export function hostOf(url: string): string {
    try {
        const h = new URL(url).hostname
        return h.startsWith("www.") ? h.slice(4) : h
    } catch {
        return ""
    }
}

/** Pathname including a leading slash, query and hash dropped. */
export function pathOf(url: string): string {
    try {
        return new URL(url).pathname
    } catch {
        return ""
    }
}

export function originOf(url: string): string {
    try {
        return new URL(url).origin
    } catch {
        return ""
    }
}

/**
 * Match a hostname against a domain pattern that may contain `*` wildcards.
 * `*.example.com` matches `sub.example.com`; `example.*` matches `example.to`.
 */
export function matchDomain(hostname: string, pattern: string): boolean {
    if (hostname === pattern) return true
    if (!pattern.includes("*")) return false
    const rx = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$")
    return rx.test(hostname)
}

/** Resolve a possibly-relative or protocol-relative URL against a base. */
export function absoluteUrl(value: string, base: string): string {
    if (!value) return ""
    if (value.startsWith("//")) return "https:" + value
    try {
        return new URL(value, base).toString()
    } catch {
        return value
    }
}

export function stripTrailingSlash(value: string): string {
    return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value
}

export function ensureTrailingSlash(value: string): string {
    return value.endsWith("/") ? value : value + "/"
}

/** Replace only the origin of `url`, keeping path, query and hash. */
export function swapOrigin(url: string, newOrigin: string): string {
    try {
        const u = new URL(url)
        const n = new URL(newOrigin)
        u.protocol = n.protocol
        u.host = n.host
        return u.toString()
    } catch {
        return url
    }
}

/** The `#fragment`, without its leading hash. "" when there is none. */
/**
 * The query string, without its "?".
 *
 * Needed because a source whose grouping page is a search ("/?s=…") carries the
 * series name in the query and nothing but "/" in the path — so a comparison
 * that reads the path alone cannot tell two of its series apart.
 */
export function queryOf(url: string): string {
    try {
        return new URL(url).search.replace(/^\?/, "")
    } catch {
        return ""
    }
}

export function fragmentOf(url: string): string {
    try {
        return new URL(url).hash.replace(/^#/, "")
    } catch {
        return ""
    }
}
