#!/bin/bash

# Cloudflared Installation Script for Ubuntu/Debian
# Based on official Cloudflare installation guide
# Compatible with Ubuntu 22.04 and 24.04

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

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    print_error "Please do not run this script as root. Run as a regular user with sudo privileges."
    exit 1
fi

# Check if running on supported Ubuntu/Debian version
print_status "Checking system compatibility..."
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$NAME
    VER=$VERSION_ID
    print_status "Detected: $OS $VER"
    
    if [[ "$OS" == *"Ubuntu"* ]]; then
        if [[ "$VER" == "22.04" ]]; then
            CODENAME="jammy"
        elif [[ "$VER" == "24.04" ]]; then
            CODENAME="noble"
        else
            print_warning "Ubuntu version $VER may not be officially supported. Attempting to use noble codename."
            CODENAME="noble"
        fi
    elif [[ "$OS" == *"Debian"* ]]; then
        # For Debian, determine codename
        CODENAME=$(lsb_release -cs 2>/dev/null || echo "bookworm")
    else
        print_error "Unsupported operating system: $OS"
        exit 1
    fi
else
    print_error "Cannot detect operating system."
    exit 1
fi

print_status "Using codename: $CODENAME"

# Check if Cloudflared is already installed
if command -v cloudflared >/dev/null 2>&1; then
    CURRENT_VERSION=$(cloudflared version | head -n1 | awk '{print $3}')
    print_warning "Cloudflared is already installed (version: $CURRENT_VERSION)"
    read -p "Do you want to reinstall/update? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_status "Installation skipped."
        exit 0
    fi
fi

# Create keyring directory
print_status "Setting up package repository..."
sudo mkdir -p --mode=0755 /usr/share/keyrings

# Add Cloudflare GPG key
print_status "Adding Cloudflare GPG key..."
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null

# Add Cloudflare repository
print_status "Adding Cloudflare repository..."
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $CODENAME main" | sudo tee /etc/apt/sources.list.d/cloudflared.list

# Update package list
print_status "Updating package list..."
sudo apt-get update

# Install Cloudflared
print_status "Installing Cloudflared..."
sudo apt-get install -y cloudflared

# Verify installation
if command -v cloudflared >/dev/null 2>&1; then
    VERSION=$(cloudflared version | head -n1 | awk '{print $3}')
    print_success "Cloudflared $VERSION installed successfully!"
else
    print_error "Cloudflared installation failed."
    exit 1
fi

# Create systemd service directory for user
print_status "Setting up systemd service directory..."
mkdir -p ~/.config/systemd/user

print_success "Cloudflared installation completed!"

cat << EOF

======================================================
Cloudflared Installation Complete
======================================================
Version: $(cloudflared version | head -n1)

Next steps:
1. Authenticate with Cloudflare:
   cloudflared tunnel login

2. Create a new tunnel:
   cloudflared tunnel create <tunnel-name>

3. Configure your tunnel:
   ./cloudflared/setup-tunnel.sh

4. Set up DNS and Zero Trust policies in Cloudflare Dashboard

For more details, see:
- https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- ./cloudflared/README.md
======================================================

EOF