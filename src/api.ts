import { Duration, Effect, Result, Schema } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http"

// Wire contract: https://api-docs.deepseek.com/api/search/
export const SearchRequest = Schema.Struct({
  query: Schema.String,
  count: Schema.Number,
  need_content: Schema.Boolean,
  localization: Schema.String,
})

export const SearchResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      url: Schema.String,
      // Fields beyond `url` are optional so a shape change on DeepSeek's side
      // degrades gracefully instead of failing the whole search.
      title: Schema.optional(Schema.String),
      snippet: Schema.optional(Schema.String),
      summary: Schema.optional(Schema.String),
      content: Schema.optional(Schema.String),
      rerank_score: Schema.optional(Schema.Number),
      authority: Schema.optional(Schema.Number),
      site_name: Schema.optional(Schema.NullOr(Schema.String)),
      date: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
})

export type SearchItem = typeof SearchResponse.Type["results"][number]

/** OpenCode websearch result shape (WebSearch.Result). */
export interface SearchResult {
  readonly url: string
  readonly title?: string
  readonly content?: string
  readonly time: { readonly published?: number }
}

export interface SearchCall {
  readonly query: string
  readonly count: number
  readonly needContent: boolean
  readonly localization: string
  readonly apiKey: string
}

export interface SearchRequestConfig {
  readonly baseUrl: string
  readonly timeoutSeconds: number
  readonly retries: number
  readonly userAgent: string
}

const QUERY_MAX_CHARS = 128

/** Collapse whitespace and trim. Returns an empty string when nothing remains. */
export function normalizeQuery(raw: string): string {
  return raw.replace(/\s+/gu, " ").trim()
}

/** DeepSeek accepts 1–128 Unicode characters. */
export function queryCharCount(query: string): number {
  return Array.from(query).length
}

export function queryValidationError(raw: string): Error | undefined {
  const query = normalizeQuery(raw)
  if (!query) {
    return new RangeError("DeepSeek search query must not be empty")
  }
  const chars = queryCharCount(query)
  if (chars > QUERY_MAX_CHARS) {
    return new RangeError(
      `DeepSeek search query must contain 1–${QUERY_MAX_CHARS} Unicode characters (received ${chars}). Shorten the query and try again.`,
    )
  }
  return undefined
}

/** Best-effort HTTP status from a typed failure, without importing Effect's concrete error classes. */
export function statusOf(error: unknown): number | undefined {
  const e = error as { response?: { status?: unknown }; reason?: { response?: { status?: unknown } } }
  const direct = e?.response?.status
  if (typeof direct === "number") return direct
  const nested = e?.reason?.response?.status
  if (typeof nested === "number") return nested
  return undefined
}

function reasonTag(error: unknown): string | undefined {
  const e = error as { _tag?: unknown; reason?: { _tag?: unknown } }
  if (typeof e?.reason?._tag === "string") return e.reason._tag
  if (typeof e?._tag === "string") return e._tag
  return undefined
}

/**
 * Transient failures worth retrying: transport/request errors, timeouts,
 * 408/425/429, and any 5xx. Auth and bad-request errors fail fast so the
 * caller sees the real problem immediately.
 */
