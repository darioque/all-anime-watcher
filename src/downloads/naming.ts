/**
 * Turning a series and an episode into a path a download can actually be
 * written to, kept free of transport so it can be tested.
 *
 * `chrome.downloads.download` refuses a filename it dislikes with a single
 * opaque error and no indication which character was the problem, so everything
 * that could make it refuse is dealt with here instead. The rules are Windows'
 * rather than Linux's on purpose: a download folder is routinely on a shared or
 * synced drive, and a name that is legal here and illegal there fails at the
 * least convenient moment.
 */

export interface NameFields {
    title: string
    number: number
    /** No leading dot. */
    ext: string
    source?: string
    variant?: string
    quality?: string
}

/** Windows forbids these outright, and `/` is the separator we split on first. */
const ILLEGAL = /[<>:"\\|?*\u0000-\u001f]/g

/**
 * Reserved device names, which are refused *with or without* an extension —
 * "CON.mp4" is as unwritable as "CON".
 */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/** Long enough for a real title, short enough to survive a deep download folder. */
const MAX_SEGMENT = 120

/**
 * Fill a template and make the result writable.
 *
 * `/` in the template is meaningful — it makes a subfolder, which is the whole
 * point of the default `{title}/{title} - E{ep}.{ext}` — but `/` coming from a
 * *field* is not, or a series called "Fate/Zero" would silently become a folder.
 * So substitution happens into placeholders that are sanitised individually,
 * before the path is split.
 */
export function fileNameFor(template: string, fields: NameFields): string {
    const values: Record<string, string> = {
        title: fields.title,
        ep: formatEpisode(fields.number),
        ext: fields.ext.replace(/^\./, ""),
        source: fields.source ?? "",
        variant: fields.variant ?? "",
        quality: fields.quality ?? ""
    }

    /*
     * The leading group matters: a field that resolves to nothing takes the
     * separator in front of it with it. Without that, "{title} - {quality}" on a
     * stream with no stated quality writes "Xian Ni - .mp4", and the dangling
     * dash looks like the title was cut off rather than like a field being
     * absent. Separators only — "E{ep}" keeps its E.
     */
    const filled = template.replace(/([ \t]*[-_–—]?[ \t]*)?\{(\w+)\}/g, (whole, lead: string | undefined, name: string) => {
        const value = values[name]
        // An unknown placeholder is left as written rather than blanked: seeing
        // "{titel}" in the filename says what is wrong, an empty gap does not.
        if (value === undefined) return whole
        const safe = name === "ext" ? value.replace(ILLEGAL, "-") : segmentSafe(value)
        if (safe === "") return ""
        return `${lead ?? ""}${safe}`
    })

    const segments = filled
        .split("/")
        .map(segment => trimSegment(segment))
        .filter(segment => segment !== "" && segment !== "." && segment !== "..")

    if (segments.length === 0) return `episode.${values.ext || "bin"}`
    return segments.join("/")
}

/**
 * Two digits at least, so a file manager sorts E9 before E10.
 *
 * Fractions are real — recaps and specials are published as 13.5 — and keep
 * their decimal part rather than being rounded into the episode next to them.
 */
export function formatEpisode(number: number): string {
    if (!Number.isFinite(number)) return "0"
    const whole = Math.trunc(Math.abs(number))
    const padded = String(whole).padStart(2, "0")
    const fraction = Math.abs(number) - whole

    if (fraction === 0) return number < 0 ? `-${padded}` : padded
    const decimals = String(Number(fraction.toFixed(3))).slice(2)
    return `${number < 0 ? "-" : ""}${padded}.${decimals}`
}

/** One field's worth of text, with anything a path cannot hold taken out. */
function segmentSafe(value: string): string {
    return (
        value
            .replace(ILLEGAL, "-")
            // A field's own slashes are part of a title, not a folder boundary:
            // "Fate/Zero" is one series, not a folder called Fate.
            .replace(/\//g, "-")
            .replace(/\s+/g, " ")
            .trim()
            /*
             * Trailing dots and spaces go here rather than only at the end of the
             * finished segment, because a field is often followed by an
             * extension: a title of "Series ." would otherwise write
             * "Series ..mp4", where the offending dot is no longer last and the
             * segment-level trim cannot see it.
             */
            .replace(/[. ]+$/, "")
    )
}

/**
 * Finish one path segment: length, reserved names, and the trailing dot or space
 * Windows silently strips — which turns "Series ." into "Series" on one machine
 * and leaves it on another, so two backups of the same library stop matching.
 */
function trimSegment(segment: string): string {
    let result = segment.replace(ILLEGAL, "-").replace(/\s+/g, " ").trim()

    if (result.length > MAX_SEGMENT) {
        // Cut the name, never the extension: a truncated ".mp4" is unopenable.
        const dot = result.lastIndexOf(".")
        const ext = dot > 0 && result.length - dot <= 6 ? result.slice(dot) : ""
        result = result.slice(0, MAX_SEGMENT - ext.length).trim() + ext
    }

    if (RESERVED.test(result)) result = `_${result}`

    return result.replace(/[. ]+$/, "")
}
