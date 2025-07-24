#!/bin/bash

# Setup script for dev.companionintelligence.com domain
# This script adds the necessary hosts file entry and generates SSL certificates

set -e

DOMAIN="dev.companionintelligence.com"
HOSTS_ENTRY="127.0.0.1 $DOMAIN"

echo "🌐 Setting up $DOMAIN for local development..."

# Check if the hosts entry already exists
if grep -q "$DOMAIN" /etc/hosts; then
    echo "✅ $DOMAIN already exists in /etc/hosts"
else
    echo "📝 Adding $DOMAIN to /etc/hosts..."
    echo "$HOSTS_ENTRY" | sudo tee -a /etc/hosts
    echo "✅ Added $DOMAIN to /etc/hosts"
fi

# Generate SSL certificates
echo "🔐 Generating SSL certificates..."
cd "$(dirname "$0")/../infrastructure/nginx/ssl"
chmod +x generate-dev-certs.sh
./generate-dev-certs.sh

echo "✅ Setup complete!"
echo ""
echo "You can now:"
echo "1. Run 'make infra' to start the infrastructure"
echo "2. Run 'make init' to initialize the project"
echo "3. Access your application at https://$DOMAIN" 