# Jenkins Local Deployment Setup

This directory contains scripts and configuration for setting up Jenkins-based CI/CD for local deployment with Cloudflared and Zero Trust integration.

## Overview

The Jenkins setup provides:
- Automated Jenkins installation on Ubuntu/Debian
- Pre-configured job templates for Node.js applications
- Integration with Git repositories
- Automatic deployment on `main` branch updates
- Cloudflared tunnel support for secure remote access

## Files

- `install-jenkins.sh` - Jenkins installation script for Ubuntu/Debian
- `setup-jenkins.sh` - Jenkins configuration and job setup script
- `Jenkinsfile` - Pipeline template for Node.js application deployment
- `job-template.xml` - Jenkins job configuration template

## Quick Start

Run the automated setup:
```bash
make jenkins-setup
```

Or manually:
```bash
./jenkins/install-jenkins.sh
./jenkins/setup-jenkins.sh
```

## Requirements

- Ubuntu 22.04 or 24.04
- Docker and Docker Compose
- Node.js (version specified in .nvmrc)
- Git access to the repository

## Security

Jenkins is configured to work with Cloudflared tunnels for secure remote access. See the Cloudflared setup documentation for tunnel configuration.