/**
 * SubRip to WebVTT.
 *
 * Several hosts serve `.srt`, which `<track>` refuses outright — Dailymotion is
 * one. The differences that matter are a header line and `,` for decimal
 * separators in timestamps; cue text carries over as-is, since the handful of
 * tags SRT uses (`<i>`, `<b>`, `<font>`) are valid in VTT too.
 *
 * Pure, and deliberately in `shared/` rather than beside the loader: a module
 * that imports the messaging layer can only be exercised inside an extension,
 * which in practice means never.
 *
 * **Not idempotent** — running it over WebVTT gives you two headers. Call
 * `isVtt` first, as `player/subtitles.ts` does.
 */
export function srtToVtt(srt: string): string {
    const body = srt
        .replace(/\r\n/g, "\n")
        .replace(/^﻿/, "")
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
        .trim()

    return `WEBVTT\n\n${body}\n`
}

/** True when the payload is already WebVTT and needs no conversion. */
export function isVtt(content: string): boolean {
    return content.trimStart().startsWith("WEBVTT")
}

/** True when the payload is an ASS/SSA script. */
export function isAss(content: string): boolean {
    return /^\s*\[Script Info\]/i.test(content.replace(/^﻿/, ""))
}

/**
 * ASS/SSA to WebVTT.
 *
 * `<track>` has no ASS renderer, and a script carries a lot WebVTT cannot say —
 * fonts, colours, karaoke timing, vector drawings. What it *can* say is who
 * speaks when, which is the part a viewer cannot do without, so that is what
 * survives: every `Dialogue:` line in time order, override blocks (`{\i1}`,
 * `{\pos(…)}`) stripped, `\N` as a line break. A line aligned to the top of the
 * frame (`\an7`–`\an9`, usually a sign or a name card) keeps that, so it does not
 * sit on top of the dialogue. Drawings (`\p1`) are dropped; they are shapes, not
 * text.
 *
 * Fields are read through the script's own `Format:` line rather than by
 * position, and the text is everything after the last named field, because
 * dialogue is free to contain commas.
 */
export function assToVtt(ass: string): string {
    const lines = ass.replace(/^﻿/, "").split(/\r?\n/)

    let fields = ["Layer", "Start", "End", "Style", "Name", "MarginL", "MarginR", "MarginV", "Effect", "Text"]
    let inEvents = false
    const cues: Array<{ start: number; end: number; text: string; top: boolean }> = []

    for (const line of lines) {
        const section = /^\s*\[(.+)\]\s*$/.exec(line)
        if (section) {
            inEvents = section[1]?.trim().toLowerCase() === "events"
            continue
        }
        if (!inEvents) continue

        const format = /^Format:\s*(.*)$/i.exec(line)
        if (format?.[1]) {
            fields = format[1].split(",").map(field => field.trim())
            continue
        }

        const dialogue = /^Dialogue:\s*(.*)$/i.exec(line)
        if (!dialogue?.[1]) continue

        const textIndex = fields.findIndex(field => field.toLowerCase() === "text")
        const parts = dialogue[1].split(",")
        if (textIndex < 0 || parts.length <= textIndex) continue
        const value = (name: string) => parts[fields.findIndex(field => field.toLowerCase() === name)]?.trim()

        const start = assTime(value("start"))
        const end = assTime(value("end"))
        const raw = parts.slice(textIndex).join(",")
        if (start === null || end === null || end <= start) continue
        if (/\\p[1-9]/.test(raw)) continue

        const top = /\\an[789]/.test(raw)
        const text = raw
            .replace(/\{[^}]*\}/g, "")
            .replace(/\\[Nn]/g, "\n")
            .replace(/\\h/g, " ")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .split("\n")
            .map(part => part.trim())
            .filter(part => part !== "")
            .join("\n")
        if (text === "") continue

        cues.push({ start, end, text, top })
    }

    cues.sort((a, b) => a.start - b.start || a.end - b.end)

    const body = cues
        .map(cue => `${vttTime(cue.start)} --> ${vttTime(cue.end)}${cue.top ? " line:5%" : ""}\n${cue.text}`)
        .join("\n\n")
    return `WEBVTT\n\n${body}\n`
}

/** "0:05:07.28" → seconds. ASS counts centiseconds. */
function assTime(value: string | undefined): number | null {
    const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(value ?? "")
    if (!match) return null
    const fraction = match[4] ? Number.parseInt(match[4].padEnd(3, "0"), 10) / 1000 : 0
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + fraction
}

function vttTime(seconds: number): string {
    const ms = Math.round(seconds * 1000)
    const pad = (n: number, width = 2) => String(n).padStart(width, "0")
    return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}
