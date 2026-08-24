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
