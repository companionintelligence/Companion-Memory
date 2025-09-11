#!/bin/bash

# Jenkins Setup Script for CI/CD Pipeline Configuration
# This script configures Jenkins with the necessary plugins and jobs

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
JENKINS_URL="http://localhost:8080"
JENKINS_USER=${JENKINS_USER:-"admin"}
JENKINS_PASSWORD=${JENKINS_PASSWORD:-""}
JOB_NAME="ci-server-deploy"

# Check if Jenkins is running
print_status "Checking Jenkins status..."
if ! curl -s "$JENKINS_URL" > /dev/null; then
    print_error "Jenkins is not accessible at $JENKINS_URL"
    print_error "Please ensure Jenkins is running and accessible."
    exit 1
fi

print_success "Jenkins is accessible at $JENKINS_URL"

# Function to get Jenkins CLI token (requires manual setup first)
get_jenkins_cli() {
    if [ -z "$JENKINS_PASSWORD" ]; then
        print_warning "JENKINS_PASSWORD environment variable not set."
        print_status "To configure Jenkins automatically, please:"
        print_status "1. Complete the initial Jenkins setup in the web interface"
        print_status "2. Create an API token for your admin user"
        print_status "3. Export JENKINS_PASSWORD=your_api_token"
        print_status "4. Re-run this script"
        print_status ""
        print_status "Alternatively, you can manually configure Jenkins using the templates in this directory."
        return 1
    fi
    
    # Download Jenkins CLI if not present
    if [ ! -f jenkins-cli.jar ]; then
        print_status "Downloading Jenkins CLI..."
        wget -q "$JENKINS_URL/jnlpJars/jenkins-cli.jar"
    fi
    
    return 0
}

# Function to install required plugins
install_plugins() {
    print_status "Installing required Jenkins plugins..."
    
    local plugins=(
        "git"
        "workflow-aggregator"
        "pipeline-stage-view"
        "nodejs"
        "docker-workflow"
        "github"
        "build-timeout"
        "timestamper"
        "ws-cleanup"
    )
    
    for plugin in "${plugins[@]}"; do
        print_status "Installing plugin: $plugin"
        java -jar jenkins-cli.jar -s "$JENKINS_URL" -auth "$JENKINS_USER:$JENKINS_PASSWORD" install-plugin "$plugin" || true
    done
    
    print_status "Restarting Jenkins to load plugins..."
    java -jar jenkins-cli.jar -s "$JENKINS_URL" -auth "$JENKINS_USER:$JENKINS_PASSWORD" restart
    
    # Wait for Jenkins to restart
    print_status "Waiting for Jenkins to restart..."
    sleep 60
}

# Function to configure Node.js installation
configure_nodejs() {
    print_status "Configuring Node.js installation..."
    
    # This would typically be done via Jenkins CLI or REST API
    # For now, we'll provide instructions
    cat << EOF

======================================================
Manual Node.js Configuration Required
======================================================
Please configure Node.js in Jenkins manually:

1. Go to Manage Jenkins > Tools
2. In the Node.js section, click "Add Node.js"
3. Name: "nodejs-$(cat ../.nvmrc)"
4. Version: "$(cat ../.nvmrc)"
5. Check "Install automatically"
6. Save the configuration

EOF
}

# Function to create the CI/CD job
create_job() {
    print_status "Creating CI/CD job: $JOB_NAME"
    
    # Create job from template
    java -jar jenkins-cli.jar -s "$JENKINS_URL" -auth "$JENKINS_USER:$JENKINS_PASSWORD" create-job "$JOB_NAME" < job-template.xml
    
    print_success "Job '$JOB_NAME' created successfully!"
}

# Main execution
print_status "Starting Jenkins setup..."

if get_jenkins_cli; then
    install_plugins
    configure_nodejs
    create_job
    
    print_success "Jenkins setup completed!"
    print_status "Access your Jenkins instance at: $JENKINS_URL"
    print_status "Job '$JOB_NAME' is ready for use."
else
    print_status "Automated setup skipped. Please configure Jenkins manually using the provided templates."
fi

# Cleanup
if [ -f jenkins-cli.jar ]; then
    rm jenkins-cli.jar
fi

print_status "Setup script completed!"

cat << EOF

======================================================
Next Steps
======================================================
1. Access Jenkins at: $JENKINS_URL
2. Configure the '$JOB_NAME' job with your Git repository URL
3. Set up webhooks in your Git repository to trigger builds
4. Configure Cloudflared for secure remote access (see ../cloudflared/README.md)
5. Set up Cloudflare Zero Trust (see documentation)

For manual configuration, use the templates in this directory:
- Jenkinsfile: Pipeline template
- job-template.xml: Job configuration template
======================================================

EOF