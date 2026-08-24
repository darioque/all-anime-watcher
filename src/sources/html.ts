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

/**
 * Attributes that hold the real image URL on a lazy-loading theme, in the order
 * worth trusting. `src` is last on purpose: lazy-loaders overwrite it with a
 * placeholder and keep the real URL in a data attribute, so preferring `src`
 * yields a blank image.
 */
const IMAGE_ATTRS = ["data-src", "data-lazy-src", "data-original", "data-lazy", "data-echo", "src", "srcset"]

/** A value that is a stand-in rather than a real image. */
function isPlaceholderImage(value: string): boolean {
    if (value === "") return true
    // Lazy-loaders inject an empty inline SVG or a 1x1 gif sized to the real image.
    if (value.startsWith("data:")) return true
    return /(?:^|\/)(?:blank|placeholder|lazy|spacer|transparent)[-_.]?\w*\.(?:gif|png|svg|webp)(?:\?|$)/i.test(value)
}

/**
 * Pull a usable image URL out of an `<img>`, skipping lazy-load placeholders.
 * Falls back to the `<noscript>` copy themes emit for crawlers, which is always
 * the real URL.
 *
 * @param $img the image element
 * @param base URL to resolve relative and protocol-relative values against
 * @param $ needed only for the noscript fallback
 */
export function imageUrlFrom($img: Selection, base: string, $?: Html): string | undefined {
    for (const attr of IMAGE_ATTRS) {
        const raw = $img.attr(attr)
        if (!raw) continue
        // srcset is "url 1x, url 2x" — take the first candidate.
        const value = attr === "srcset" ? (raw.split(",")[0]?.trim().split(/\s+/)[0] ?? "") : raw.trim()
        if (value === "" || isPlaceholderImage(value)) continue
        return resolveUrl(value, base)
    }

    // Themes wrap a non-lazy copy in <noscript> next to the lazy one. Whether a
    // parser treats noscript content as markup or as raw text depends on whether
    // scripting is assumed, so handle both.
    if ($) {
        const $noscript = $img.parent().find("noscript").first()
        if ($noscript.length > 0) {
            const nested = $noscript.find("img").first().attr("src")
            if (nested && !isPlaceholderImage(nested)) return resolveUrl(nested, base)

            const raw = $noscript.text() || $noscript.html() || ""
            const match = raw.match(/<img[^>]+src=["']([^"']+)["']/i)
            if (match?.[1] && !isPlaceholderImage(match[1])) return resolveUrl(match[1], base)
        }
    }

    return undefined
}

function resolveUrl(value: string, base: string): string {
    if (value.startsWith("//")) return "https:" + value
    try {
        return new URL(value, base).toString()
    } catch {
        return value
    }
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
