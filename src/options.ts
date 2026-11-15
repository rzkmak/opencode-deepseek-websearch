/**
 * Plugin options with validation and safe defaults.
 *
 * Options come from the object form of the plugin entry in `opencode.json(c)`:
 *
 * ```jsonc
 * {
 *   "plugins": [
 *     {
 *       "package": "github:you/opencode-deepseek-websearch#v0.2.0",
 *       "options": {
 *         "count": 10,
 *         "needContent": true,
 *         "retries": 3
 *       }
 *     }
 *   ]
 * }
 * ```
 */

export interface DeepseekOptions {
  /** Results per search. DeepSeek allows 1–50. */
  readonly count: number
  /** Ask DeepSeek for full page content (`need_content`). Costs more, returns richer `content`. */
  readonly needContent: boolean
  /** Truncate each result's content to this many characters. `0` disables truncation. */
  readonly contentMaxLength: number
  /** Per-request timeout in seconds. */
  readonly timeoutSeconds: number
  /** Retries for transient failures (network errors, 408/425/429, 5xx, timeouts). */
  readonly retries: number
  /** Prepend site name, publish date, and authority hints to each result's content. */
  readonly enrichContent: boolean
  /** Drop results with a rerank score below this (0–3 scale). `0` keeps everything. */
  readonly minScore: number
  /** Drop results with an authority tier below this (-1 unknown, 0–4, 3+ highly authoritative). */
  readonly minAuthority: number
  /** IP address passed to DeepSeek to localize results. Empty string disables it. */
  readonly localization: string
  /** Explicit API key. Falls back to OpenCode's `deepseek` integration when unset. */
  readonly apiKey: string | undefined
  /** Search endpoint. Override to route through a compatible proxy. */
  readonly baseUrl: string
  /** In-memory cache TTL in seconds for identical queries. `0` disables the cache. */
  readonly cacheTtlSeconds: number
  /** Maximum number of cached queries. */
  readonly cacheMaxEntries: number
}

const DEFAULTS: DeepseekOptions = {
  count: 8,
  needContent: false,
  contentMaxLength: 8000,
  timeoutSeconds: 25,
  retries: 2,
  enrichContent: true,
  minScore: 0,
  minAuthority: -1,
  localization: "",
  apiKey: undefined,
  baseUrl: "https://api.deepseek.com/v1/tools/search",
  cacheTtlSeconds: 300,
  cacheMaxEntries: 256,
}

function numberOption(
  raw: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const value = raw[key]
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

function booleanOption(raw: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = raw[key]
  return typeof value === "boolean" ? value : fallback
}

function stringOption(raw: Record<string, unknown>, key: string, fallback: string): string {
  const value = raw[key]
  return typeof value === "string" ? value.trim() : fallback
}

/** Parse and clamp plugin options; unknown or invalid values fall back to defaults. */
export function parseOptions(raw: unknown): DeepseekOptions {
  const source = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
  const apiKey = stringOption(source, "apiKey", "")
  const localization = stringOption(source, "localization", DEFAULTS.localization)
  const baseUrl = stringOption(source, "baseUrl", DEFAULTS.baseUrl).replace(/\/+$/, "")
  return {
    count: numberOption(source, "count", 1, 50, DEFAULTS.count),
    needContent: booleanOption(source, "needContent", DEFAULTS.needContent),
    contentMaxLength: numberOption(source, "contentMaxLength", 0, 200_000, DEFAULTS.contentMaxLength),
    timeoutSeconds: numberOption(source, "timeoutSeconds", 5, 120, DEFAULTS.timeoutSeconds),
    retries: numberOption(source, "retries", 0, 5, DEFAULTS.retries),
    enrichContent: booleanOption(source, "enrichContent", DEFAULTS.enrichContent),
    minScore: numberOption(source, "minScore", 0, 3, DEFAULTS.minScore),
    minAuthority: numberOption(source, "minAuthority", -1, 4, DEFAULTS.minAuthority),
    localization,
    apiKey: apiKey || undefined,
    baseUrl: baseUrl || DEFAULTS.baseUrl,
    cacheTtlSeconds: numberOption(source, "cacheTtlSeconds", 0, 3600, DEFAULTS.cacheTtlSeconds),
    cacheMaxEntries: numberOption(source, "cacheMaxEntries", 0, 4096, DEFAULTS.cacheMaxEntries),
  }
}

/** Options safe to log: redacts the API key. */
export function describeOptions(options: DeepseekOptions): Record<string, unknown> {
  const { apiKey, ...rest } = options
  return { ...rest, apiKey: apiKey ? "***" : undefined }
}
