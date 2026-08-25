import browser from "webextension-polyfill"
import { on } from "../router"
import { withChecksPaused } from "../scheduler"
import { libraryChanged } from "../broadcast"
import { refreshBadge } from "../badge"
import { buildBackup, planImport, readBackup, serializeBackup, type BackupParts } from "~/model/backup"
import { clearAll, getAllAnime, getAllSourceState, putManyAnime, putSourceState } from "~/model/db"
import { invalidateSettingsCache, loadSettings, loadSourceSettings } from "~/settings/storage"
import { log } from "~/shared/logger"

const logger = log("backup")

/**
 * Reading and writing the whole library.
 *
 * All the judgement lives in `~/model/backup`, which is pure; this file only
 * moves bytes between that and the two places state actually lives (IndexedDB
 * and storage.local). The split is what makes "does a backup round-trip
 * losslessly" a question `npm run check:backup` can answer.
 */
export function registerBackupHandlers() {
    on("backup:export", async () => {
        const parts = await currentState()
        const text = serializeBackup(
            buildBackup(parts, {
                exportedAt: Date.now(),
                appVersion: browser.runtime.getManifest().version
            })
        )

        logger.info(
            `exported ${parts.anime.length} series and ${parts.sourceState.length} source states ` +
                `(${Math.round(text.length / 1024)} KB)`
        )
        return { filename: filenameFor(new Date()), text }
    })

    on("backup:import", async ({ text, mode, settings, dryRun }) => {
        const backup = readBackup(text)
        const local = await currentState()
        const plan = planImport(local, backup, { mode, settings })

        const described =
            `${plan.summary.added} new, ${plan.summary.updated} updated, ` +
            `${plan.summary.unchanged} unchanged, ${plan.summary.localOnly} only here`

        if (dryRun) {
            logger.info(`import preview (${mode}): ${described}`)
            return {
                ...plan.summary,
                mode,
                exportedAt: backup.exportedAt,
                ...(backup.appVersion ? { appVersion: backup.appVersion } : {}),
                applied: false
            }
        }

        await withChecksPaused("import", async () => {
            // Replace means the library *becomes* the file, so the old rows have
            // to go rather than being written over — an entry the backup does not
            // contain would otherwise survive a "restore".
            if (plan.mode === "replace") await clearAll()

            await putManyAnime(plan.anime)
            for (const state of plan.sourceState) await putSourceState(state)

            if (plan.settings) await browser.storage.local.set({ settings: plan.settings })
            if (plan.sourceSettings) await browser.storage.local.set({ sourceSettings: plan.sourceSettings })
            // storage.onChanged repopulates the cache from newValue, but this
            // worker wrote it, and Chrome does not deliver the event to the
            // context that caused it. Without this the background would keep
            // running on the settings it had before the import. (Rule 10.)
            if (plan.settings || plan.sourceSettings) {
                invalidateSettingsCache()
                await Promise.all([loadSettings(), loadSourceSettings()])
            }
        })

        await refreshBadge()
        libraryChanged("import")
        logger.info(`imported (${mode}): ${described}`)

        return {
            ...plan.summary,
            mode,
            exportedAt: backup.exportedAt,
            ...(backup.appVersion ? { appVersion: backup.appVersion } : {}),
            applied: true
        }
    })
}

async function currentState(): Promise<BackupParts> {
    const [anime, sourceState, settings, sourceSettings] = await Promise.all([
        getAllAnime(),
        getAllSourceState(),
        loadSettings(),
        loadSourceSettings()
    ])
    return { anime, sourceState, settings, sourceSettings }
}

/** Sorts chronologically in a file listing, which is how backups get compared. */
function filenameFor(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0")
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    return `all-anime-watcher-${stamp}.json`
}
