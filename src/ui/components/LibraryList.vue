<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { onLibraryChanged, send } from "~/shared/messages"
import type { SourceDescriptor } from "~/shared/messages"
import type { Episode, SchedulePolicy, TrackedAnime } from "~/model/types"
import type { GlobalSettings } from "~/settings/schema"
import { resolve } from "~/settings/resolver"
import { loadSettings, loadSourceSettings } from "~/settings/storage"
import {
    episodeProgressKey,
    latestEpisode,
    latestEpisodeNumber,
    nextEpisode,
    positionDrift,
    titleOf,
    unwatchedCount,
    watchState
} from "~/model/keys"
import { relativeFuture, relativePast } from "~/shared/time"
import SchedulePicker from "./SchedulePicker.vue"
import SettingsDialog from "./SettingsDialog.vue"
import TrackerDialog from "./TrackerDialog.vue"
import RowMenu, { type MenuItem } from "./RowMenu.vue"
import ConfirmDialog from "./ConfirmDialog.vue"
import SearchPanel from "./SearchPanel.vue"
import DownloadsPanel from "./DownloadsPanel.vue"
import CategoryBar from "./CategoryBar.vue"
import {
    automaticCategoriesOf,
    categoriesOf,
    matchesCategories,
    offeredCategories,
    pruneFilter
} from "~/library/categories"
import type { Category, CategoryFilter } from "~/library/categories"
import { groupSeries, groupLatest, groupPosition, groupUnwatched, preferredEntry } from "~/library/grouping"
import type { SeriesGroup } from "~/library/grouping"

const props = withDefaults(defineProps<{ variant?: "popup" | "page" }>(), { variant: "popup" })

const library = ref<TrackedAnime[]>([])
const sources = ref<SourceDescriptor[]>([])
const loading = ref(true)
const error = ref<string | null>(null)
const notice = ref<string | null>(null)
const busy = ref(new Set<string>())

type Sort = GlobalSettings["listSort"]

/**
 * Text filter is deliberately *not* persisted: it is how you find one series
 * right now, and finding the list still filtered tomorrow reads as an empty
 * library. Everything else here is a preference and is stored.
 */
const filter = ref("")
const sort = ref<Sort>("recent")
const onlyUnwatched = ref(false)
const sourceFilter = ref("")
const categories = ref<Category[]>([])
/** Which built-ins have been offered, so deleting one stays deleted. */
const seededCategories = ref<string[]>([])
const categoryFilter = ref<CategoryFilter>({})
/** Which row's shelf editor is open, mirroring the episode picker. */
const categoriesFor = ref<string | null>(null)
/** False until settings have loaded, so restoring them doesn't look like a change. */
const controlsReady = ref(false)

const scheduleFor = ref<string | null>(null)
const trackingFor = ref<string | null>(null)
const episodesFor = ref<string | null>(null)

/**
 * The row panels the ⋯ menu opens, as one list.
 *
 * Named together so "is anything open for this row" and "close it" are one
 * statement each. Opening a panel from the menu and then having to reopen the
 * menu to close it again made setting one option a three-click round trip, and
 * every panel added another place to forget the close path.
 */
const ROW_PANELS = [episodesFor, categoriesFor, scheduleFor, trackingFor]

const panelOpen = (key: string) => ROW_PANELS.some(panel => panel.value === key)

function closePanels() {
    for (const panel of ROW_PANELS) panel.value = null
}
const showSettings = ref(false)
const showSearch = ref(false)
const showDownloads = ref(false)
/**
 * What clicking an episode tile does. Watching is what the panel is usually
 * open for, so downloading is a deliberate switch rather than a second grid.
 */
const pickerMode = ref<"watch" | "download">("watch")
/** Groups the viewer has opened. Collapsed is the default — the point is fewer rows. */
const expanded = ref(new Set<string>())
const grouping = ref(true)
const checking = ref(false)
const pendingRemoval = ref<TrackedAnime | null>(null)
const trackerFor = ref<TrackedAnime | null>(null)

const sourceName = (id: string) => sources.value.find(s => s.id === id)?.name ?? id

/** Sources that actually have something in the library — the rest are noise. */
const usedSources = computed(() => {
    const ids = new Set(library.value.map(a => a.sourceId))
    return sources.value.filter(source => ids.has(source.id))
})

const visible = computed(() => {
    const needle = filter.value.trim().toLowerCase()
    let list = library.value
    if (needle !== "") list = list.filter(a => titleOf(a).toLowerCase().includes(needle))
    if (onlyUnwatched.value) list = list.filter(a => watchState(a) === "new")
    if (sourceFilter.value !== "") list = list.filter(a => a.sourceId === sourceFilter.value)
    if (Object.keys(categoryFilter.value).length > 0) {
        list = list.filter(a => matchesCategories(membershipOf(a), categoryFilter.value))
    }

    const sorted = [...list]
    switch (sort.value) {
        case "title":
            return sorted.sort((a, b) => titleOf(a).localeCompare(titleOf(b)))
        case "unwatched":
            return sorted.sort((a, b) => unwatchedCount(b) - unwatchedCount(a))
        case "next-check":
            return sorted.sort((a, b) => a.nextCheckAt - b.nextCheckAt)
        case "added":
            return sorted.sort((a, b) => b.addedAt - a.addedAt)
        default:
            return sorted.sort((a, b) => b.lastEpisodeFoundAt - a.lastEpisodeFoundAt || b.addedAt - a.addedAt)
    }
})

/**
 * One row per show rather than per source.
 *
 * Sorting happens on entries first so the group order follows it — grouping
 * preserves the order it was handed, so a group sits where its best entry would
 * have.
 */
const groups = computed(() => groupSeries(visible.value, { enabled: grouping.value }))

const isExpanded = (id: string) => expanded.value.has(id)

function toggleGroup(id: string) {
    const next = new Set(expanded.value)
    if (!next.delete(id)) next.add(id)
    expanded.value = next
}

/** Which entries of a group to draw: all of them unless it is a collapsed group. */
function rowsOf(group: SeriesGroup<TrackedAnime>): TrackedAnime[] {
    if (group.entries.length === 1) return group.entries
    return isExpanded(group.id) ? group.entries : []
}

/**
 * What the group header's watch button does: open the next episode from
 * whichever source actually carries it.
 */
