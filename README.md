# check-url-service
Microservice for checking whether or not (external) URLs can be accessed without authentication.
The service uses the (link-check package)[https://www.npmjs.com/package/link-check] to test whether or not a given URL is reachable.

## How it works
The service uses the link-check package to test out whether a given link can be reached. Upon success, the service sends back JSON with the link, a boolean `status` (`true` when reachable, `false` otherwise) and the HTTP status code.

## Installation
### Docker compose
Add the service to your `docker-compose.yml`:
```
  check-url:
    image: lblod/check-url-service
    labels:
      - "logging=true"
    restart: always
    logging: *default-logging
```

Configure the dispatcher (`dispatcher.ex`) to send frontend requests to the service:
```
  match "/check-link/*path", @json do
    forward conn, path, "http://check-url/"
  end
```

## API

The service exposes a single endpoint for checking whether a URL is reachable.

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

Validation:
- `url` is required
- it must be a non-empty string
- it must be a valid absolute URL
- URLs containing credentials (`user:pass@host`) are rejected

Successful response:
```json
{
  "url": "https://example.com",
  "status": true,
  "statusCode": 200
}
```

The `status` field is a boolean:
- `true` when the URL is reachable
- `false` when it is not reachable or the link checker reports it as unavailable

Error responses:
- `400 Bad Request`: missing or invalid URL
- `502 Bad Gateway`: the URL could not be checked by the underlying link checker
