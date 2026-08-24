import browser from "webextension-polyfill"
import { getAllAnime, getDueAnime, putAnime } from "~/model/db"
import type { TrackedAnime } from "~/model/types"
import { refreshSeries } from "~/library/library"
import { nextCheckAt } from "./schedule"
import { notifyNewEpisodes } from "./notifications"
import { resolveAllDomains } from "./domains"
import { enrich } from "~/trackers/match"
import { refreshBadge } from "./badge"
import { cachedSettings } from "~/settings/storage"
import { resolve, resolveSchedule } from "~/settings/resolver"
import { log } from "~/shared/logger"

const logger = log("scheduler")

export const TICK_ALARM = "aaw-check-tick"
const TICK_MINUTES = 1

/**
 * In-flight guard. A run can outlive a service-worker wake-up, and two
 * overlapping runs would double every request a source sees.
 */
let running = false
let lastRunAt = 0
let lastRunFound = 0

export function installScheduler() {
    browser.alarms.create(TICK_ALARM, { periodInMinutes: TICK_MINUTES, delayInMinutes: 0.2 })

    browser.alarms.onAlarm.addListener(alarm => {
        if (alarm.name !== TICK_ALARM) return
        void runDueChecks().catch(error => logger.error("check run failed", error))
        // Piggybacks on the same tick; resolveAllDomains decides for itself
        // whether enough time has passed, so this costs nothing most minutes.
        void resolveAllDomains().catch(error => logger.error("domain check failed", error))
    })

    logger.info(`scheduler installed, ticking every ${TICK_MINUTES}m`)
}

export function schedulerStatus() {
    return { running, lastRunAt, lastRunFound }
}

/**
 * Check everything that has come due.
 *
 * Work is grouped by source and the groups run in parallel, but each source is
 * walked sequentially with a delay between requests. That shape is inherited
 * from AMR for a good reason: the constraint is politeness to any one site, not
 * total throughput, so parallelism belongs *across* sources and never within one.
 */
export async function runDueChecks(options: { force?: boolean } = {}): Promise<number> {
    if (running) {
        logger.debug("a check run is already in progress")
        return 0
    }
    if (!navigator.onLine) {
        logger.debug("offline, skipping")
        return 0
    }

    const settings = cachedSettings()
    const now = Date.now()

    const due = options.force
        ? (await getAllAnime()).filter(anime => anime.poll)
        : await getDueAnime(now, settings.maxChecksPerRun)

    if (due.length === 0) return 0

    running = true
    lastRunAt = now
    let found = 0

    try {
        const bySource = new Map<string, TrackedAnime[]>()
        for (const anime of due) {
            const list = bySource.get(anime.sourceId) ?? []
            list.push(anime)
            bySource.set(anime.sourceId, list)
        }

        logger.info(
            `checking ${due.length} series across ${bySource.size} source(s): ` +
                [...bySource].map(([id, list]) => `${id}×${list.length}`).join(", ")
        )

        const groups = [...bySource.entries()]
        const limit = Math.max(1, settings.maxParallelSources)
        let cursor = 0

        const worker = async () => {
            while (cursor < groups.length) {
                const group = groups[cursor++]
                if (!group) return
                found += await checkSource(group[0], group[1])
            }
        }

        await Promise.all(Array.from({ length: Math.min(limit, groups.length) }, worker))

        lastRunFound = found
        await refreshBadge()
        logger.info(`check run done — ${found} series with new episodes`)
    } finally {
        running = false
    }

    return found
}

async function checkSource(sourceId: string, list: TrackedAnime[]): Promise<number> {
    const delayMs = Math.max(0, resolve("sourceRequestDelaySec", { sourceId })) * 1000
    let found = 0

    for (const [index, anime] of list.entries()) {
        if (index > 0 && delayMs > 0) await sleep(delayMs)

        try {
            const { anime: updated, newEpisodes } = await withTimeout(
                refreshSeries(anime.key),
                cachedSettings().checkTimeoutSec * 1000,
                `checking ${anime.key}`
            )

            // A first successful check on a series that had none establishes the
            // baseline; announcing its whole back catalogue as "new" would be noise.
            const isBaseline = anime.episodes.length === 0
            if (newEpisodes.length > 0 && !isBaseline) {
                found++
                await notifyNewEpisodes(updated, newEpisodes)
            }

            await refreshTrackerIfStale(updated)
            await reschedule(updated)
        } catch (error) {
            logger.warn(`${anime.key}: check failed — ${error instanceof Error ? error.message : error}`)
            // refreshSeries already persisted failCount; re-read so the backoff
            // is computed from the new value.
            await reschedule(anime, { failed: true })
        }
    }

    return found
}

/** Persist the next slot. Always runs, or a failing series would never retry. */
async function reschedule(anime: TrackedAnime, options: { failed?: boolean } = {}) {
    const fresh = options.failed ? { ...anime, failCount: anime.failCount + 1 } : anime
    fresh.nextCheckAt = nextCheckAt(fresh, resolveSchedule(fresh))
    await putAnime(fresh)
}

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s ${what}`)), ms)
        promise.then(
            value => {
                clearTimeout(timer)
                resolve(value)
            },
            error => {
                clearTimeout(timer)
                reject(error)
            }
        )
    })
}

/** Tracker data ages: air times move, series finish. Twelve hours is plenty. */
const TRACKER_MAX_AGE_MS = 12 * 60 * 60 * 1000

/**
 * Piggyback tracker refresh on the check that just ran.
 *
 * A series on the `airing` policy needs current air times or its schedule
 * silently degrades to the fallback interval, and refreshing here means no extra
 * wake-ups and no separate rate-limit budget to reason about.
 */
async function refreshTrackerIfStale(anime: TrackedAnime): Promise<void> {
    const wanted =
        resolve("anilistMetadata", { anime, sourceId: anime.sourceId }) ||
        resolve("anilistSchedule", { anime, sourceId: anime.sourceId })
    if (!wanted) return
    if (Date.now() - (anime.trackerCheckedAt ?? 0) < TRACKER_MAX_AGE_MS) return

    try {
        await enrich(anime.key)
    } catch (error) {
        // Never let a tracker hiccup fail an episode check.
        logger.debug(`${anime.key}: tracker refresh skipped — ${error instanceof Error ? error.message : error}`)
    }
}
