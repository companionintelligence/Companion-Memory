# Cloudflared Setup for Secure Remote Access

This directory contains scripts and configuration for setting up Cloudflared tunnels to provide secure remote access to your local Jenkins and CI-Server deployment through Cloudflare Zero Trust.

## Overview

Cloudflared enables secure remote access to your local services without opening firewall ports or exposing services directly to the internet. It works by creating encrypted tunnels to Cloudflare's edge network.

## Benefits

- **Secure**: No open ports or exposed services
- **Zero Trust**: All traffic goes through Cloudflare's security layers
- **Easy Setup**: Simple configuration and management
- **Global Access**: Access your services from anywhere
- **SSL/TLS**: Automatic HTTPS termination

## Files

- `install-cloudflared.sh` - Native OS installation script for Ubuntu/Debian
- `setup-tunnel.sh` - Tunnel creation and configuration script
- `docker-compose.cloudflared.yml` - Docker-based Cloudflared setup
- `config.yml` - Cloudflared tunnel configuration template

## Requirements

- Cloudflare account with a domain
- Cloudflare Zero Trust setup
- Ubuntu 22.04 or 24.04 (for native installation)
- Docker (for containerized setup)

## Quick Start

### Option 1: Native Installation
```bash
# Install Cloudflared
./cloudflared/install-cloudflared.sh

# Set up tunnel (requires Cloudflare authentication)
./cloudflared/setup-tunnel.sh
```

### Option 2: Docker Installation
```bash
# Run Cloudflared in Docker
docker-compose -f cloudflared/docker-compose.cloudflared.yml up -d
```

## Setup Process

1. **Install Cloudflared** (native or Docker)
2. **Authenticate with Cloudflare** (`cloudflared tunnel login`)
3. **Create tunnel** (`cloudflared tunnel create <tunnel-name>`)
4. **Configure DNS** in Cloudflare Dashboard
5. **Configure tunnel routing** (services to expose)
6. **Start tunnel** and verify connectivity

## Security Considerations

- Keep tunnel credentials secure
- Use Zero Trust policies to control access
- Monitor tunnel usage and logs
- Regularly update Cloudflared
- Configure appropriate access policies

## Troubleshooting

- Check tunnel status: `cloudflared tunnel info <tunnel-name>`
- View logs: `cloudflared tunnel --loglevel debug run`
- Test connectivity: `cloudflared tunnel --url http://localhost:8080`