export function isTransient(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const tag = reasonTag(error)
  if (tag === "TransportError" || tag === "EncodeError" || tag === "InvalidUrlError") return true
  const status = statusOf(error)
  if (typeof status === "number") {
    return status === 408 || status === 425 || status === 429 || status >= 500
  }
  const message = error.message.toLowerCase()
  return message.includes("timed out") || message.includes("timeout")
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Backoff with jitter, capped at 8 seconds. */
function retryDelayMs(attempt: number): number {
  const base = Math.min(8000, 500 * 2 ** (attempt - 1))
  return Math.round(base * (0.75 + Math.random() * 0.5))
}

/**
 * Run one search request, retrying transient failures with exponential
 * backoff. Non-transient errors and exhausted retries surface the original
 * native error untouched, so OpenCode's random-provider mode can still apply
 * its own handling (e.g. 429 cooldowns).
 */
export function search(
  http: HttpClient.HttpClient,
  config: SearchRequestConfig,
  call: SearchCall,
): Effect.Effect<readonly SearchItem[], unknown> {
  const executeOnce = (attempt: number) =>
    Effect.gen(function* () {
      const request = yield* HttpClientRequest.post(config.baseUrl).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeaders({
          Authorization: `Bearer ${call.apiKey}`,
          "User-Agent": config.userAgent,
          "X-Request-Attempt": String(attempt),
        }),
        HttpClientRequest.schemaBodyJson(SearchRequest)({
          query: call.query,
          count: call.count,
          need_content: call.needContent,
          localization: call.localization,
        }),
      )
      // Keep native HttpClientError values intact for OpenCode's provider handling.
      return yield* HttpClient.withScope(HttpClient.filterStatusOk(http))
        .execute(request)
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(SearchResponse)),
          Effect.scoped,
          Effect.timeoutOrElse({
            duration: Duration.seconds(config.timeoutSeconds),
            orElse: () =>
              Effect.fail(
                new Error(
                  `DeepSeek web search request timed out after ${config.timeoutSeconds}s`,
                ),
              ),
          }),
        )
    })

  return Effect.gen(function* () {
    for (let attempt = 1; ; attempt++) {
      const outcome = yield* Effect.result(executeOnce(attempt))
      if (Result.isSuccess(outcome)) return outcome.success.results
      const error = outcome.failure
      if (attempt > config.retries || !isTransient(error)) {
        return yield* Effect.fail(error)
      }
      const delayMs = retryDelayMs(attempt)
      yield* Effect.logWarning("deepseek-websearch: transient failure, retrying", {
        attempt,
        retriesLeft: config.retries - attempt + 1,
        delayMs,
        status: statusOf(error),
        message: errorMessage(error),
      })
      yield* Effect.sleep(Duration.millis(delayMs))
    }
  })
}

/**
 * Map DeepSeek items to OpenCode results.
 *
 * - `content` prefers the full page content when requested, then the
 *   model-facing summary, then the display snippet.
 * - When `enrichContent` is on, a short prefix with site name, publish date,
 *   and authority hints is prepended so the model can weigh the source.
 * - `contentMaxLength` truncates oversized content with an explicit marker.
 * - Duplicates by URL and below-threshold results are dropped.
 */
export function toSearchResults(
  items: readonly SearchItem[],
  options: {
    needContent: boolean
    enrichContent: boolean
    contentMaxLength: number
    minScore: number
    minAuthority: number
  },
): SearchResult[] {
  const results: SearchResult[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (!item.url || seen.has(item.url)) continue
    seen.add(item.url)
    if (typeof item.rerank_score === "number" && item.rerank_score < options.minScore) continue
    if (typeof item.authority === "number" && item.authority < options.minAuthority) continue

    let content = options.needContent
      ? item.content?.trim() || item.summary?.trim() || item.snippet?.trim() || ""
      : item.summary?.trim() || item.snippet?.trim() || ""
    if (options.enrichContent) content = enrichContent(item, content)
    if (options.contentMaxLength > 0 && content.length > options.contentMaxLength) {
      content = `${content.slice(0, options.contentMaxLength).trimEnd()} …[truncated]`
    }

    const published = item.date ? Date.parse(item.date) : Number.NaN
    results.push({
      url: item.url,
      ...(item.title ? { title: item.title } : {}),
      ...(content ? { content } : {}),
      time: Number.isFinite(published) ? { published } : {},
    })
  }
  return results
}

function enrichContent(item: SearchItem, body: string): string {
  const bits: string[] = []
  if (item.site_name) bits.push(item.site_name)
  const published = item.date ? new Date(item.date) : undefined
  if (published && !Number.isNaN(published.getTime())) {
    bits.push(published.toISOString().slice(0, 10))
  }
  if (typeof item.authority === "number" && item.authority >= 3) bits.push("authoritative source")
  if (bits.length === 0) return body
  const prefix = `[${bits.join(" • ")}]`
  return body ? `${prefix} ${body}` : prefix
}
