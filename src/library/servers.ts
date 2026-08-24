import type { Server } from "~/sources/types"

/**
 * Sort a page's servers by what the viewer actually wants.
 *
 * Sites label servers inconsistently — "English", "Server 2", "Multisub",
 * "Dailymotion" — so matching is a case-insensitive substring test against the
 * preference list rather than equality. A name preference outranks a variant
 * match, and anything unmatched keeps the page's own order behind the rest.
 */
export function orderServers(servers: Server[], preferred: string[], variant?: string): Server[] {
    const rank = (server: Server, index: number) => {
        const nameIndex = preferred.findIndex(p => p !== "" && server.name.toLowerCase().includes(p.toLowerCase()))
        const variantMiss =
            variant && server.variant ? (server.variant.toLowerCase() === variant.toLowerCase() ? 0 : 1) : 0
        return [nameIndex === -1 ? preferred.length : nameIndex, variantMiss, index] as const
    }

    return [...servers]
        .map((server, index) => ({ server, key: rank(server, index) }))
        .sort((a, b) => a.key[0] - b.key[0] || a.key[1] - b.key[1] || a.key[2] - b.key[2])
        .map(entry => entry.server)
}
