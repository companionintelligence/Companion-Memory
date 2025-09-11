#!/bin/bash

# Jenkins Installation Script for Ubuntu/Debian
# Based on official Jenkins Debian installation guide
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
        if [[ "$VER" != "22.04" && "$VER" != "24.04" ]]; then
            print_warning "This script is tested on Ubuntu 22.04 and 24.04. Your version ($VER) may work but is not officially supported."
        fi
    elif [[ "$OS" == *"Debian"* ]]; then
        print_status "Debian detected. Proceeding with installation."
    else
        print_error "Unsupported operating system: $OS"
        exit 1
    fi
else
    print_error "Cannot detect operating system."
    exit 1
fi

# Check if Java is installed
print_status "Checking Java installation..."
if command -v java >/dev/null 2>&1; then
    JAVA_VERSION=$(java -version 2>&1 | head -n1 | cut -d'"' -f2 | cut -d'.' -f1)
    print_success "Java $JAVA_VERSION is already installed"
else
    print_status "Installing OpenJDK 21..."
    sudo apt update
    sudo apt install -y openjdk-21-jdk
    print_success "Java installed successfully"
fi

# Add Jenkins repository key
print_status "Adding Jenkins repository key..."
sudo mkdir -p /usr/share/keyrings
curl -fsSL https://pkg.jenkins.io/debian-stable/jenkins.io-2023.key | sudo tee /usr/share/keyrings/jenkins-keyring.asc > /dev/null

# Add Jenkins repository
print_status "Adding Jenkins repository..."
echo "deb [signed-by=/usr/share/keyrings/jenkins-keyring.asc] https://pkg.jenkins.io/debian-stable binary/" | sudo tee /etc/apt/sources.list.d/jenkins.list > /dev/null

# Update package list
print_status "Updating package list..."
sudo apt update

# Install Jenkins
print_status "Installing Jenkins..."
sudo apt install -y jenkins

# Start and enable Jenkins service
print_status "Starting Jenkins service..."
sudo systemctl start jenkins
sudo systemctl enable jenkins

# Wait for Jenkins to start
print_status "Waiting for Jenkins to start..."
sleep 30

# Check Jenkins status
if sudo systemctl is-active --quiet jenkins; then
    print_success "Jenkins is running successfully!"
else
    print_error "Jenkins failed to start. Please check the logs with: sudo journalctl -u jenkins"
    exit 1
fi

# Get initial admin password
print_status "Getting Jenkins initial admin password..."
if [ -f /var/lib/jenkins/secrets/initialAdminPassword ]; then
    INITIAL_PASSWORD=$(sudo cat /var/lib/jenkins/secrets/initialAdminPassword)
    print_success "Jenkins installation completed!"
    echo ""
    echo "======================================================="
    echo "Jenkins Initial Setup Information"
    echo "======================================================="
    echo "Jenkins URL: http://localhost:8080"
    echo "Initial Admin Password: $INITIAL_PASSWORD"
    echo ""
    echo "Next steps:"
    echo "1. Open http://localhost:8080 in your browser"
    echo "2. Enter the initial admin password shown above"
    echo "3. Install suggested plugins"
    echo "4. Create your first admin user"
    echo "5. Run './jenkins/setup-jenkins.sh' to configure the CI/CD pipeline"
    echo "======================================================="
else
    print_error "Could not find initial admin password file."
    print_status "You can find it manually at: /var/lib/jenkins/secrets/initialAdminPassword"
fi

# Add current user to jenkins group for easier management
print_status "Adding current user ($USER) to jenkins group..."
sudo usermod -a -G jenkins $USER

print_success "Jenkins installation script completed!"
print_warning "Please log out and log back in (or run 'newgrp jenkins') for group changes to take effect."