function groupWatch(group: SeriesGroup<TrackedAnime>): { label: string; url?: string; title: string } {
    const entry = preferredEntry(group)
    if (!entry) return { label: "No episodes", title: "No source returned any episodes yet" }

    const from = groupPosition(group)
    const next = [...entry.episodes]
        .filter(episode => from === null || episode.number > from)
        .sort((a, b) => a.number - b.number)[0]

    if (!next) {
        const latest = groupLatest(group)
        return { label: "Up to date", title: latest === null ? "Caught up" : `Caught up at episode ${latest}` }
    }
    return {
        label: from === null ? `Start at E${next.number}` : `Watch E${next.number}`,
        title: `On ${sourceName(entry.sourceId)}${from === null ? "" : ` — furthest watched is episode ${from}`}`,
        url: next.url
    }
}

/** Descending, so the newest episode is the first thing in the picker. */
function episodesOf(anime: TrackedAnime): Episode[] {
    return [...anime.episodes].sort((a, b) => b.number - a.number)
}

function episodeState(anime: TrackedAnime, episode: Episode): "watched" | "current" | "new" {
    if (anime.progress[episodeProgressKey(episode)]?.completed) return "watched"
    const from = anime.lastWatched?.number
    if (from === undefined) return "new"
    if (episode.number === from) return "current"
    return episode.number > from ? "new" : "watched"
}

/**
 * How much of a series this source carries, said so it cannot be misread.
 *
 * "121 ep" sitting next to "at E476" reads as a contradiction, and it is the
 * kind that makes you distrust the whole row. Both numbers are correct and they
 * are answers to different questions: myanime.live publishes episodes 356 to 476
 * of Wan Jie Du Zun and nothing earlier, so the count is 121 and the newest is
 * 476. A row showing only the count looks like it lost four hundred episodes.
 *
 * When the list really does run 1..n the two agree and the short form is used,
 * which is the common case and stays short.
 */
function episodeSpan(anime: TrackedAnime): { label: string; heading: string } {
    const newest = latestEpisodeNumber(anime)
    if (newest === null) return { label: "no episodes", heading: "No episodes" }

    const count = anime.episodes.length
    const earliest = anime.episodes.reduce((lo, ep) => Math.min(lo, ep.number), newest)

    if (count === newest && earliest === 1) return { label: `${count} ep`, heading: `${count} episodes` }

    return {
        label: `${count} ep, newest E${newest}`,
        heading: `${count} episodes, E${earliest} to E${newest}`
    }
}

/**
 * A watch pointer that has run off the end of the list, in words.
 *
 * Deliberately a statement plus a button rather than a repair: see
 * `positionDrift` for why nothing here resets anything on its own. Silence is
 * the failure this exists to prevent — a renumbered series reads as "Up to date"
 * forever, which looks exactly like being up to date.
 */
/**
 * The pointer sitting above everything the source lists.
 *
 * No tolerance any more: `pointerRollback` brings the pointer down on every
 * refresh, so a single episode of drift is already enough to act on and a
 * threshold would only delay saying so. This is now the residual surface — the
 * window between an imported backup and the next check — rather than the main
 * handling.
 */
function driftNote(a: TrackedAnime): string | null {
    if (positionDrift(a) === 0) return null
    return `You are at E${a.lastWatched?.number}, past everything this source lists (newest is E${latestEpisodeNumber(a)}).`
}

/** What a source claims about everything it carries, keyed by source id. */
const sourceClaims = computed(() => Object.fromEntries(sources.value.map(source => [source.id, source.categories])))

/**
 * Automatic membership is recomputed rather than stored, so a shelf whose rule
 * changes takes effect at once. Cheap enough to do per row: it is a handful of
 * string comparisons against data already in memory.
 */
function membershipOf(a: TrackedAnime): string[] {
    return categoriesOf(a, categories.value, sourceClaims.value)
}

/** Where the rules alone would file it — what the "auto" tag marks. */
function automaticIds(a: TrackedAnime): string[] {
    return automaticCategoriesOf(a, categories.value, sourceClaims.value)
}

/**
 * On or off one shelf, stated rather than toggled.
 *
 * The background decides what to store, because that depends on the shelf's
 * rule: taking a series off "Donghua" records an exclusion, taking it off a
 * shelf it was only put on by hand records nothing.
 */
async function setCategory(a: TrackedAnime, categoryId: string, on: boolean) {
    const updated = await send("library:shelve", { key: a.key, categoryId, on })
    if (updated) replaceRow(updated)
}

function toggleCategory(a: TrackedAnime, categoryId: string) {
    return setCategory(a, categoryId, !membershipOf(a).includes(categoryId))
}

/**
 * One series onto one shelf, from the shelf's own editor.
 *
 * Stated rather than toggled: the caller already knows which way it is going,
 * and a toggle over a list that is re-sorting under the click is how the wrong
 * row gets changed.
 */
async function assignCategory(event: { key: string; categoryId: string; on: boolean }) {
    const anime = library.value.find(candidate => candidate.key === event.key)
    if (!anime) return
    await setCategory(anime, event.categoryId, event.on)
}

async function saveCategories(next: Category[]) {
    // Recorded *before* the change: a shelf that was on screen has been offered,
    // so deleting it here must not be undone by the next start's seeding.
    const seeded = offeredCategories(seededCategories.value, categories.value)

    categories.value = next
    seededCategories.value = seeded
    // A filter pointing at a deleted shelf would silently hide everything.
    categoryFilter.value = pruneFilter(categoryFilter.value, next)
    await send("settings:patch", {
        patch: { categories: next, seededCategories: seeded, listCategoryFilter: categoryFilter.value }
    })
}

async function bulkCategory(event: { action: "add" | "remove"; categoryId: string }) {
    const keys = visible.value.map(a => a.key)
    const changed = await send("library:bulkCategory", { keys, categoryId: event.categoryId, action: event.action })
    const shelf = categories.value.find(category => category.id === event.categoryId)?.name ?? "that shelf"
    flash(
        changed === 0
            ? `Nothing to change on ${shelf}`
            : `${event.action === "add" ? "Added" : "Removed"} ${changed} series ${event.action === "add" ? "to" : "from"} ${shelf}`
    )
    await reload()
}

function replaceRow(updated: TrackedAnime) {
    library.value = library.value.map(a => (a.key === updated.key ? updated : a))
}

