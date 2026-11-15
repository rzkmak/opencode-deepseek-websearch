import { Effect, Layer } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { createServer } from "node:http"
import { search, toSearchResults, queryValidationError, normalizeQuery } from "./api.js"
import { TtlCache } from "./cache.js"

let attempts = 0
const server = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    attempts++
    const parsed = JSON.parse(body)
    console.log(`[mock] attempt ${attempts}:`, parsed)
    if (!req.headers.authorization?.startsWith("Bearer test-key")) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "bad key" }))
      return
    }
    if (attempts <= 2) {
      // Two transient failures first: one 429, then a 500.
      res.writeHead(attempts === 1 ? 429 : 500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: "slow down" }))
      return
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        results: [
          {
            url: "https://example.com/a",
            title: "Example A",
            summary: "Long model-facing summary for A.",
            snippet: "Short snippet A",
            content: "FULL PAGE CONTENT A".repeat(500),
            rerank_score: 2.4,
            authority: 3,
            site_name: "Example",
            date: "2026-01-15T00:00:00Z",
          },
          {
            url: "https://example.com/b",
            title: "",
            summary: "",
            snippet: "Short snippet B",
            rerank_score: 0.4,
            authority: -1,
            site_name: null,
            date: null,
          },
          { url: "https://example.com/a", title: "Duplicate", summary: "dupe", snippet: "dupe" },
          {
            url: "https://example.com/c",
            title: "Filtered C",
            summary: "low quality",
            snippet: "low",
            rerank_score: 0.2,
          },
        ],
      }),
    )
  })
})

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
const address = server.address(); const port = typeof address === "object" && address ? address.port : 0

const http = Effect.runSync(Effect.provide(HttpClient.HttpClient, FetchHttpClient.layer))

const program = Effect.gen(function* () {
  // Validation
  console.log("validation empty:", queryValidationError("   ")?.message)
  console.log("validation long:", queryValidationError("x".repeat(129))?.message)
  console.log("validation ok:", queryValidationError("  hello   world  ") === undefined)
  console.log("normalized:", normalizeQuery("  a\n\t b  "))

  const config = {
    baseUrl: `http://127.0.0.1:${port}`,
    timeoutSeconds: 5,
    retries: 3,
    userAgent: "test-agent",
  }
  const call = {
    query: "effect retry",
    count: 8,
    needContent: true,
    localization: "",
    apiKey: "test-key",
  }

  const items = yield* search(http, config, call)
  console.log("raw items:", items.length, "attempts used:", attempts)

  const results = toSearchResults(items, {
    needContent: true,
    enrichContent: true,
    contentMaxLength: 200,
    minScore: 0.5,
    minAuthority: -1,
  })
  console.log("mapped results:", JSON.stringify(results, (k, v) => (k === "content" ? v.slice(0, 80) + `…(${v.length} chars)` : v), 2))

  // minAuthority filter
  const strict = toSearchResults(items, { needContent: true, enrichContent: true, contentMaxLength: 0, minScore: 0, minAuthority: 3 })
  console.log("strict filter count:", strict.length)

  // Cache
  const cache = new TtlCache(8)
  cache.set("k", items, 60)
  console.log("cache hit:", cache.get("k") === items, "cache miss:", cache.get("other") === undefined)
}).pipe(Effect.provide(FetchHttpClient.layer))

await Effect.runPromise(program).then(
  () => console.log("SMOKE_OK"),
  (e) => {
    console.error("SMOKE_FAIL", e)
    process.exit(1)
  },
)
server.close()
