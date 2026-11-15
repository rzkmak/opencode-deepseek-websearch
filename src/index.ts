import type { Plugin } from "@opencode/plugin/effect/plugin"
import { Effect, type Scope } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { TtlCache } from "./cache.js"
import {
  normalizeQuery,
  queryValidationError,
  search,
  toSearchResults,
  type SearchItem,
} from "./api.js"
import { describeOptions, parseOptions } from "./options.js"

const PLUGIN_ID = "deepseek-websearch"
const PROVIDER_ID = "deepseek"
const PROVIDER_NAME = "DeepSeek"

/**
 * DeepSeek search provider for OpenCode v2's `websearch` tool.
 *
 * Features:
 * - Configurable via plugin options (count, needContent, timeout, retries, filters, proxy, …)
 * - Automatic retries with exponential backoff + jitter on transient failures
 * - TTL cache so identical repeat queries don't hit the API again
 * - Uses DeepSeek's richer fields (site name, authority, rerank score, full page content)
 * - Whitespace-normalized queries with clear validation errors
 * - Debug/info logging for every search
 *
 * Built against the OpenCode 2.0.32 plugin API. OpenCode v1 is not supported.
 */
const plugin: Plugin<Scope.Scope> = {
  id: PLUGIN_ID,
  effect: (ctx) =>
    Effect.gen(function* () {
      const options = parseOptions(ctx.options)
      const cache = new TtlCache<readonly SearchItem[]>(options.cacheMaxEntries)
      const http = yield* HttpClient.HttpClient
      const userAgent = `${ctx.app.name}/${ctx.app.version} (${ctx.app.channel}) ${PLUGIN_ID}`

      yield* Effect.logInfo("deepseek-websearch: plugin loaded", {
        version: ctx.app.version,
        options: describeOptions(options),
      })

      // OpenCode's DeepSeek model provider uses this integration ID too, so a
      // key connected for models also serves search.
      yield* ctx.integration.transform((editor) => {
        editor.update(PROVIDER_ID, (integration) => (integration.name = PROVIDER_NAME))
        editor.method.update({ integrationID: PROVIDER_ID, method: { type: "key" } })
        editor.method.update({
          integrationID: PROVIDER_ID,
          method: { type: "env", names: ["DEEPSEEK_API_KEY"] },
        })
      })

      const resolveApiKey = Effect.gen(function* () {
        if (options.apiKey) return options.apiKey
        const connection = yield* ctx.integration.connection.active(PROVIDER_ID)
        if (!connection) return undefined
        const credential = yield* ctx.integration.connection.resolve(connection)
        if (credential?.type !== "key" || !credential.key) return undefined
        return credential.key
      })

      const runSearch = (rawQuery: string) =>
        Effect.gen(function* () {
          const query = normalizeQuery(rawQuery)
          const validationError = queryValidationError(query)
          if (validationError) return yield* Effect.fail(validationError)

          const apiKey = yield* resolveApiKey
          if (!apiKey) {
            return yield* Effect.fail(
              new Error(
                "DeepSeek API key is not configured. Run `opencode auth login deepseek` (or /connect in the TUI), or set the plugin's `apiKey` option.",
              ),
            )
          }

          const cacheKey = JSON.stringify({
            query,
            count: options.count,
            needContent: options.needContent,
            localization: options.localization,
          })
          const cached = cache.get(cacheKey)
          if (cached) {
            yield* Effect.logDebug("deepseek-websearch: cache hit", { query })
            return toSearchResults(cached, options)
          }

          const startedAt = Date.now()
          const items = yield* search(http, {
            baseUrl: options.baseUrl,
            timeoutSeconds: options.timeoutSeconds,
            retries: options.retries,
            userAgent,
          }, {
            query,
            count: options.count,
            needContent: options.needContent,
            localization: options.localization,
            apiKey,
          })
          const elapsedMs = Date.now() - startedAt

          cache.set(cacheKey, items, options.cacheTtlSeconds)
          yield* Effect.logInfo("deepseek-websearch: search completed", {
            query,
            count: items.length,
            elapsedMs,
            cached: false,
          })
          return toSearchResults(items, options)
        })

      yield* ctx.websearch.transform((editor) => {
        editor.add({
          id: PROVIDER_ID,
          name: PROVIDER_NAME,
          execute: (input) => runSearch(input.query),
        })
      })
    }).pipe(Effect.provide(FetchHttpClient.layer)),
}

export default plugin