const newEpisodes = computed(() => library.value.reduce((n, a) => (a.follow ? n + unwatchedCount(a) : n), 0))
const seriesWithNew = computed(() => library.value.filter(a => watchState(a) === "new").length)

async function load() {
    loading.value = true
    error.value = null
    try {
        const [list, srcs] = await Promise.all([send("library:list", {}), send("sources:list", {})])
        library.value = list
        sources.value = srcs
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
    } finally {
        loading.value = false
    }
}

/** Quiet reload: no spinner, for refreshes the user did not ask for. */
async function reload() {
    try {
        library.value = await send("library:list", {})
    } catch {
        // A failed background refresh should leave what is on screen alone.
    }
}

/**
 * Restore the list controls, then keep them saved as they change.
 *
 * Also warms the settings cache in *this* context. The resolver reads it
 * synchronously, and the page is a consumer like any other: a row that decides
 * something per-anime has to go through `resolve` or the per-source and
 * per-anime overrides quietly stop applying here while still applying in the
 * background — which is worse than not having them.
 */
async function restoreControls() {
    try {
        await Promise.all([loadSettings(), loadSourceSettings()])
        const settings = await send("settings:get", {})
        sort.value = settings.listSort
        onlyUnwatched.value = settings.listOnlyUnwatched
        sourceFilter.value = settings.listSourceFilter
        categories.value = settings.categories ?? []
        seededCategories.value = settings.seededCategories ?? []
        categoryFilter.value = pruneFilter(settings.listCategoryFilter ?? {}, categories.value)
        grouping.value = settings.groupBySeries
    } catch {
        // Defaults are fine; this is a convenience, not state that matters.
    } finally {
        controlsReady.value = true
    }
}

watch([sort, onlyUnwatched, sourceFilter, grouping, categoryFilter], () => {
    if (!controlsReady.value) return
    void send("settings:patch", {
        patch: {
            listSort: sort.value,
            listOnlyUnwatched: onlyUnwatched.value,
            listSourceFilter: sourceFilter.value,
            listCategoryFilter: categoryFilter.value,
            groupBySeries: grouping.value
        }
    }).catch(() => undefined)
})

const isBusy = (key: string) => busy.value.has(key)

async function withBusy(key: string, fn: () => Promise<void>) {
    busy.value = new Set(busy.value).add(key)
    try {
        await fn()
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
    } finally {
        const done = new Set(busy.value)
        done.delete(key)
        busy.value = done
    }
}

function replace(updated: TrackedAnime | null) {
    if (updated) library.value = library.value.map(a => (a.key === updated.key ? updated : a))
}

function flash(message: string) {
    notice.value = message
    setTimeout(() => (notice.value = null), 6000)
}

// ---------------------------------------------------------------- actions

const refresh = (a: TrackedAnime) => withBusy(a.key, async () => replace(await send("library:refresh", { key: a.key })))

const toggleFollow = (a: TrackedAnime) =>
    withBusy(a.key, async () => replace(await send("library:setFlags", { key: a.key, follow: !a.follow })))

const togglePoll = (a: TrackedAnime) =>
    withBusy(a.key, async () => replace(await send("library:setFlags", { key: a.key, poll: !a.poll })))

const setSchedule = (a: TrackedAnime, schedule: SchedulePolicy) =>
    withBusy(a.key, async () => replace(await send("library:setSchedule", { key: a.key, schedule })))

/**
 * The boolean tracking settings a single series can disagree with.
 *
 * Listed rather than generated: every setting resolves through the three-level
 * chain, but only some are worth deciding *per show*, and a panel offering all
 * thirty would bury the one that matters. Verification is here as well as on the
 * source because posting ahead is as often a per-series habit as a per-site one —
 * one show on a site gets the early treatment and the rest do not.
 */
const TRACKING_OVERRIDES = [
    {
        key: "verifyNewEpisodes" as const,
        label: "Check a new episode is really out",
        help: "Opens the episode page once before announcing it. A page with only a countdown is announced later, when it goes live."
    },
    {
        key: "recoverStalledPlayback" as const,
        label: "Ride out a stream that stalls",
        help: "A stream that has been playing and then stumbles is reloaded where it stopped, a few times, before the next server is tried."
    }
] satisfies { key: keyof GlobalSettings & keyof TrackedAnime["overrides"]; label: string; help: string }[]

type TrackingKey = (typeof TRACKING_OVERRIDES)[number]["key"]

/** Whether this series says anything of its own, and what. */
const overrideState = (a: TrackedAnime, key: TrackingKey): "inherit" | "on" | "off" => {
    const own = a.overrides[key]
    return own === undefined ? "inherit" : own ? "on" : "off"
}

/**
 * What "Default" resolves to here — deliberately asked *without* the anime, so
 * it reports what would happen if this series stopped disagreeing rather than
 * echoing the override back.
 */
const inheritedValue = (a: TrackedAnime, key: TrackingKey) => resolve(key, { sourceId: a.sourceId })

const setOverride = (a: TrackedAnime, key: TrackingKey, state: "inherit" | "on" | "off") =>
    withBusy(a.key, async () =>
        replace(
            await send("library:setOverrides", {
                key: a.key,
                patch: { [key]: state === "inherit" ? null : state === "on" }
            })
        )
    )

const catchUp = (a: TrackedAnime) =>
    withBusy(a.key, async () => {
        const latest = latestEpisode(a)
        if (!latest) return
        replace(
            await send("library:markWatched", {
                key: a.key,
                number: latest.number,
                ...(latest.variant ? { variant: latest.variant } : {})
            })
        )
    })

/** Open one episode from the picker. */
function watchEpisode(a: TrackedAnime, number: number) {
    const episode = a.episodes.find(ep => ep.number === number)
    if (episode) open(episode.url)
}

/**
 * Move the pointer deliberately, in either direction.
 *
 * Distinct from opening an episode, which only ever moves forward — the two are
 * different intentions and conflating them is what made watching episode 157 of
 * a series you were caught up at 160 on look like losing your place.
 */
const setPosition = (a: TrackedAnime, number: number) =>
    withBusy(a.key, async () => {
        const episode = a.episodes.find(ep => ep.number === number)
        replace(
            await send("library:markWatched", {
                key: a.key,
                number,
                ...(episode?.variant ? { variant: episode.variant } : {}),
                force: true
            })
        )
        flash(`${titleOf(a)} — position set to episode ${number}`)
    })

