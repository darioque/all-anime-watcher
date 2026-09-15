import type {
    FragmentLoaderContext,
    HlsConfig,
    Loader,
    LoaderCallbacks,
    LoaderConfiguration,
    LoaderContext
} from "hls.js"
import { unwrapSegment } from "~/shared/segments"

type FragmentLoader = Loader<FragmentLoaderContext>
type FragmentLoaderClass = new (config: HlsConfig) => FragmentLoader
/**
 * What hls.js hands out as `loader`: typed over the base context, and used by
 * hls.js itself for fragments regardless — `fLoader` merely narrows the type.
 */
type AnyLoaderClass = new (config: HlsConfig) => Loader<LoaderContext>

/**
 * A fragment loader that hands hls.js the video inside a segment that arrived
 * as an image.
 *
 * Wraps whichever loader is actually fetching — hls.js's own, or the background
 * proxy — rather than being one, so the decision about *how* to fetch stays
 * where it is (`fetchVia`) and this only sees bytes on their way out. Only
 * `onSuccess` is touched: with `progressive` off, which it is, a fragment is
 * delivered whole there. The rest of the loader contract is forwarded as-is.
 *
 * `unwrapSegment` is a no-op on a segment that is not wrapped, so this is
 * installed for every stream rather than declared per host — a source has no
 * way of knowing which CDN a file will come from until the bytes arrive.
 */
export function unwrapping(Base: AnyLoaderClass): FragmentLoaderClass {
    return class UnwrappingLoader implements FragmentLoader {
        private readonly inner: FragmentLoader

        constructor(config: HlsConfig) {
            this.inner = new Base(config) as FragmentLoader
        }

        get context(): FragmentLoaderContext | null {
            return this.inner.context
        }

        get stats() {
            return this.inner.stats
        }

        load(
            context: FragmentLoaderContext,
            config: LoaderConfiguration,
            callbacks: LoaderCallbacks<FragmentLoaderContext>
        ): void {
            this.inner.load(context, config, {
                ...callbacks,
                onSuccess: (response, stats, ctx, network) => {
                    const data = response.data instanceof ArrayBuffer ? unwrapSegment(response.data) : response.data
                    callbacks.onSuccess({ ...response, data }, stats, ctx, network)
                }
            })
        }

        abort(): void {
            this.inner.abort()
        }

        destroy(): void {
            this.inner.destroy()
        }

        getCacheAge(): number | null {
            return this.inner.getCacheAge?.() ?? null
        }

        getResponseHeader(name: string): string | null {
            return this.inner.getResponseHeader?.(name) ?? null
        }
    }
}
