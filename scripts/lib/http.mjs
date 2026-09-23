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

async function request(url, { timeoutMs, token, useFetch }) {
  if (useFetch) {
    const res = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'application/vnd.github+json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
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
  const proxy = proxyUrl()
  if (proxy) args.push('-x', proxy)
  if (token) args.push('-H', `authorization: Bearer ${token}`)
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
      const data = JSON.parse(text)
      if (data && typeof data === 'object' && typeof data.message === 'string' &&
          /rate limit|Bad credentials|Not Found/i.test(data.message)) {
        throw new Error(data.message)
      }
      return { ok: true, data, attempts: attempt }
    } catch (err) {
      last = err?.message || String(err)
      if (attempt < tries) await sleep(Math.min(8000, 400 * 2 ** attempt))
    }
  }
  return { ok: false, error: last, attempts: tries }
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