const resetWatch = (a: TrackedAnime) =>
    withBusy(a.key, async () => {
        replace(await send("library:resetWatch", { key: a.key }))
        flash(`${titleOf(a)} is back to unstarted`)
    })

async function confirmRemoval() {
    const target = pendingRemoval.value
    pendingRemoval.value = null
    if (!target) return
    await withBusy(target.key, async () => {
        await send("library:remove", { key: target.key })
        library.value = library.value.filter(x => x.key !== target.key)
        flash(`Removed ${titleOf(target)}`)
    })
}

async function checkAll() {
    checking.value = true
    error.value = null
    try {
        const found = await send("library:checkAll", { force: true })
        flash(found === 0 ? "Checked everything — nothing new" : `${found} series updated`)
        await load()
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
    } finally {
        checking.value = false
    }
}

const open = (url: string) => void send("tab:open", { url })

/**
 * AMR's Debug item, which copies the manga object — with the piece AMR does not
 * need. A manga's behaviour is mostly in the manga; a series' behaviour is
 * decided three levels up (`resolve()`), so an entry pasted on its own cannot
 * explain why it never notified, or why the player was replaced, or why it is
 * checked every six hours. The report carries the resolved settings beside the
 * entry, and the build version, which is otherwise unanswerable from a paste.
 */
async function copyDebugReport(a: TrackedAnime) {
    let text: string
    try {
        text = JSON.stringify(await send("debug:report", { key: a.key }), null, 2)
    } catch (e) {
        error.value = e instanceof Error ? e.message : String(e)
        return
    }
    try {
        await navigator.clipboard.writeText(text)
        flash(`Debug report for ${titleOf(a)} copied — ${text.length.toLocaleString()} characters`)
    } catch {
        // The report exists and the clipboard refused it — which a popup makes
        // easy, since a write is denied the moment the page loses focus. Losing
        // the payload is the worst outcome available; the console is a poor
        // second place but it is a place.
        console.info(text)
        flash("The clipboard refused it — the report is in this page's console instead")
    }
}

/** The full library owns the search panel; the popup is too narrow for results. */
function openSearch() {
    if (props.variant !== "page") {
        void send("tab:openLibrary", {})
        return
    }
    showSearch.value = !showSearch.value
    if (showSearch.value) {
        showSettings.value = false
        window.scrollTo({ top: 0, behavior: "smooth" })
    }
}

/** Same rule as search and settings: the popup is too narrow, so it defers. */
function openDownloads() {
    if (props.variant !== "page") {
        void send("tab:openLibrary", {})
        return
    }
    showDownloads.value = !showDownloads.value
    if (showDownloads.value) {
        showSearch.value = false
        showSettings.value = false
        window.scrollTo({ top: 0, behavior: "smooth" })
    }
}

async function queueDownload(a: TrackedAnime, number: number) {
    await withBusy(a.key, async () => {
        const job = await send("downloads:add", { key: a.key, number, ...(episodeVariant(a, number) ?? {}) })
        flash(job ? `Queued ${titleOf(a)} E${number}` : `${titleOf(a)} E${number} is already queued`)
    })
}

/** The variant the list holds for that number, so sub and dub download apart. */
function episodeVariant(a: TrackedAnime, number: number): { variant: string } | null {
    const variant = a.episodes.find(episode => episode.number === number)?.variant
    return variant ? { variant } : null
}

function onAdded(anime: TrackedAnime) {
    // Insert rather than reload: a search result added while three sources are
    // still returning should not take the results away.
    if (!library.value.some(existing => existing.key === anime.key)) {
        library.value = [anime, ...library.value]
    }
    flash(`Following ${titleOf(anime)}`)
}

function openSettings() {
    if (props.variant !== "page") {
        void send("tab:openLibrary", {})
        return
    }
    showSettings.value = !showSettings.value
    // Settings are a modal now, so there is nothing to scroll to and nothing
    // underneath competing for the same screen — the search panel can stay as
    // the viewer left it.
    if (showSettings.value) showSearch.value = false
}

/** States the viewer needs to see even when they aren't acting on them. */
function stateTags(a: TrackedAnime): { label: string; tone: "warn" | "muted" }[] {
    const tags: { label: string; tone: "warn" | "muted" }[] = []
    if (!a.follow) tags.push({ label: "not followed", tone: "muted" })
    if (!a.poll) tags.push({ label: "not checking", tone: "muted" })
    if (a.overrides.schedule) tags.push({ label: "custom schedule", tone: "muted" })
    if (a.failCount > 0) tags.push({ label: `${a.failCount} failed check${a.failCount > 1 ? "s" : ""}`, tone: "warn" })
    if (a.airing) tags.push({ label: `ep ${a.airing.episode} ${relativeFuture(a.airing.at)}`, tone: "muted" })
    return tags
}

/**
 * Everything that isn't the one thing you came to do. Kept in a menu because a
 * row of six buttons stops being scannable the moment the library is real, and
 * destructive actions should not sit next to routine ones.
 */
function menuFor(a: TrackedAnime): MenuItem[] {
    return [
        { label: "Refresh episode list", action: () => void refresh(a) },
        {
            label: "Mark as caught up",
            disabled: watchState(a) !== "new",
            hint: "Move your position to the newest episode",
            action: () => void catchUp(a)
        },
        { label: "Following", checked: a.follow, separated: true, action: () => void toggleFollow(a) },
        { label: "Checking for new episodes", checked: a.poll, action: () => void togglePoll(a) },
        {
            label: "Episodes…",
            disabled: a.episodes.length === 0,
            hint: "Pick one to watch, or set where you are",
            action: () => (episodesFor.value = episodesFor.value === a.key ? null : a.key)
        },
        {
            label: "Shelves…",
            checked: (a.categories ?? []).length > 0,
            hint: "Which categories this sits on",
            action: () => (categoriesFor.value = categoriesFor.value === a.key ? null : a.key)
        },
        {
            label: "Schedule…",
            checked: Boolean(a.overrides.schedule),
            action: () => (scheduleFor.value = scheduleFor.value === a.key ? null : a.key)
        },
        {
            label: "Tracking…",
            checked: TRACKING_OVERRIDES.some(o => a.overrides[o.key] !== undefined),
            hint: "When this series counts as watched, and when a new episode is announced",
            action: () => (trackingFor.value = trackingFor.value === a.key ? null : a.key)
        },
        {
            label: a.anilistId ? "Change AniList match…" : "Match on AniList…",
            checked: Boolean(a.anilistId),
            separated: true,
            hint: a.anilistId ? undefined : "Poster, canonical title and air times",
            action: () => (trackerFor.value = a)
        },
        { label: "Open series page", action: () => open(a.url) },
        {
            label: "Copy debug report",
            hint: "The stored entry, plus every setting in force for it",
            action: () => void copyDebugReport(a)
        },
        {
            label: "Reset watch status",
            disabled: !a.lastWatched,
            hint: "Back to unstarted — keeps the series and its settings",
            action: () => void resetWatch(a)
        },
        { label: "Remove from library…", danger: true, separated: true, action: () => (pendingRemoval.value = a) }
    ]
}

