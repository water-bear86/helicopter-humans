# Agent relay (local prototype)

The relay is a small HTTP service that agents can call. It fetches a fixed set of public resources on the agent's behalf, so the upstream sees the relay's connection and the relay's own headers, not the agent's. It is a **local prototype**: it binds to `127.0.0.1` only and refuses to start on any hosted deployment. No deployment serves it, and `GET /api/status` reports it as `relay.mode: "unavailable"`.

It is independent of the browser redactor. The redactor stays local-only and never calls the relay or any `/api/` route.

## Privacy boundary

These statements are also returned by `GET /v1/status` (`src/relay/readiness.ts`, `PRIVACY_BOUNDARY`).

- The upstream sees a connection from the relay host's IP address, not the caller's.
- The relay builds its outgoing headers from scratch. It does not forward the caller's cookies, authorization, forwarded-for or real-IP headers, referrer, user-agent, tracking or trace identifiers.
- The operator and the host of the relay can observe traffic to and from it, including request paths and upstream responses. This is not anonymity from the operator or the host, and it does not hide agent content from them.
- What an agent asks for can itself identify it. Request content is not anonymised.
- The relay does not make a public x402 payment private and does not perform a Zcash swap.
- The relay code does not log request paths, credentials or upstream bodies. That says nothing about the host's own logs.

## Run it

```sh
npm ci
npm run relay                           # builds .tools-build/ and listens on http://127.0.0.1:8749
node examples/relay/agent.mjs 8863      # in another terminal
sh examples/relay/curl.sh
```

On first start the relay writes a random local token (`hhl_` + 32 random bytes) to `.relay-local/token` with mode 0600, and prints the file path, not the token. `RELAY_LOCAL_TOKEN` overrides it for scripted use. `RELAY_PORT` changes the port and `RELAY_TOKEN_FILE` changes the token path. Stop it with Ctrl-C.

## Upstream

