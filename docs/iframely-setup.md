# Iframely Service Setup

The iframely service is now included as part of the CI Server infrastructure and will be automatically started when you run `make infra`.

## What is Iframely?

Iframely is an oEmbed proxy service that provides rich embeds for URLs. It supports over 1800 domains and can generate embedded content for links from various websites.

## Service Details

- **Docker Image**: `dogbin/iframely`
- **Port**: 8061
- **Endpoint**: Available at `/embed/` through nginx proxy
- **Profiles**: Included in `all` and `infra` profiles

## Usage

### Starting the Service

The iframely service will be automatically started when you run:

```bash
make infra
```

### API Endpoints

Once running, you can access iframely through the nginx proxy:

- **Embed endpoint**: `https://localhost/embed/iframely?uri=<URL_TO_EMBED>`
- **oEmbed endpoint**: `https://localhost/embed/oembed?url=<URL_TO_EMBED>`
- **Debug UI**: `https://localhost/embed/debug`

### Example Usage

```bash
# Get embed data for a GitHub repository
curl -k "https://localhost/embed/iframely?uri=https://github.com/companionintelligence/CI-Server"

# Get oEmbed data
curl -k "https://localhost/embed/oembed?url=https://github.com/companionintelligence/CI-Server"
```

## Direct Access

If needed, you can also access iframely directly on port 8061:

```bash
curl "http://localhost:8061/iframely?uri=https://example.com"
```

## Troubleshooting

- If iframely appears to timeout, this is normal for quick tests - the service needs time to process URLs
- The service returns JSON responses with error details if something goes wrong
- Check service status with: `docker ps | grep iframely`
- View logs with: `docker logs iframely`