function watchAction(a: TrackedAnime): { label: string; title: string; url?: string } {
    const state = watchState(a)
    if (state === "unstarted") return { label: "No episodes", title: "The source returned no episodes yet" }

    const next = nextEpisode(a)
    if (!next) {
        const latest = latestEpisode(a)
        return {
            label: "Up to date",
            title: latest ? `Caught up at episode ${latest.number}` : "Caught up",
            ...(latest ? { url: latest.url } : {})
        }
    }
    return {
        label: a.lastWatched ? `Watch E${next.number}` : `Start at E${next.number}`,
        title: a.lastWatched
            ? `Last watched episode ${a.lastWatched.number}`
            : "Never opened — this starts at the earliest episode",
        url: next.url
    }
}

/*
 * Anything can change the library while this is open: a series added by opening
 * an episode on a site, a scheduled check finding something, the player moving
 * the watch position. The background says so and the list re-reads itself —
 * without this, a library tab left open shows yesterday's state until reloaded
 * by hand.
 */
let unsubscribe: (() => void) | null = null

onMounted(async () => {
    if (props.variant === "page" && window.location.hash === "#settings") showSettings.value = true
    unsubscribe = onLibraryChanged(() => void reload())
    // A popup is destroyed and rebuilt constantly, so it always arrives fresh;
    // a long-lived tab can miss a broadcast while the worker was asleep.
    if (props.variant === "page") {
        document.addEventListener("visibilitychange", onVisible)
    }
    await Promise.all([load(), restoreControls()])
})

function onVisible() {
    if (document.visibilityState === "visible") void reload()
}

onBeforeUnmount(() => {
    unsubscribe?.()
    document.removeEventListener("visibilitychange", onVisible)
})

defineExpose({ load })
</script>

