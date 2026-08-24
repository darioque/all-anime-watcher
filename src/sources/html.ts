import { load } from "cheerio/slim"
import type { CheerioAPI } from "cheerio/slim"

/**
 * `cheerio/slim` on purpose: the package's default entry pulls in `undici` and
 * `node:stream` for its file/stream loaders, which do not belong in an extension
 * bundle. The slim entry is parse-and-query only, which is all a source needs.
 */
export type Html = CheerioAPI
/** What `$(selector)` hands back. Named so signatures stay readable. */
export type Selection = ReturnType<CheerioAPI>

/** Parse an HTML string. Sources always work on strings, never a live DOM. */
export function parse(html: string): Html {
    return load(html)
}

/**
 * Text of an element's direct text children only, ignoring nested elements.
 * Several themes put the title in a container that also holds badges, so
 * `.text()` yields "Some Anime TVSub12" where ownText yields "Some Anime".
 */
export function ownText($el: Selection): string {
    return $el
        .contents()
        .filter((_, node) => node.type === "text")
        .text()
        .trim()
}

/** First non-empty attribute among the candidates. Handles lazy-loaded images. */
export function attrOf($el: Selection, ...names: string[]): string | undefined {
    for (const name of names) {
        const value = $el.attr(name)
        if (value && value.trim() !== "") return value.trim()
    }
    return undefined
}

/** Leading number in a string: "47", "Episode 12.5", "Ep. 3 - Title". */
export function leadingNumber(text: string): number | null {
    const match = text.match(/-?\d+(?:\.\d+)?/)
    if (!match) return null
    const value = Number.parseFloat(match[0])
    return Number.isFinite(value) ? value : null
}

/**
 * Parse the loose date strings themes emit ("August 24, 2026"). Returns
 * undefined rather than guessing — a wrong air date is worse than none.
 */
export function looseDate(text: string | undefined): number | undefined {
    if (!text) return undefined
    const trimmed = text.trim()
    if (trimmed === "") return undefined
    const parsed = Date.parse(trimmed)
    return Number.isFinite(parsed) ? parsed : undefined
}
