/**
 * Dean Edwards' `p,a,c,k,e,d` unpacker.
 *
 * Half the video hosts in this ecosystem ship their player config through it, so
 * this is shared infrastructure rather than one extractor's private helper.
 *
 * Two details that are easy to get wrong, and both produced silent failures here:
 *
 *  - **The symbol encoder is not base36.** Above radix 36 the packer switches to
 *    `String.fromCharCode(c + 29)`, giving uppercase letters. A base36-only
 *    implementation throws or, worse, mistranslates when a script has more than
 *    36 symbols.
 *  - **The payload contains `))`.** Matching the closing parens non-greedily
 *    truncates the script mid-way. Anchor on `.split('|')` instead, which is the
 *    one landmark the format guarantees.
 */

/** Digits the packer uses: 0-9, a-z, then A-Z. */
function encodeSymbol(value: number, radix: number): string {
    const digit = (n: number) => (n > 35 ? String.fromCharCode(n + 29) : n.toString(36))
    return (value >= radix ? encodeSymbol(Math.floor(value / radix), radix) : "") + digit(value % radix)
}

/**
 * Unpack every packed block in a document, in order.
 *
 * Returns the recovered sources. A block that doesn't parse is skipped rather
 * than throwing — pages routinely mix packed player config with packed UI code,
 * and only some of it is the part worth reading.
 */
export function unpackAll(html: string): string[] {
    const results: string[] = []

    for (const match of html.matchAll(/\}\s*\(\s*([\s\S]*?)\.split\('\|'\)/g)) {
        const args = match[1]
        if (!args) continue

        // …'PAYLOAD', RADIX, COUNT, 'WORDS'
        const tail = /,\s*(\d+)\s*,\s*(\d+)\s*,\s*'((?:[^'\\]|\\.)*)'\s*$/.exec(args)
        if (!tail) continue

        const radix = Number.parseInt(tail[1] ?? "", 10)
        const count = Number.parseInt(tail[2] ?? "", 10)
        const words = (tail[3] ?? "").split("|")
        if (!Number.isFinite(radix) || !Number.isFinite(count) || radix < 2) continue

        let payload = args.slice(0, tail.index).trim()
        if (payload.startsWith("'") && payload.endsWith("'")) payload = payload.slice(1, -1)
        payload = payload.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, "\\")

        const table = new Map<string, string>()
        for (let i = count - 1; i >= 0; i--) {
            const symbol = encodeSymbol(i, radix)
            const word = words[i]
            table.set(symbol, word && word !== "" ? word : symbol)
        }

        results.push(payload.replace(/\b\w+\b/g, token => table.get(token) ?? token))
    }

    return results
}

/** Unpack, then return the original document with the recovered sources appended. */
export function withUnpacked(html: string): string {
    const blocks = unpackAll(html)
    return blocks.length === 0 ? html : `${html}\n${blocks.join("\n")}`
}

/** Every `<iframe src>` in a string, including ones recovered from packed code. */
export function iframeSources(html: string): string[] {
    const found = [...withUnpacked(html).matchAll(/<iframe[^>]+src=['"]([^'"]+)['"]/gi)].map(m => m[1] ?? "")
    return [...new Set(found.filter(url => url !== ""))]
}
