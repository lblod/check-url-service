# check-url-service

Microservice for checking whether an external URL can be reached without authentication.

This service no longer relies on the `link-check` package. It validates the URL, resolves the hostname to public addresses only, makes a direct HTTP request using a pinned HTTP client, and returns the final HTTP result.

## How it works

The service accepts a URL through `POST /check` and performs the following checks before attempting the request:

- `url` is required and must be a non-empty string
- the value must parse as an absolute URL
- credentials in the URL (`user:pass@host`) are rejected
- only `https:` is allowed by default; `http:` is accepted only when `VALIDATE_URL_ALLOW_HTTP=true`
- the hostname must resolve to a public address; private, loopback, link-local and other non-public addresses are rejected
- the request is sent with a 10 second timeout and `redirect: "manual"`
- the response is returned as JSON with the final URL, a boolean `status`, and the HTTP `statusCode`

The implementation uses Node's built-in `fetch` and Undici with a pinned DNS lookup, which prevents the request from being redirected to a private/internal host.

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

Successful response:

```json
{
  "url": "https://example.com",
  "status": true,
  "statusCode": 200
}
```

The `status` field is a boolean:

- `true` when the HTTP response is considered successful (`response.ok`)
- `false` when the response is not successful or the request fails at the transport level

Error responses:

- `400 Bad Request`: missing, malformed, unsupported, or disallowed URL input
- `502 Bad Gateway`: the URL could not be checked because the service could not resolve or fetch it safely

## Notes

- The service intentionally rejects links to private or local hosts.
- Redirects are not followed automatically; the service checks the final response as received.
- The request is limited to 10 seconds to avoid hanging on slow or unreachable endpoints.
