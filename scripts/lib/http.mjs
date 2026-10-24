// HTTP layer for the PinAtlas sync.
//
// Transport is curl by default: Node's global fetch ignores $HTTPS_PROXY, and this job has to
// run both on a proxied workstation (where direct connections to GitHub time out) and on a
// plain CI runner. curl honours the proxy env vars, so it is the default; `--fetch` switches
// to global fetch for environments without curl.
//
// Every request is retried with exponential backoff and JSON-validated before use: measured on
// this pipeline, ~24% of parallel CDN fetches fail silently without retries, and ~1% still fail
// after three attempts. A failed fetch must never be mistaken for "no data".
//
// File downloads go through fetchJsonAny: CDN first, then raw.githubusercontent.com. jsDelivr
// caps gh packages at 50 MB and stm32-data-generated outgrew it (2026-10, ~326 MB), so any file
// missing from its edge cache comes back as a plain-text "Package size exceeded" page instead
// of JSON. raw.githubusercontent.com serves per-file with no package cap and heals those.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const UA = 'pinatlas-data-sync/0.1 (+https://github.com/Lab0x-Embedded/pinatlas-data)'

export const proxyUrl = () =>
  process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy || ''

export const githubToken = () =>
  process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Credentials only go to GitHub hosts — never to the CDN, which is public content anyway.
const isGithubHost = (url) => /^[^/]*\/\/[^/]*\.github\.com\//.test(url) || /^[^/]*\/\/github\.com\//.test(url)
const authHeaders = (url, token) =>
  token && isGithubHost(url) ? { authorization: `Bearer ${token}` } : {}

async function request(url, { timeoutMs, token, useFetch, failOnHttpError }) {
  if (useFetch) {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'application/vnd.github+json',
        ...authHeaders(url, token)
      },
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  }

  const args = [
    '-sSL', '--max-time', String(Math.max(5, Math.round(timeoutMs / 1000))),
    '-H', `user-agent: ${UA}`,
    '-H', 'accept: application/vnd.github+json'
  ]
  if (failOnHttpError) args.push('-f')
  const proxy = proxyUrl()
  if (proxy) args.push('-x', proxy)
  const auth = authHeaders(url, token)
  if (auth.authorization) args.push('-H', `authorization: ${auth.authorization}`)
  args.push(url)

  const { stdout } = await run('curl', args, { maxBuffer: 256 * 1024 * 1024 })
  return stdout
}

/** GET → parsed JSON, with retries. Never throws; returns {ok,data} or {ok:false,error}. */
export async function fetchJson(url, { tries = 4, timeoutMs = 60000, token = '', useFetch = false } = {}) {
  let last = 'unknown error'
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const text = await request(url, { timeoutMs, token, useFetch })
      if (!text || !text.trim()) throw new Error('empty response')
      let data
      try {
        data = JSON.parse(text)
      } catch {
        const err = new Error(`non-JSON response: "${text.replace(/\s+/g, ' ').slice(0, 90).trim()}"`)
        // A CDN refusing the whole package (jsDelivr's 50 MB gh cap) is deterministic —
        // retrying the same URL can only burn the backoff budget.
        err.noRetry = /package size exceeded|exceeds the maximum/i.test(text)
        throw err
      }
      if (data && typeof data === 'object' && typeof data.message === 'string' &&
          /rate limit|Bad credentials|Not Found/i.test(data.message)) {
        throw new Error(data.message)
      }
      return { ok: true, data, attempts: attempt }
    } catch (err) {
      last = err?.message || String(err)
      if (err?.noRetry) break
      if (attempt < tries) await sleep(Math.min(8000, 400 * 2 ** attempt))
    }
  }
  return { ok: false, error: last, attempts: tries }
}

const hostOf = (url) => url.split('/')[2]

/** GET → raw text with retries (C headers, CSVs). Same never-throws contract as fetchJson. */
export async function fetchText(url, { tries = 4, timeoutMs = 60000, token = '', useFetch = false } = {}) {
  let last = 'unknown error'
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const text = await request(url, { timeoutMs, token, useFetch, failOnHttpError: true })
      if (!text || !text.trim()) throw new Error('empty response')
      return { ok: true, data: text, attempts: attempt }
    } catch (err) {
      last = err?.message || String(err)
      // A missing file on a pinned ref is deterministic — retrying just burns the backoff.
      if (/error: 40[45]/.test(last)) break
      if (attempt < tries) await sleep(Math.min(8000, 400 * 2 ** attempt))
    }
  }
  return { ok: false, error: last, attempts: tries }
}

/**
 * GET → parsed JSON, trying candidate URLs in order (CDN first, raw.githubusercontent.com as
 * the authoritative fallback). Non-final URLs get at most 2 tries each: their failures skew
 * deterministic, and the last URL carries the full retry budget.
 */
export async function fetchJsonAny(urls, { tries = 4, ...rest } = {}) {
  if (!urls.length) return { ok: false, error: 'no candidate URLs', attempts: 0 }
  const errors = []
  let attempts = 0
  for (const [i, url] of urls.entries()) {
    const res = await fetchJson(url, { ...rest, tries: i === urls.length - 1 ? tries : Math.min(2, tries) })
    attempts += res.attempts
    if (res.ok) return { ok: true, data: res.data, attempts }
    errors.push(`${hostOf(url)}: ${res.error}`)
  }
  return { ok: false, error: errors.join(' | '), attempts }
}

/** Resolve a branch to its commit sha; falls back to the branch name when the API is unreachable. */
export async function resolveRef(repo, branch, opts = {}) {
  const res = await fetchJson(
    `https://api.github.com/repos/${repo}/commits/${branch}`,
    { tries: 3, ...opts }
  )
  if (res.ok && res.data?.sha) return { ref: res.data.sha, resolved: true, date: res.data?.commit?.committer?.date || null }
  return { ref: branch, resolved: false, date: null, error: res.error }
}

/** Latest stable release tag (e.g. esp-idf vX.Y.Z) — pinned instead of a branch so jsDelivr-style
 *  cache drift and mid-refactor upstream changes can never split a build. */
export async function resolveLatestTag(repo, opts = {}) {
  const res = await fetchJson(
    `https://api.github.com/repos/${repo}/releases/latest`,
    { tries: 3, ...opts }
  )
  if (res.ok && res.data?.tag_name) {
    return { ref: res.data.tag_name, resolved: true, date: res.data?.published_at || null }
  }
  return { ref: null, resolved: false, date: null, error: res.error || 'no releases' }
}

/** Full recursive file listing for a commit: [{path, size}] (blobs only, optionally filtered). */
export async function listFiles(repo, ref, { prefix = '', opts = {} } = {}) {
  const res = await fetchJson(
    `https://api.github.com/repos/${repo}/git/trees/${ref}?recursive=1`,
    { tries: 3, ...opts }
  )
  if (!res.ok) return { ok: false, files: [], error: res.error, truncated: false }
  const files = (res.data.tree || [])
    .filter((t) => t.type === 'blob' && t.path.startsWith(prefix) && t.path.endsWith('.json'))
    .map((t) => ({ path: t.path, size: t.size || 0 }))
  return { ok: true, files, truncated: Boolean(res.data.truncated), error: null }
}

/** Bounded-concurrency map. Errors are returned, never thrown. */
export async function mapPool(items, limit, worker) {
  const out = new Array(items.length)
  let next = 0
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      try {
        out[i] = { ok: true, value: await worker(items[i], i) }
      } catch (err) {
        out[i] = { ok: false, error: err?.message || String(err), item: items[i] }
      }
    }
  })
  await Promise.all(runners)
  return out
}
