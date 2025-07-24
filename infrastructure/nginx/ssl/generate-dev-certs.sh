#!/bin/bash

# Generate SSL certificates for dev.companionintelligence.com
# This script creates self-signed certificates for local development

set -e

SSL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOMAIN="dev.companionintelligence.com"

echo "🔐 Generating SSL certificates for $DOMAIN..."

# Create the SSL directory if it doesn't exist
mkdir -p "$SSL_DIR"

# Generate private key
openssl genrsa -out "$SSL_DIR/$DOMAIN.key" 2048

# Generate certificate signing request
openssl req -new -key "$SSL_DIR/$DOMAIN.key" -out "$SSL_DIR/$DOMAIN.csr" -subj "/C=US/ST=State/L=City/O=Organization/CN=$DOMAIN"

# Generate self-signed certificate
openssl x509 -req -days 365 -in "$SSL_DIR/$DOMAIN.csr" -signkey "$SSL_DIR/$DOMAIN.key" -out "$SSL_DIR/$DOMAIN.crt"

# Also create localhost certificates for compatibility
openssl genrsa -out "$SSL_DIR/localhost.key" 2048
openssl req -new -key "$SSL_DIR/localhost.key" -out "$SSL_DIR/localhost.csr" -subj "/C=US/ST=State/L=City/O=Organization/CN=localhost"
openssl x509 -req -days 365 -in "$SSL_DIR/localhost.csr" -signkey "$SSL_DIR/localhost.key" -out "$SSL_DIR/localhost.crt"

# Clean up CSR files
rm "$SSL_DIR/$DOMAIN.csr" "$SSL_DIR/localhost.csr"

echo "✅ SSL certificates generated successfully!"
echo "   - $SSL_DIR/$DOMAIN.crt"
echo "   - $SSL_DIR/$DOMAIN.key"
echo "   - $SSL_DIR/localhost.crt"
echo "   - $SSL_DIR/localhost.key" 