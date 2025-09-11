# Jenkins + Cloudflared Local Deployment Setup Checklist

This checklist ensures you have everything set up correctly for Jenkins-based CI/CD with secure Cloudflared tunnel access.

## Prerequisites Checklist

- [ ] Ubuntu 22.04 or 24.04 server
- [ ] Sudo privileges on the server
- [ ] Cloudflare account
- [ ] Domain managed by Cloudflare
- [ ] Git repository access
- [ ] Internet connectivity

## Phase 1: Initial Setup

### 1.1 System Preparation
- [ ] Update system packages: `sudo apt update && sudo apt upgrade -y`
- [ ] Install Git: `sudo apt install -y git`
- [ ] Install Docker: Follow [Docker installation guide](https://docs.docker.com/engine/install/ubuntu/)
- [ ] Install Node.js version manager (asdf recommended)

### 1.2 Project Setup
- [ ] Clone the CI-Server repository
- [ ] Navigate to project directory
- [ ] Check Node.js version requirements: `cat .nvmrc`
- [ ] Install required Node.js version
- [ ] Enable corepack: `corepack enable`
- [ ] Install dependencies: `yarn install`

## Phase 2: Jenkins Installation

### 2.1 Automated Installation
- [ ] Run: `make jenkins-setup`
- [ ] Verify Jenkins is running: `sudo systemctl status jenkins`
- [ ] Access Jenkins at: `http://localhost:8080`
- [ ] Note the initial admin password from installation output

### 2.2 Manual Installation (Alternative)
- [ ] Run: `./jenkins/install-jenkins.sh`
- [ ] Run: `./jenkins/setup-jenkins.sh`
- [ ] Follow setup instructions

### 2.3 Jenkins Configuration
- [ ] Complete initial Jenkins setup wizard
- [ ] Install suggested plugins
- [ ] Create admin user account
- [ ] Configure Node.js tool (version from `.nvmrc`)
- [ ] Verify the `ci-server-deploy` job was created

## Phase 3: Cloudflared Installation

### 3.1 Choose Installation Method

**Option A: Native Installation**
- [ ] Run: `./cloudflared/install-cloudflared.sh`
- [ ] Verify installation: `cloudflared version`

**Option B: Docker Installation**
- [ ] Copy template: `cp cloudflared/config-template.yml cloudflared/config.yml`
- [ ] Edit `cloudflared/config.yml` with your domain
- [ ] Run: `docker-compose -f cloudflared/docker-compose.cloudflared.yml --profile setup run cloudflared-setup`

### 3.2 Tunnel Setup
- [ ] Run: `./cloudflared/setup-tunnel.sh`
- [ ] Enter your domain when prompted
- [ ] Complete Cloudflare authentication in browser
- [ ] Note the tunnel ID from output
- [ ] Verify tunnel configuration is valid

## Phase 4: DNS Configuration

### 4.1 Cloudflare DNS Setup
- [ ] Log into [Cloudflare Dashboard](https://dash.cloudflare.com)
- [ ] Navigate to your domain's DNS settings
- [ ] Add CNAME records (replace with your tunnel ID):
  - [ ] `jenkins.yourdomain.com` → `YOUR_TUNNEL_ID.cfargotunnel.com`
  - [ ] `app.yourdomain.com` → `YOUR_TUNNEL_ID.cfargotunnel.com`
  - [ ] `dev.yourdomain.com` → `YOUR_TUNNEL_ID.cfargotunnel.com`
- [ ] Ensure records are "Proxied" (orange cloud icon)
- [ ] Wait for DNS propagation (5-10 minutes)

### 4.2 DNS Verification
- [ ] Test DNS resolution: `dig jenkins.yourdomain.com`
- [ ] Verify CNAME points to tunnel: `nslookup jenkins.yourdomain.com`

## Phase 5: Zero Trust Configuration

### 5.1 Zero Trust Setup
- [ ] Access [Zero Trust Dashboard](https://one.dash.cloudflare.com/)
- [ ] Complete Zero Trust onboarding
- [ ] Choose appropriate plan (Free for development)
- [ ] Configure team domain

### 5.2 Access Applications
- [ ] Create Access Application for Jenkins:
  - [ ] Name: "Jenkins CI/CD"
  - [ ] Domain: `jenkins.yourdomain.com`
  - [ ] Type: Self-hosted
- [ ] Create Access Application for CI-Server:
  - [ ] Name: "CI-Server App"
  - [ ] Domain: `app.yourdomain.com`
  - [ ] Type: Self-hosted
- [ ] Create Access Application for Development:
  - [ ] Name: "Development Environment"
  - [ ] Domain: `dev.yourdomain.com`
  - [ ] Type: Self-hosted

### 5.3 Access Policies
- [ ] Configure authentication policies for each application
- [ ] Add allowed users/email domains
- [ ] Set session duration (recommended: 24 hours)
- [ ] Test policy configuration

## Phase 6: Testing and Verification

### 6.1 Tunnel Testing
- [ ] Start tunnel: `systemctl --user start cloudflared.service`
- [ ] Check tunnel status: `systemctl --user status cloudflared.service`
- [ ] Verify tunnel info: `cloudflared tunnel info your-tunnel-name`

### 6.2 Service Access Testing
- [ ] Access Jenkins: `https://jenkins.yourdomain.com`
- [ ] Verify Cloudflare Access authentication
- [ ] Login to Jenkins with admin credentials
- [ ] Check that the `ci-server-deploy` job exists

### 6.3 CI/CD Pipeline Testing
- [ ] Configure Git repository URL in Jenkins job
- [ ] Set up Git credentials/SSH keys if needed
- [ ] Trigger manual build to test pipeline
- [ ] Verify build completes successfully
- [ ] Check deployment works correctly

## Phase 7: Security and Monitoring

### 7.1 Security Configuration
- [ ] Enable multi-factor authentication
- [ ] Configure device trust policies (if needed)
- [ ] Set up audit logging
- [ ] Review and test access policies

### 7.2 Monitoring Setup
- [ ] Monitor Jenkins logs: `sudo journalctl -u jenkins -f`
- [ ] Monitor Cloudflared logs: `journalctl --user -u cloudflared.service -f`
- [ ] Check Zero Trust access logs in dashboard
- [ ] Set up alerting for failed authentications

## Phase 8: Production Readiness

### 8.1 Backup Configuration
- [ ] Backup Jenkins configuration directory: `/var/lib/jenkins`
- [ ] Backup Cloudflared configuration: `~/.cloudflared/`
- [ ] Document tunnel ID and credentials location
- [ ] Create restore procedures

### 8.2 Maintenance Tasks
- [ ] Schedule regular Jenkins backups
- [ ] Plan for Jenkins plugin updates
- [ ] Monitor Cloudflared version updates
- [ ] Review access policies monthly
- [ ] Clean up old build artifacts

## Troubleshooting Checklist

### Common Issues
- [ ] **Jenkins not accessible**: Check service status, firewall rules
- [ ] **Cloudflared tunnel down**: Check internet connectivity, tunnel credentials
- [ ] **DNS not resolving**: Verify DNS records, check propagation
- [ ] **Access denied**: Review Zero Trust policies, user permissions
- [ ] **Build failures**: Check Node.js version, dependencies, environment variables

### Support Resources
- [ ] Jenkins documentation: [jenkins.io](https://www.jenkins.io/doc/)
- [ ] Cloudflare documentation: [developers.cloudflare.com](https://developers.cloudflare.com/)
- [ ] Project documentation: `docs/zero-trust-setup.md`
- [ ] Community support: GitHub issues, Cloudflare community

## Success Criteria

✅ **Setup is complete when:**
- [ ] Jenkins is accessible via `https://jenkins.yourdomain.com`
- [ ] Authentication works through Cloudflare Access
- [ ] CI/CD pipeline builds and deploys successfully
- [ ] All services are secured and monitored
- [ ] Documentation is updated with environment-specific details

## Post-Setup Tasks

- [ ] Train team members on accessing services
- [ ] Document environment-specific configurations
- [ ] Set up monitoring and alerting
- [ ] Plan disaster recovery procedures
- [ ] Schedule regular security reviews

---

**Estimated Setup Time**: 2-4 hours for experienced administrators
**Recommended Team Size**: 1-2 people (one for Jenkins, one for Cloudflare)
**Prerequisites Knowledge**: Basic Linux administration, DNS concepts, CI/CD principles