<template>
    <div class="library" :class="variant">
        <header>
            <div class="brand">
                <span class="mark" aria-hidden="true"></span>
                <h1>All Anime Watcher</h1>
            </div>
            <div class="head-meta">
                <span v-if="newEpisodes > 0" class="pill accent">{{ newEpisodes }} new in {{ seriesWithNew }}</span>
                <span class="pill">{{ library.length }} tracked</span>

                <button
                    class="btn icon"
                    :disabled="checking || library.length === 0"
                    :title="checking ? 'Checking…' : 'Check every series now'"
                    @click="checkAll"
                >
                    <span :class="{ spin: checking }">⟳</span>
                </button>
                <!--
                    The popup keeps two buttons, not six. Search, downloads and
                    settings all did the same thing there — open the full library
                    — which is what the ⤢ button says it does. Five buttons and
                    two pills in a 380px popup pushed the title out from under
                    itself for no gained ability.
                -->
                <template v-if="variant === 'page'">
                    <button
                        class="btn icon"
                        :class="{ primary: showSearch }"
                        title="Find a series to follow"
                        @click="openSearch"
                    >
                        ⌕
                    </button>
                    <button
                        class="btn icon"
                        :class="{ primary: showDownloads }"
                        title="Downloads"
                        @click="openDownloads"
                    >
                        ⇩
                    </button>
                    <button class="btn icon" :class="{ primary: showSettings }" title="Settings" @click="openSettings">
                        ⚙
                    </button>
                </template>
                <button
                    v-else
                    class="btn icon"
                    title="Open the full library — search, downloads and settings live there"
                    @click="send('tab:openLibrary', {})"
                >
                    ⤢
                </button>
            </div>
        </header>

        <SearchPanel
            v-if="showSearch && variant === 'page'"
            :library="library"
            :sources="sources"
            @added="onAdded"
            @close="showSearch = false"
        />

        <DownloadsPanel v-if="showDownloads && variant === 'page'" @close="showDownloads = false" />

        <SettingsDialog v-if="showSettings && variant === 'page'" @close="showSettings = false" />

        <CategoryBar
            v-if="variant === 'page' && library.length > 0"
            :library="library"
            :shown="visible"
            :categories="categories"
            :filter="categoryFilter"
            :sources="sources"
            @update:filter="value => (categoryFilter = value)"
            @update:categories="saveCategories"
            @bulk="bulkCategory"
            @assign="assignCategory"
        />

        <div v-if="library.length > 1" class="controls-row">
            <input v-model="filter" type="search" placeholder="Filter by title" aria-label="Filter by title" />
            <select v-if="usedSources.length > 1" v-model="sourceFilter" aria-label="Filter by source">
                <option value="">All sources</option>
                <option v-for="source in usedSources" :key="source.id" :value="source.id">{{ source.name }}</option>
            </select>
            <select v-model="sort" aria-label="Sort by">
                <option value="recent">Newest episode</option>
                <option value="title">Title</option>
                <option value="unwatched">Most unwatched</option>
                <option value="next-check">Next check</option>
                <option value="added">Recently added</option>
            </select>
            <button
                class="btn"
                :class="{ primary: onlyUnwatched }"
                title="Show only series with something new"
                @click="onlyUnwatched = !onlyUnwatched"
            >
                Unwatched
            </button>
        </div>

        <p v-if="error" class="banner error">{{ error }}</p>
        <p v-if="notice" class="banner subtle">{{ notice }}</p>
        <p v-if="loading" class="banner">Loading…</p>

        <div v-else-if="library.length === 0" class="empty">
            <p class="empty-title">Nothing tracked yet</p>
            <p>
                Open an episode on a supported site and it gets added automatically. Right now that means
                <template v-for="(s, i) in sources" :key="s.id"
                    ><a href="#" @click.prevent="open(s.home)">{{ s.name }}</a
                    ><span v-if="i < sources.length - 1">, </span></template
                >.
            </p>
        </div>

        <ul v-else class="list">
            <template v-for="group in groups" :key="group.id">
                <li v-if="group.entries.length > 1" class="row group" :data-open="isExpanded(group.id)">
                    <span class="stripe" aria-hidden="true"></span>

                    <div class="poster">
                        <img v-if="group.poster" :src="group.poster" alt="" loading="lazy" />
                    </div>

                    <div class="body">
                        <div class="title-row">
                            <button class="title" :title="group.title" @click="toggleGroup(group.id)">
                                {{ group.title }}
                            </button>
                            <span v-if="groupUnwatched(group) > 0" class="pill accent tight">
                                +{{ groupUnwatched(group) }}
                            </span>
                        </div>

                        <div class="meta">
                            <span>{{ group.entries.map(e => sourceName(e.sourceId)).join(" · ") }}</span>
                            <span class="sep">·</span>
                            <span v-if="groupLatest(group) !== null">newest E{{ groupLatest(group) }}</span>
                            <span class="sep">·</span>
                            <span v-if="groupPosition(group) !== null">at E{{ groupPosition(group) }}</span>
                            <span v-else class="faint">not started</span>
                        </div>

                        <div class="actions">
                            <button
                                class="btn"
                                :class="{ primary: groupUnwatched(group) > 0 }"
                                :disabled="!groupWatch(group).url"
                                :title="groupWatch(group).title"
                                @click="open(groupWatch(group).url!)"
                            >
                                {{ groupWatch(group).label }}
                            </button>
                            <span class="grow"></span>
                            <button class="btn expander" @click="toggleGroup(group.id)">
                                {{ isExpanded(group.id) ? "Hide" : "Show" }} {{ group.entries.length }} sources
                                <span class="caret">{{ isExpanded(group.id) ? "▴" : "▾" }}</span>
                            </button>
                        </div>
                    </div>
                </li>

                <li
                    v-for="a in rowsOf(group)"
                    :key="a.key"
                    class="row"
                    :class="{ nested: group.entries.length > 1 }"
                    :data-state="watchState(a)"
                >
                    <span class="stripe" aria-hidden="true"></span>

                    <div class="poster">
                        <img v-if="a.poster" :src="a.poster" alt="" loading="lazy" />
                    </div>

                    <div class="body">
                        <div class="title-row">
                            <button class="title" :title="titleOf(a)" @click="open(a.url)">{{ titleOf(a) }}</button>
                            <span v-if="watchState(a) === 'new'" class="pill accent tight"
                                >+{{ unwatchedCount(a) }}</span
                            >
                        </div>

                        <div class="meta">
                            <span>{{ sourceName(a.sourceId) }}</span>
                            <span class="sep">·</span>
                            <span>{{ episodeSpan(a).label }}</span>
                            <span class="sep">·</span>
                            <span v-if="a.lastWatched">at E{{ a.lastWatched.number }}</span>
                            <span v-else class="faint">not started</span>
                            <span class="sep">·</span>
                            <span :title="a.lastCheckedAt ? new Date(a.lastCheckedAt).toLocaleString() : ''">
                                checked {{ relativePast(a.lastCheckedAt) }}
                            </span>
                            <span class="sep">·</span>
                            <span :title="a.nextCheckAt ? new Date(a.nextCheckAt).toLocaleString() : ''">
                                next {{ relativeFuture(a.nextCheckAt) }}
                            </span>
                        </div>

                        <div v-if="stateTags(a).length > 0" class="tags">
                            <span v-for="tag in stateTags(a)" :key="tag.label" class="tag" :class="tag.tone">
                                {{ tag.label }}
                            </span>
                        </div>

                        <p v-if="a.lastError" class="row-error" :title="a.lastError">Last check failed</p>

                        <p v-if="driftNote(a)" class="row-note">
                            {{ driftNote(a) }}
                            <button class="link" @click="episodesFor = episodesFor === a.key ? null : a.key">
                                Set position
                            </button>
                        </p>

                        <div class="actions">
                            <button
                                class="btn"
                                :class="{ primary: watchState(a) === 'new' }"
                                :disabled="isBusy(a.key) || !watchAction(a).url"
                                :title="watchAction(a).title"
                                @click="open(watchAction(a).url!)"
                            >
                                {{ watchAction(a).label }}
                            </button>
                            <span v-if="isBusy(a.key)" class="working">working…</span>
                            <span class="grow"></span>
                            <button
                                v-if="panelOpen(a.key)"
                                class="icon-btn"
                                title="Close this panel"
                                aria-label="Close this panel"
                                @click="closePanels()"
                            >
                                ✕
                            </button>
                            <RowMenu :items="menuFor(a)" :label="`Actions for ${titleOf(a)}`" />
                        </div>

                        <div v-if="episodesFor === a.key" class="episodes-panel">
                            <div class="panel-head">
                                <span class="panel-title">{{ episodeSpan(a).heading }}</span>
                                <div class="modes">
                                    <button
                                        class="btn tiny"
                                        :class="{ primary: pickerMode === 'watch' }"
                                        @click="pickerMode = 'watch'"
                                    >
                                        Watch
                                    </button>
                                    <button
                                        class="btn tiny"
                                        :class="{ primary: pickerMode === 'download' }"
                                        @click="pickerMode = 'download'"
                                    >
                                        Download
                                    </button>
                                </div>
                                <button class="btn tiny" @click="episodesFor = null">Close</button>
                            </div>
                            <div class="episode-grid">
                                <button
                                    v-for="ep in episodesOf(a)"
                                    :key="`${ep.number}-${ep.variant ?? ''}`"
                                    class="ep"
                                    :data-state="episodeState(a, ep)"
                                    :title="`${ep.title ?? `Episode ${ep.number}`}${ep.variant ? ` · ${ep.variant}` : ''} — click to ${pickerMode}`"
                                    @click="
                                        pickerMode === 'download'
                                            ? queueDownload(a, ep.number)
                                            : watchEpisode(a, ep.number)
                                    "
                                >
                                    {{ ep.number }}
                                </button>
                            </div>
                            <label class="set-position">
                                <span>I'm at episode</span>
                                <select
                                    :value="a.lastWatched?.number ?? ''"
                                    @change="setPosition(a, Number(($event.target as HTMLSelectElement).value))"
                                >
                                    <option value="" disabled>not started</option>
                                    <option v-for="ep in episodesOf(a)" :key="ep.number" :value="ep.number">
                                        Episode {{ ep.number }}
                                    </option>
                                </select>
                            </label>
                        </div>

                        <div v-if="categoriesFor === a.key" class="episodes-panel">
                            <div class="panel-head">
                                <span class="panel-title">Shelves</span>
                                <button class="btn tiny" @click="categoriesFor = null">Close</button>
                            </div>

                            <div v-if="categories.length > 0" class="shelf-picks">
                                <label v-for="category in categories" :key="category.id" class="shelf-pick">
                                    <input
                                        type="checkbox"
                                        :checked="membershipOf(a).includes(category.id)"
                                        @change="toggleCategory(a, category.id)"
                                    />
                                    <span>{{ category.name }}</span>
                                    <span v-if="automaticIds(a).includes(category.id)" class="shelf-auto">auto</span>
                                </label>
                            </div>
                            <p v-else class="shelf-note">No shelves yet — make one under “Shelves…” above the list.</p>

                            <p class="shelf-note">
                                “auto” means a rule already files it there — usually what AniList says. Ticking or
                                unticking overrules the rule, which is how a series it has never heard of gets on the
                                right shelf.
                            </p>
                        </div>

                        <div v-if="trackingFor === a.key" class="tracking">
                            <div v-for="option in TRACKING_OVERRIDES" :key="option.key" class="tracking-row">
                                <div class="tracking-text">
                                    <span class="tracking-label">{{ option.label }}</span>
                                    <span class="tracking-help">{{ option.help }}</span>
                                </div>
                                <div class="tracking-choice">
                                    <button
                                        v-for="choice in ['inherit', 'on', 'off'] as const"
                                        :key="choice"
                                        class="btn tiny"
                                        :class="{ on: overrideState(a, option.key) === choice }"
                                        :disabled="busy.has(a.key)"
                                        @click="setOverride(a, option.key, choice)"
                                    >
                                        {{
                                            choice === "inherit"
                                                ? `Default (${inheritedValue(a, option.key) ? "on" : "off"})`
                                                : choice === "on"
                                                  ? "On"
                                                  : "Off"
                                        }}
                                    </button>
                                </div>
                            </div>
                            <p class="tracking-note">
                                “Default” follows this source, and then the global setting. Set it for the whole site
                                under Sources, or for everything under Settings.
                            </p>
                        </div>

                        <div v-if="scheduleFor === a.key" class="schedule">
                            <SchedulePicker
                                allow-inherit
                                inherited-label="global default"
                                :model-value="a.overrides.schedule ?? { mode: 'inherit' }"
                                @update:model-value="value => setSchedule(a, value)"
                            />
                        </div>
                    </div>
                </li>
            </template>
        </ul>

        <TrackerDialog
            :anime="trackerFor"
            @close="trackerFor = null"
            @updated="
                value => {
                    replace(value)
                    trackerFor = null
                }
            "
        />

        <ConfirmDialog
            :open="pendingRemoval !== null"
            danger
            confirm-label="Remove"
            :title="`Remove ${pendingRemoval ? titleOf(pendingRemoval) : ''}?`"
            body="This forgets the series, your position in it, and its watch history. Opening an episode again will re-add it from scratch."
            @cancel="pendingRemoval = null"
            @confirm="confirmRemoval"
        />
    </div>
