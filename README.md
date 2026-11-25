# check-url-service

Microservice for checking whether an external URL can be reached without authentication.

This service validates the URL, resolves the hostname to public addresses only, makes direct HTTP requests using pinned connections while following redirects one hop at a time, and returns the final HTTP result. Usage of the check endpoint is restricted to authenticated users.

## How it works

The service accepts a URL through `POST /check` and performs the following checks before attempting the request:

- `url` is required and must be a non-empty string
- the value must parse as an absolute URL
- credentials in the URL (`user:pass@host`) are rejected
- only `https:` is allowed by default; `http:` is accepted only when `VALIDATE_URL_ALLOW_HTTP=true`
- the hostname must resolve to a public address; private, loopback, link-local and other non-public addresses are rejected
- requests are sent with `redirect: "manual"`; redirect responses (301, 302, 303, 307, 308) are followed one hop at a time, up to 5 redirects, and every redirect target goes through the same checks as the original URL (supported protocol, no credentials, public host). A redirect from https to http is refused.
- the whole chain, including every DNS lookup, is limited to 10 seconds
- outgoing requests use the `User-Agent` configured via `VALIDATE_URL_USER_AGENT`; Node's default user agent is blocked by some sites
- the response of the final hop is returned as JSON with the final URL, a boolean `status`, and the HTTP `statusCode`

The implementation uses Node's built-in `fetch` and Undici with a pinned DNS lookup; every hop in a redirect chain is pinned to the addresses that were validated up front, so redirects can never lead the check to a private or internal host.

## Installation

### Docker compose

Add the service to your `docker-compose.yml`:

```yaml
  check-url:
    image: lblod/check-url-service
    environment:
      VALIDATE_URL_ALLOW_HTTP: "false"
    labels:
      - "logging=true"
    restart: always
    logging: *default-logging
```

Configure the dispatcher (`dispatcher.ex`) to send frontend requests to the service:

```elixir
  match "/check-link/*path", @json do
    forward conn, path, "http://check-url/"
  end
```

### Network isolation (recommended)

The service makes outbound requests to arbitrary URLs. Put it on a dedicated network as
defence in depth. Share that network only with the peers it needs: the dispatcher
(inbound) and the database (session lookup).

```yaml
services:
  check-url:
    image: lblod/check-url-service
    networks:
      - check-url-net
    environment:
      VALIDATE_URL_ALLOW_HTTP: "false"
    labels:
      - "logging=true"
    restart: always
    logging: *default-logging

  dispatcher:
    networks:
      - default
      - check-url-net

  database:
    networks:
      - default
      - check-url-net

networks:
  check-url-net: {}
```

This keeps the service off the default network. It cannot reach the triplestore
(`virtuoso`), `identifier`, `resource`, `cache` or other services directly. It still
reaches the dispatcher and `database`, which it needs.

This is a second barrier. It does not replace the URL and IP checks in the service.
Keep the following in mind:

- Do not publish internal services on the host (`ports:`). A published port is reachable
  from every Docker network through the host gateway.
- Do not expose the Docker API over TCP and do not mount `/var/run/docker.sock`.
- Do not use `network_mode: host`, `privileged`, or attach the service to the default
  network.
- The service can still reach the host gateway and the internet. The service's own IP
  filter blocks RFC1918, loopback and link-local targets such as `169.254.169.254`.
- The dispatcher is already public through `mu-identifier`. Reaching it from this
  service adds no new surface. `database` is the ACL layer and the request carries no
  session, so it is anonymous public read at worst.

If you need a hard egress boundary, add an egress proxy on an `internal: true` network
and move the IP filter there. That needs a proxy dispatcher and is not needed for the
default deployment.

## API

The service exposes a health check endpoint and a single validation endpoint.

### GET /

Returns a simple health check response.

Example response:

```json
"Hello from the check-url-service."
```

### POST /check

Checks whether a URL is accessible without authentication.

Request body:

```json
{
  "url": "https://example.com"
}
```

Validation rules:

- `url` is required
- it must be a non-empty string
- it must be a valid absolute URL
- URLs containing credentials (`user:pass@host`) are rejected
- the protocol must be `https:` unless `VALIDATE_URL_ALLOW_HTTP=true`
- the target host must resolve to a public IP address
- every redirect target must satisfy the same rules

#### Authentication

The service asks the triplestore if the session has a `session:account` in `http://mu.semte.ch/graphs/sessions`.

On a sparql-parser stack, the service sends the scope `http://services.semantic.works/check-url-service`. `DEFAULT_MU_AUTH_SCOPE` overrides it. The app grants read on the sessions graph in that scope:

```lisp
(supply-allowed-group "logged-in"
  :parameters ()
  :query "PREFIX session: <http://mu.semte.ch/vocabularies/session/>
          SELECT ?account WHERE { <SESSION_ID> session:account ?account } LIMIT 1")

(with-scope "http://services.semantic.works/check-url-service"
  (grant (read)
    :to-graph (sessions)
    :for-allowed-group "logged-in"))
```

The group needs `:parameters ()`. sparql-parser adds the parameters of a group to the graph URI. With a parameter the grant goes to a graph that does not exist.

On a mu-authorization stack there are no scopes. Set `ALLOW_MU_AUTH_SUDO: "true"` on the service. The service then asks the same question with sudo.

Without the grant and without sudo, every call gets 401.

`REQUIRE_AUTHENTICATION: "false"` turns the check off.

#### Responses

- target responds: `200 { url, status, statusCode }`
- target is dead or a redirect is refused: `200 { url, status: false, statusCode: null, reason }`
- input we refuse, also a non-public first target: `400`
- no session or not logged in: `401`
- fault of the service: `502`
- the session check itself fails: `503`

`status` is `true` when the final response is successful (`response.ok`). A 404 or 500 from the target gives `status: false` and the real `statusCode`, without `reason`.

For a dead target, `url` is the hop that failed. The reasons:

- `dns`: the host name does not resolve.
- `timeout`: the 10 seconds are over.
- `tls`: the certificate is not valid.
- `connect`: any other failure to connect.
- `blocked`: a redirect goes to a target we refuse.
- `redirect`: too many redirects, or a redirect with a broken `Location`.

## Notes

- The service rejects links to private or local hosts.
- Redirects are followed one hop at a time.
- A redirect chain that exceeds 5 redirects, or that redirects to a URL we refuse (for example plain `http:` while `VALIDATE_URL_ALLOW_HTTP` is not enabled, or from https to http), gives `status: false` with a reason.
- The whole chain, including the DNS lookups, is limited to 10 seconds.
