import type { Track } from "~/extractors/types"
import { isAss, isVtt } from "~/shared/vtt"

/**
 * Subtitles saved next to a downloaded episode, as sidecar files.
 *
 * Sidecars rather than muxing them in: the video is a transport stream, which
 * cannot carry text subtitles at all, and remuxing to MKV in an extension means
 * shipping a muxer. A file named like the video — `Show - E05.en.ass` beside
 * `Show - E05.ts` — is picked up on its own by mpv, VLC, Jellyfin and Plex.
 *
 * Whether there is anything to save is a property of the *server*, not the
 * site: one host burns the subtitles into the picture, another on the same page
 * sends them as separate files that the player has to be told to show.
 *
 * Kept free of transport so it can be tested; see `npm run check:downloads`.
 */

export type SubtitleChoice = "preferred" | "all" | "off"

export type SubtitleFormat = "vtt" | "ass" | "srt"

/**
 * Which of a stream's tracks to save.
 *
 * "preferred" falls back to every track when none matches, because the usual
 * reason for no match is a host that labels its one English track "Default" or
 * leaves the language off — and saving nothing is the one outcome that is
 * certainly wrong for a server whose video has no subtitles of its own.
 */
export function chooseTracks(tracks: Track[], choice: SubtitleChoice, languages: string[]): Track[] {
    const usable = tracks.filter(track => track.url)
    if (choice === "off" || usable.length === 0) return []
    if (choice === "all") return usable

    const wanted = languages.map(language => language.trim().toLowerCase()).filter(Boolean)
    if (wanted.length === 0) return usable

    const matching = usable.filter(track => wanted.some(language => trackSpeaks(track, language)))
    return matching.length > 0 ? matching : usable
}

/** "en" matches a track tagged `en`, `en-US` or `eng`, or one labelled "English". */
function trackSpeaks(track: Track, language: string): boolean {
    const tag = track.language?.toLowerCase()
    if (tag && (tag === language || tag.startsWith(`${language}-`) || tag.startsWith(language))) return true

    const name = languageName(language)?.toLowerCase()
    const label = track.label.toLowerCase()
    return Boolean(name && label.includes(name)) || label === language
}

function languageName(code: string): string | undefined {
    try {
        return new Intl.DisplayNames(["en"], { type: "language" }).of(code)
    } catch {
        return undefined
    }
}

/**
 * The format a payload actually is, whatever the track claimed.
 *
 * Kept as delivered rather than converted: the player flattens ASS to WebVTT
 * because `<track>` can show nothing else, but a desktop player renders ASS
 * properly, and the styling is half of what a fansub's script is.
 */
export function subtitleFormat(content: string): SubtitleFormat {
    if (isVtt(content)) return "vtt"
    if (isAss(content)) return "ass"
    return "srt"
}

export const SUBTITLE_MIME: Record<SubtitleFormat, string> = {
    vtt: "text/vtt",
    ass: "text/x-ssa",
    srt: "application/x-subrip"
}

/**
 * Sidecar names for a set of tracks, in the same order.
 *
 * The video's name with its extension replaced by `.<tag>.<format>`. The tag is
 * the language when the track has one; two tracks sharing a language (a "full"
 * and a "signs only", say) add their label so neither overwrites the other.
 */
export function sidecarNames(videoFilename: string, tracks: { track: Track; format: SubtitleFormat }[]): string[] {
    const stem = videoFilename.replace(/\.[^./]+$/, "")
    const tags = tracks.map(({ track }) => tagFor(track.language) || tagFor(track.label) || "und")

    const seen = new Map<string, number>()
    for (const tag of tags) seen.set(tag, (seen.get(tag) ?? 0) + 1)

    const used = new Set<string>()
    return tracks.map(({ track, format }, index) => {
        let tag = tags[index]!
        if ((seen.get(tag) ?? 0) > 1) {
            const label = tagFor(track.label)
            if (label && label !== tag) tag = `${tag}.${label}`
        }
        let name = `${stem}.${tag}.${format}`
        for (let n = 2; used.has(name); n++) name = `${stem}.${tag}${n}.${format}`
        used.add(name)
        return name
    })
}

/** One path-safe word or two: no separators, nothing Windows refuses, no dots. */
function tagFor(value: string | undefined): string {
    return (value ?? "")
        .replace(/[<>:"\\|?*/\u0000-\u001f]/g, "")
        .replace(/[.\s]+/g, " ")
        .trim()
        .slice(0, 40)
}