</template>

<style scoped>
.library {
    display: flex;
    flex-direction: column;
}

.library.popup {
    width: 440px;
    max-height: 580px;
    overflow-y: auto;
}

.library.page {
    max-width: 900px;
    margin: 0 auto;
    min-height: 100vh;
}

header {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--gap);
    padding: 12px 14px;
    background: var(--surface);
    border-bottom: 1px solid var(--rule);
}

.page header {
    padding: 18px 16px;
}

.brand {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}

.mark {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: var(--accent);
    flex: 0 0 auto;
}

h1 {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
    /* Truncate rather than overflow: without this the title ran on underneath
       the toolbar instead of giving way to it. */
    overflow: hidden;
    text-overflow: ellipsis;
}

.page h1 {
    font-size: 17px;
}

.head-meta {
    display: flex;
    align-items: center;
    gap: 5px;
    /* Never squeezed: the title gives way instead, because a clipped title is
       still readable and a clipped button row is not usable. */
    flex: 0 0 auto;
}

.pill {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.03em;
    padding: 2px 6px;
    border-radius: 3px;
    background: var(--surface-2);
    color: var(--ink-3);
    white-space: nowrap;
}

.pill.accent {
    background: var(--accent-soft);
    color: var(--accent-ink);
    font-weight: 700;
}

.spin {
    display: inline-block;
    animation: spin 1s linear infinite;
}

@keyframes spin {
    to {
        transform: rotate(360deg);
    }
}

@media (prefers-reduced-motion: reduce) {
    .spin {
        animation: none;
    }
}

.controls-row {
    display: flex;
    gap: 6px;
    padding: 10px 14px 0;
}