Hacker News API, `https://hacker-news.firebaseio.com/v0/` (https://github.com/HackerNews/API, MIT). It is public and read-only, needs no key or account, and its README says "There is currently no rate limit". It states no User-Agent requirement. A missing item returns HTTP 200 with the body `null`. The relay still caps its own load on it (see Limits). Adding or changing an upstream is a reviewed code change in `src/relay/routes.ts`, never configuration.

## Request contract

`GET` only, with no body and no query string. The credential goes in `Authorization: Bearer <token>`, never in the URL.

| Route | Upstream | Route id |
| --- | --- | --- |
| `GET /v1/hn/item/{id}` (`id`: 1 to 10 digits, no leading zero) | `/v0/item/{id}.json` | `hn.item` |
| `GET /v1/hn/topstories` | `/v0/topstories.json` | `hn.topstories` |
| `GET /v1/hn/maxitem` | `/v0/maxitem.json` | `hn.maxitem` |
| `GET /v1/status` (no credential) | none | none |

The path is matched as received. Percent-encoding, dot segments, doubled or trailing slashes, a query, a fragment or any other path returns 400 or 404. Callers never supply a URL, host, port or header.

## Response contract

**Success** is HTTP 200 with the upstream JSON body byte for byte. It carries exactly these headers:

- `content-type: application/json; charset=utf-8`
- `cache-control: no-store`
- `referrer-policy: no-referrer`
- `x-content-type-options: nosniff`
- `hh-relay-mode: local-prototype`
- `hh-relay-route: <route id>`

No upstream header is copied, including `set-cookie`.

**Failure** is JSON `{"error": "<code>"}`. Upstream failures also include `route` and, where known, `upstreamStatus`.

| HTTP | `error` | Meaning |
| --- | --- | --- |
| 400 | `query_not_allowed` | Query or fragment present |
| 400 | `body_not_allowed` | Request had a body |
| 401 | `credential_required` | No bearer credential |
| 403 | `credential_rejected` | Not the relay token. Recovery codes, invoice ids, memo codes and txids are refused by shape |
| 403 | `browser_request_refused` | `Origin` present, or `Sec-Fetch-Site` other than `none` |
| 403 | `host_refused` | `Host` is not loopback (DNS rebinding) |
| 404 | `route_not_found` | Not in the route table |
| 405 | `method_not_allowed` | Not `GET` |
| 429 | `rate_limited`, `relay_busy` | Token bucket empty, or concurrency cap reached |
| 502 | `destination_refused` | DNS answered a non-public address, or the connected peer was not public |
| 502 | `dns_failed`, `connect_failed` | Upstream not reachable |
| 502 | `upstream_redirect_refused`, `upstream_status`, `upstream_content_type`, `upstream_encoding`, `upstream_too_large`, `upstream_malformed` | Upstream answered outside the contract |
| 504 | `upstream_timeout` | No full answer within the deadline |
| 503 | `relay_unavailable` | Hosted or unconfigured runtime |

## SSRF and isolation controls (`src/relay/upstream.ts`, `destination.ts`)

- **Fixed targets.** The URL comes from the route table. Defence-in-depth checks refuse any target with userinfo, a query, a fragment, a non-443 port, a scheme other than HTTPS, or an IP-literal host.
- **Address check at connect time.** The check runs inside the socket's own DNS lookup, so the address that passed is the address used, and it runs again on every request with no caching. The request is refused if any answer is not globally routable unicast. Refused ranges include RFC 1918, loopback, link-local and cloud metadata, CGNAT, documentation, benchmarking, multicast, reserved, IPv4-mapped/NAT64, 6to4, Teredo, ULA and all IPv6 outside `2000::/3`. The connected peer address is checked again.
- **No redirects, retries or proxies.** Redirects are never followed. There is one attempt with no retry. No proxy variables are read.
- **Outgoing headers.** Exactly `accept: application/json`, `accept-encoding: identity`, `user-agent: helicopter-humans-relay/0.1`, `connection: close` and `host`.
- **Limits.** 5 s total deadline, 256 KiB response cap on raw bytes (compressed responses refused), `application/json` only, and a body that must parse as JSON. 4 concurrent upstream calls. Local token bucket: 5-call burst, 30 calls per minute. Server header timeout 5 s, request timeout 10 s.
- **No logging.** One startup line. Nothing is written per request.

## Access and credit contract (`src/relay/access.ts`)

```ts
interface RelayAccessGate {
  readonly kind: 'unavailable' | 'local-prototype' | 'credit'
  reserve(credential: string | undefined, route: RouteId, units: number): Promise<AccessDecision>
  settle(reservation: Reservation, outcome: 'consumed' | 'released'): Promise<void>
}
```

- **Order of checks.** The handler refuses everything it can without the network first. It then reserves one unit, contacts the upstream once, and settles exactly once.
- **Settling.** `consumed` means the upstream was contacted, whether it answered or failed. `released` means the call was refused before contact (destination refused, DNS or connect failure, concurrency cap).
- **Gates today.** `unavailableGate` refuses everything. `LocalPrototypeGate` accepts one `hhl_` token, rate-limits in memory, and counts `consumed`/`released` in memory only.
- **Credentials.** Relay credentials use their own prefixes: `hhl_` local, `hhk_` reserved for the paid service credential. A checkout recovery code (`hhr_`), provider invoice id, memo code, public txid or receipt id is never a relay credential.

### Connecting usage credit (the remaining step)

A preorder receipt becomes relay usage only through a `CreditAccessGate`. It needs:

1. **Credential issuance.** An authenticated `POST` exchanges a buyer's recovery code, for an order with an unrevoked receipt, for a new random `hhk_` service credential. The credential is shown once and only its SHA-256 is stored. The exchange is idempotent per receipt and revocable. The recovery code itself never becomes the credential.
2. **Durable ledger.** A new migration adds three tables:
   - `relay_credentials (hash, receipt_id UNIQUE, created_at, revoked_at)`
   - `relay_credit (receipt_id PK, balance_units bigint CHECK (balance_units >= 0))`, seeded once from the receipt under an approved price-per-call
   - `relay_reservations (id PK, receipt_id, units, state, created_at)`
3. **Atomic reservation.** `UPDATE relay_credit SET balance_units = balance_units - $units WHERE receipt_id = $r AND balance_units >= $units RETURNING`, plus an inserted reservation row, in one transaction. Settlement:
   - `released` refunds the units.
   - `consumed` marks the reservation final.
   - Reservations left open past a timeout are released by the next access.
   - A refund request or revoked receipt revokes the credential in the same transaction that revokes the receipt.
4. **Hosted limits and review.** Rate limits that hold across instances, and a reviewed hosted deployment, clear `no_hosted_rate_limit` and `hosted_deployment_unreviewed`.

Each piece clears its entry in `RELAY_BLOCKERS`. Even with all four cleared, `relayMode` stays `unavailable` until a reviewed hosted mode is added in code. The local prototype never becomes a hosted relay by configuration.

This is separate from the preorder. Preorder revenue is not a working paid relay, and the relay prototype is not a launched service.

## Tests

`src/relay/relay.test.ts` covers:

- the destination address table
- route matching and smuggling attempts
- private, mixed and rebinding DNS answers
- IP-literal, userinfo, query, port and scheme refusal
- header leaks through the real local server into a fixture upstream, with 16 identifying headers
- upstream redirects, statuses, content types, encodings, oversize bodies (declared and streamed), malformed bodies and timeouts, each with no retry
- credential shapes and rate-limit release
- the concurrency cap
- browser, method and Host refusal
- the token file mode
- hosted unavailability and the status report

None of it touches the network. The live check against the real upstream is manual: run `npm run relay`, then the examples.
