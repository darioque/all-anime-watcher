import { on } from "../router"
import { loadSettings, patchSettings } from "~/settings/storage"
import { setLogLevel } from "~/shared/logger"

export function registerSettingsHandlers() {
    on("settings:get", async () => loadSettings())

    on("settings:patch", async ({ patch }) => {
        const settings = await patchSettings(patch)
        if (patch.logLevel) setLogLevel(patch.logLevel)
        return settings
    })
}
