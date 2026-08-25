/** The download queue's vocabulary, shared by the background, the offscreen document and the UI. */

export type DownloadStatus =
    /** Waiting for a slot. */
    | "queued"
    /** Finding a server and extracting a stream — the same work playback does. */
    | "resolving"
    /** Pulling segments. */
    | "downloading"
    /** Handing the finished file to the browser's own download manager. */
    | "saving"
    | "done"
    | "failed"
    | "cancelled"

export interface DownloadJob {
    id: string
    /** Library key, so the row can be found again. */
    key: string
    sourceId: string
    title: string
    number: number
    variant?: string
    episodeUrl: string

    status: DownloadStatus
    /** Where it will be written, once known. */
    filename?: string
    /** 0..1, by segment count. Bytes are unknown until the last one arrives. */
    progress: number
    segmentsDone: number
    segmentsTotal: number
    bytes: number
    /** Which server and quality it settled on, for the row to show. */
    detail?: string
    error?: string

    addedAt: number
    startedAt?: number
    finishedAt?: number
}

/** One segment to fetch, with whatever it takes to decrypt it. */
export interface DownloadPart {
    url: string
    /** Absolute URL of the AES-128 key, when the playlist named one. */
    keyUrl?: string
    /** Hex IV as the playlist wrote it. Absent means the sequence number is the IV. */
    iv?: string
    /** Media sequence number — the implicit IV. */
    index: number
}

/**
 * A job reduced to "fetch these, in this order, and write them end to end".
 *
 * Everything site-specific has already happened by the time this is built: the
 * background resolved the server, chose the variant and installed the header
 * rewrites. The offscreen document is deliberately dumb, because it is the one
 * piece that has to keep running for ten minutes without a service worker.
 */
export interface FetchPlan {
    id: string
    filename: string
    /**
     * Content type of the finished file.
     *
     * Not cosmetic. Chrome picks a download's extension from the blob's MIME
     * type in preference to the filename it was given, so a blob with no type
     * gets saved as `.txt` however carefully the name says `.ts`. The scratch
     * file is `<id>.part`, which OPFS cannot guess a type from, so it has to be
     * stated here.
     */
    mime: string
    /** `#EXT-X-MAP`, written before everything else. */
    initUrl?: string
    parts: DownloadPart[]
}

/** Offscreen → background, while a job runs. */
export interface DownloadProgress {
    id: string
    segmentsDone: number
    segmentsTotal: number
    bytes: number
}