.controls-row input {
    flex: 1 1 auto;
    min-width: 0;
    padding: 6px 9px;
    font: inherit;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

.controls-row select {
    font: inherit;
    font-size: 12px;
    color: var(--ink-2);
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    padding: 0 4px;
}

.controls-row .btn {
    font-size: 11px;
}

.banner {
    margin: 12px 14px;
    color: var(--ink-3);
}

.banner.error {
    color: var(--danger);
    background: var(--danger-soft);
    padding: 8px 10px;
    border-radius: var(--radius);
}

.banner.subtle {
    margin: 10px 14px 0;
    font-size: 11px;
    color: var(--accent-ink);
}

.empty {
    padding: 28px 20px;
    color: var(--ink-2);
}

.empty-title {
    margin: 0 0 6px;
    font-weight: 600;
    color: var(--ink);
}

.empty p {
    margin: 0 0 8px;
}

.list {
    list-style: none;
    margin: 0;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
}

.row {
    position: relative;
    display: grid;
    grid-template-columns: 46px minmax(0, 1fr);
    gap: 10px;
    padding: 10px 10px 10px 13px;
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    box-shadow: var(--shadow);
}

.stripe {
    position: absolute;
    inset: 0 auto 0 0;
    width: 3px;
    border-radius: var(--radius) 0 0 var(--radius);
}

/*
 * The three states have to be separable at a glance across a long list, and a
 * 3px stripe in two shades of blue-green was not: "has new episodes" and "caught
 * up" read as the same row. So they differ in more than hue — the one that wants
 * attention is green, wider and tinted; the one that wants none is quiet.
 */
.row[data-state="new"] {
    background: var(--state-new-soft);
    border-color: var(--state-new-rule);
}

.row[data-state="new"] .stripe {
    background: var(--state-new);
    width: 4px;
}

.row[data-state="current"] .stripe {
    background: var(--state-current);
    opacity: 0.55;
}

.row[data-state="unstarted"] .stripe {
    background: var(--state-warn);
}

/*
 * Muted by colour rather than `opacity`.
 *
 * Any opacity below 1 creates a stacking context, which trapped the row menu's
 * dropdown inside the row: its z-index stopped competing with the rows below it,
 * so on an unfollowed series the menu opened *behind* every following row and
 * could not be clicked. Nothing else on the row was affected, which is why it
 * looked like a bug about following rather than a bug about opacity.
 */
.row[data-state="paused"] {
    border-style: dashed;
}

.row[data-state="paused"] .title,
.row[data-state="paused"] .meta,
.row[data-state="paused"] .tags {
    color: var(--ink-3);
}

/* A leaf element: its stacking context contains nothing that needs to escape. */
.row[data-state="paused"] .poster {
    opacity: 0.5;
}

.row[data-state="paused"] .stripe {
    background: var(--ink-3);
}

/*
 * A group header is a row that stands for several. It reads as one thing with
 * the sources tucked under it, rather than as a heading floating above unrelated
 * rows — which is what an unindented list of the same entries looked like.
 */
.row.group[data-open="true"] {
    border-bottom-left-radius: 0;
    border-bottom-right-radius: 0;
}

.row.nested {
    margin-left: 22px;
    box-shadow: none;
}

.expander {
    font-size: 10px;
    color: var(--ink-3);
}

.caret {
    margin-left: 3px;
}

.episodes-panel {
    margin-top: 8px;
    padding: 10px;
    background: var(--ground);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

.panel-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 8px;
}

.panel-title {
    font-size: 11px;
    color: var(--ink-3);
}

.btn.tiny {
    font-size: 10px;
    padding: 2px 6px;
}

.episode-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-height: 168px;
    overflow-y: auto;
}

.ep {
    font-family: var(--mono);
    font-size: 11px;
    min-width: 34px;
    padding: 3px 5px;
    border: 1px solid var(--rule);
    border-radius: 4px;
    background: var(--surface);
    color: var(--ink-2);
    cursor: pointer;
}

.ep:hover {
    border-color: var(--accent);
    color: var(--accent-ink);
}

.ep[data-state="watched"] {
    color: var(--ink-3);
    opacity: 0.6;
}

.ep[data-state="current"] {
    border-color: var(--state-current);
    color: var(--ink);
    font-weight: 700;
}

.ep[data-state="new"] {
    border-color: var(--state-new-rule);
    color: var(--ink);
}

.set-position {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 10px;
    padding-top: 8px;
    border-top: 1px solid var(--rule);
    font-size: 11px;
    color: var(--ink-3);
}

.set-position select {
    font: inherit;
    font-size: 11px;
    color: var(--ink);
    background: var(--surface);
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 2px 4px;
}

.poster {
    width: 46px;
    height: 62px;
    border-radius: 4px;
    overflow: hidden;
    background: var(--surface-2);
}

.page .poster {
    width: 60px;
    height: 82px;
}

.page .row {
    grid-template-columns: 60px minmax(0, 1fr);
}

.poster img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
}

.body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.title-row {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
}

.title {
    font-weight: 600;
    text-align: left;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
}

.page .title {
    font-size: 14px;
}

.title:hover {
    color: var(--accent-ink);
}

.meta {
    font-size: 11px;
    color: var(--ink-3);
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.sep {
    opacity: 0.5;
}

.faint {
    font-style: italic;
}

.tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}

.tag {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--surface-2);
    color: var(--ink-3);
}

.tag.warn {
    color: var(--state-warn);
}

.row-error {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--danger);
}

.shelf-picks {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 14px;
}

.shelf-pick {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--ink-2);
    cursor: pointer;
}

.shelf-auto {
    font-size: 10px;
    color: var(--ink-3);
    opacity: 0.75;
}

.shelf-note {
    margin: 6px 0 0;
    font-size: 11px;
    color: var(--ink-3);
}

.panel-head .modes {
    display: flex;
    gap: 4px;
    margin-left: auto;
    margin-right: 8px;
}

.row-note {
    margin: 2px 0 0;
    font-size: 11px;
    color: var(--state-warn);
}

.row-note .link {
    font: inherit;
    color: inherit;
    background: none;
    border: 0;
    padding: 0;
    text-decoration: underline;
    cursor: pointer;
}

.actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 4px;
}

.actions .btn {
    font-size: 11px;
    padding: 3px 8px;
}

.grow {
    flex: 1 1 auto;
}

.working {
    font-size: 10px;
    color: var(--ink-3);
}

.schedule {
    margin-top: 8px;
    padding: 10px;
    background: var(--ground);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

/*
 * Sits beside the ⋯ and only while a panel is open, so the row's resting state
 * is unchanged — one action button and one menu, as before.
 */
.icon-btn {
    flex: none;
    padding: 2px 7px;
    font-size: 12px;
    line-height: 1.4;
    color: var(--ink-3);
    background: none;
    border: 1px solid var(--rule);
    border-radius: var(--radius);
    cursor: pointer;
}

.icon-btn:hover {
    color: var(--ink);
    border-color: var(--ink-3);
}

.tracking {
    margin-top: 8px;
    padding: 10px;
    background: var(--ground);
    border: 1px solid var(--rule);
    border-radius: var(--radius);
}

.tracking-row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 6px 0;
}

.tracking-row + .tracking-row {
    border-top: 1px solid var(--rule);
}

.tracking-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}

.tracking-label {
    font-size: 12px;
}

.tracking-help {
    font-size: 11px;
    color: var(--ink-3);
}

.tracking-choice {
    display: flex;
    gap: 4px;
    flex: none;
}

/*
 * The selected state has to carry more than colour — the three buttons read as
 * one control and "which one is active" is the only thing it says.
 */
.tracking-choice .btn.on {
    border-color: var(--accent, currentColor);
    font-weight: 600;
}

.tracking-note {
    margin: 6px 0 0;
    font-size: 11px;
    color: var(--ink-3);
}
</style>
