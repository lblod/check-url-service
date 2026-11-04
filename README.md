# check-url-service

Microservice for checking whether an external URL can be reached without authentication.

This service no longer relies on the `link-check` package. It validates the URL, resolves the hostname to public addresses only, makes direct HTTP requests using pinned connections while following redirects one hop at a time, and returns the final HTTP result.

## How it works

The service accepts a URL through `POST /check` and performs the following checks before attempting the request:

- `url` is required and must be a non-empty string
- the value must parse as an absolute URL
- credentials in the URL (`user:pass@host`) are rejected
- only `https:` is allowed by default; `http:` is accepted only when `VALIDATE_URL_ALLOW_HTTP=true`
- the hostname must resolve to a public address; private, loopback, link-local and other non-public addresses are rejected
- requests are sent with `redirect: "manual"`; redirect responses (301, 302, 303, 307, 308) are followed one hop at a time, up to 20 redirects, and every redirect target goes through the same checks as the original URL (supported protocol, no credentials, public host)
- the whole redirect chain is limited to 10 seconds
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

Successful response:

```json
{
  "url": "https://example.com",
  "status": true,
  "statusCode": 200
}
```

The `status` field is a boolean:

- `true` when the final HTTP response is considered successful (`response.ok`)
- `false` when the response is not successful or the request fails at the transport level

Error responses:

- `400 Bad Request`: missing, malformed, unsupported, or disallowed URL input
- `502 Bad Gateway`: the URL could not be checked because the service could not resolve or fetch it safely

## Notes

- The service intentionally rejects links to private or local hosts.
- Redirects are followed one hop at a time.
- A redirect chain that exceeds 20 redirects, or that redirects to a URL that is not allowed as input (for example plain `http:` while `VALIDATE_URL_ALLOW_HTTP` is not enabled), cannot be checked and results in a `502` response.
- The entire redirect chain is limited to 10 seconds to avoid hanging on slow or unreachable endpoints.
