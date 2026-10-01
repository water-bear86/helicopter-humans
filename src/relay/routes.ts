// The relay's fixed route table. Callers name a route and its parameters; they never supply a URL,
// host, port, scheme, query or header. Each route maps to one reviewed public HTTPS resource.
//
// Hacker News API (https://github.com/HackerNews/API): public, read-only, no key, no account. The
// operator chose it for the local demonstration because it is free, needs no credentials and returns
// small JSON documents. Adding a route is a code change that must be reviewed like this one.

export type RouteId = 'hn.item' | 'hn.topstories' | 'hn.maxitem'

export interface RouteMatch {
  id: RouteId
  // Fully built upstream URL. Never contains caller text other than validated parameters.
  target: URL
}

export interface Upstream {
  // Hostname only; never an IP literal, so every connection goes through the checked DNS lookup.
  host: string
  // Base path prefix, without trailing slash.
  basePath: string
}

export const HN_UPSTREAM: Upstream = Object.freeze({ host: 'hacker-news.firebaseio.com', basePath: '/v0' })

// Public path the relay serves -> upstream path. Item ids are decimal, no leading zero, at most 10 digits.
const PATTERNS: Array<{ id: RouteId; path: RegExp; upstream: (m: RegExpExecArray) => string }> = [
  { id: 'hn.item', path: /^\/v1\/hn\/item\/([1-9][0-9]{0,9})$/, upstream: (m) => `/item/${m[1]}.json` },
  { id: 'hn.topstories', path: /^\/v1\/hn\/topstories$/, upstream: () => '/topstories.json' },
  { id: 'hn.maxitem', path: /^\/v1\/hn\/maxitem$/, upstream: () => '/maxitem.json' },
]

export const ROUTE_IDS: readonly RouteId[] = PATTERNS.map((p) => p.id)

export type RouteRefusal = 'query_not_allowed' | 'route_not_found'

export interface RouteOptions {
  upstream: Upstream
  scheme: 'https:' | 'http:'
  port: number
}

export const PRODUCTION_ROUTE_OPTIONS: RouteOptions = Object.freeze({ upstream: HN_UPSTREAM, scheme: 'https:', port: 443 })

// `rawPath` is the request-target exactly as received (path plus optional query), not a parsed URL,
// so percent-encoding, dot segments and doubled slashes cannot be normalised into a match.
export function matchRoute(rawPath: string, options: RouteOptions = PRODUCTION_ROUTE_OPTIONS): RouteMatch | RouteRefusal {
  if (rawPath.includes('?') || rawPath.includes('#')) return 'query_not_allowed'
  for (const pattern of PATTERNS) {
    const m = pattern.path.exec(rawPath)
    if (!m) continue
    return { id: pattern.id, target: buildTarget(options, pattern.upstream(m)) }
  }
  return 'route_not_found'
}

function buildTarget(options: RouteOptions, path: string): URL {
  const { upstream, scheme, port } = options
  const url = new URL(`${scheme}//${upstream.host}${port === (scheme === 'https:' ? 443 : 80) ? '' : `:${port}`}${upstream.basePath}${path}`)
  // Defence in depth: the table above cannot produce any of these, and nothing else builds a target.
  if (url.username || url.password || url.search || url.hash || url.hostname !== upstream.host) throw new Error('relay target is malformed')
  return url
}
