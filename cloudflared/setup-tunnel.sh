#!/bin/bash

# Cloudflared Tunnel Setup Script
# Creates and configures a tunnel for Jenkins and CI-Server access

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
RESET='\033[0m'

print_status() {
    echo -e "${BLUE}[INFO]${RESET} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${RESET} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${RESET} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${RESET} $1"
}

# Configuration
TUNNEL_NAME=${TUNNEL_NAME:-"ci-server-tunnel"}
DOMAIN=${DOMAIN:-""}
CONFIG_DIR="$HOME/.cloudflared"
CONFIG_FILE="$CONFIG_DIR/config.yml"

# Check if cloudflared is installed
if ! command -v cloudflared >/dev/null 2>&1; then
    print_error "Cloudflared is not installed. Please run ./cloudflared/install-cloudflared.sh first."
    exit 1
fi

print_status "Setting up Cloudflared tunnel: $TUNNEL_NAME"

# Prompt for domain if not set
if [ -z "$DOMAIN" ]; then
    echo -n "Enter your domain name (e.g., example.com): "
    read DOMAIN
    
    if [ -z "$DOMAIN" ]; then
        print_error "Domain name is required."
        exit 1
    fi
fi

print_status "Using domain: $DOMAIN"

# Check if user is already authenticated
print_status "Checking Cloudflare authentication..."
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
    print_status "You need to authenticate with Cloudflare first."
    print_status "This will open a browser window for authentication."
    read -p "Press Enter to continue..."
    
    cloudflared tunnel login
    
    if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
        print_error "Authentication failed or was cancelled."
        exit 1
    fi
    
    print_success "Authentication successful!"
fi

# Create tunnel if it doesn't exist
print_status "Creating tunnel: $TUNNEL_NAME"
if cloudflared tunnel list | grep -q "$TUNNEL_NAME"; then
    print_warning "Tunnel '$TUNNEL_NAME' already exists."
    TUNNEL_ID=$(cloudflared tunnel list | grep "$TUNNEL_NAME" | awk '{print $1}')
else
    TUNNEL_ID=$(cloudflared tunnel create "$TUNNEL_NAME" 2>&1 | grep -o '[a-f0-9-]\{36\}' | head -1)
    if [ -z "$TUNNEL_ID" ]; then
        print_error "Failed to create tunnel."
        exit 1
    fi
    print_success "Tunnel created with ID: $TUNNEL_ID"
fi

# Create config directory
mkdir -p "$CONFIG_DIR"

# Generate tunnel configuration
print_status "Generating tunnel configuration..."
cat > "$CONFIG_FILE" << EOF
# Cloudflared tunnel configuration for CI-Server
tunnel: $TUNNEL_ID
credentials-file: $CONFIG_DIR/$TUNNEL_ID.json

# Ingress rules - route traffic to local services
ingress:
  # Jenkins access
  - hostname: jenkins.$DOMAIN
    service: http://localhost:8080
    originRequest:
      httpHostHeader: localhost:8080
  
  # CI-Server staging application
  - hostname: app.$DOMAIN
    service: http://localhost:8642
    originRequest:
      httpHostHeader: localhost:8642
  
  # CI-Server development (optional)
  - hostname: dev.$DOMAIN
    service: http://localhost:80
    originRequest:
      httpHostHeader: dev.companionintelligence.com
  
  # Catch-all rule (required)
  - service: http_status:404

# Logging configuration
loglevel: info

# Metrics (optional)
metrics: localhost:8081
EOF

print_success "Configuration file created at: $CONFIG_FILE"

# Validate configuration
print_status "Validating tunnel configuration..."
if cloudflared tunnel ingress validate; then
    print_success "Configuration is valid!"
else
    print_error "Configuration validation failed. Please check the config file."
    exit 1
fi

# Create systemd service
print_status "Creating systemd service..."
SERVICE_FILE="$HOME/.config/systemd/user/cloudflared.service"
mkdir -p "$(dirname "$SERVICE_FILE")"

cat > "$SERVICE_FILE" << EOF
[Unit]
Description=Cloudflared tunnel for CI-Server
After=network.target

[Service]
Type=simple
User=$USER
ExecStart=$(which cloudflared) tunnel run
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=default.target
EOF

# Reload systemd and enable service
systemctl --user daemon-reload
systemctl --user enable cloudflared.service

print_success "Systemd service created and enabled!"

# Display DNS configuration instructions
cat << EOF

======================================================
Tunnel Setup Complete
======================================================
Tunnel Name: $TUNNEL_NAME
Tunnel ID: $TUNNEL_ID
Domain: $DOMAIN

IMPORTANT: DNS Configuration Required
======================================================
You need to configure DNS records in your Cloudflare dashboard:

1. Go to https://dash.cloudflare.com
2. Select your domain: $DOMAIN
3. Go to DNS > Records
4. Add the following CNAME records:

   jenkins.$DOMAIN -> $TUNNEL_ID.cfargotunnel.com
   app.$DOMAIN -> $TUNNEL_ID.cfargotunnel.com
   dev.$DOMAIN -> $TUNNEL_ID.cfargotunnel.com

5. Save the DNS configuration

Starting the Tunnel
======================================================
To start the tunnel:
  systemctl --user start cloudflared.service

To stop the tunnel:
  systemctl --user stop cloudflared.service

To check tunnel status:
  systemctl --user status cloudflared.service
  cloudflared tunnel info $TUNNEL_NAME

To view logs:
  journalctl --user -u cloudflared.service -f

Zero Trust Configuration
======================================================
For additional security, configure Zero Trust policies at:
https://one.dash.cloudflare.com/

This allows you to:
- Require authentication for access
- Set up conditional access policies
- Monitor and audit access logs
- Configure multi-factor authentication

Access URLs (after DNS configuration):
======================================================
Jenkins: https://jenkins.$DOMAIN
CI-Server App: https://app.$DOMAIN
Development: https://dev.$DOMAIN

======================================================

EOF

# Ask if user wants to start the tunnel now
read -p "Do you want to start the tunnel now? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    print_status "Starting tunnel..."
    systemctl --user start cloudflared.service
    
    sleep 3
    
    if systemctl --user is-active --quiet cloudflared.service; then
        print_success "Tunnel is running!"
        print_status "Check tunnel status: systemctl --user status cloudflared.service"
    else
        print_error "Failed to start tunnel. Check logs: journalctl --user -u cloudflared.service"
    fi
else
    print_status "Tunnel created but not started. Start it manually when ready."
fi

print_success "Tunnel setup completed!"