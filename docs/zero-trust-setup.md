# Cloudflare Zero Trust Setup Guide

This guide walks you through setting up Cloudflare Zero Trust for secure access to your Jenkins and CI-Server deployment through Cloudflared tunnels.

## Overview

Cloudflare Zero Trust provides secure, authenticated access to your applications without exposing them directly to the internet. Combined with Cloudflared tunnels, it creates a secure, encrypted connection between your local services and Cloudflare's edge network.

## Prerequisites

- Cloudflare account
- Domain managed by Cloudflare
- Cloudflared installed and configured
- Jenkins and CI-Server running locally

## Step 1: Set Up Cloudflare Zero Trust

### 1.1 Access Zero Trust Dashboard

1. Go to [https://one.dash.cloudflare.com/](https://one.dash.cloudflare.com/)
2. Log in with your Cloudflare account
3. If this is your first time, you'll be prompted to set up Zero Trust

### 1.2 Choose a Plan

- **Free Plan**: Up to 50 users, basic features
- **Teams Plan**: $3/user/month, advanced features
- **Enterprise**: Custom pricing, full features

For development purposes, the Free plan is usually sufficient.

### 1.3 Configure Team Domain

1. Choose a team name (this becomes part of your authentication URL)
2. This will create a URL like: `https://yourteam.cloudflareaccess.com`

## Step 2: Configure DNS

### 2.1 Add DNS Records

In your Cloudflare DNS dashboard, add CNAME records for your services:

```
jenkins.yourdomain.com -> YOUR_TUNNEL_ID.cfargotunnel.com
app.yourdomain.com -> YOUR_TUNNEL_ID.cfargotunnel.com
dev.yourdomain.com -> YOUR_TUNNEL_ID.cfargotunnel.com
```

**Important**: Set these records to "Proxied" (orange cloud) to enable Cloudflare's security features.

### 2.2 Verify DNS Configuration

Use `dig` or online DNS tools to verify your records:

```bash
dig jenkins.yourdomain.com
```

## Step 3: Create Access Applications

### 3.1 Navigate to Access Applications

1. In Zero Trust dashboard, go to **Access** > **Applications**
2. Click **Add an application**
3. Choose **Self-hosted**

### 3.2 Configure Jenkins Application

**Application Configuration:**
- **Application name**: Jenkins CI/CD
- **Application domain**: `jenkins.yourdomain.com`
- **Application type**: Self-hosted
- **Session duration**: 24 hours (or as preferred)

**Authentication:**
- Click **Next** to configure policies

### 3.3 Create Access Policy

**Policy Configuration:**
- **Policy name**: Jenkins Access Policy
- **Action**: Allow
- **Session duration**: 24 hours

**Include rules** (choose one or more):
- **Emails**: Add specific email addresses
- **Email domains**: Add your organization's email domain
- **Country**: Restrict by geographical location
- **IP ranges**: Restrict by IP address

**Example Include Rule:**
```
Rule type: Include
Selector: Email domains
Value: yourcompany.com
```

### 3.4 Repeat for Other Applications

Create similar applications for:
- **CI-Server App**: `app.yourdomain.com`
- **Development Environment**: `dev.yourdomain.com`

## Step 4: Configure Identity Providers (Optional)

### 4.1 Add Identity Provider

1. Go to **Settings** > **Authentication**
2. Click **Add new** under Login methods
3. Choose your preferred provider:
   - **One-time PIN**: Email-based authentication
   - **Google**: Google Workspace or Gmail
   - **Microsoft**: Azure AD
   - **GitHub**: GitHub authentication
   - **SAML**: Custom SAML provider

### 4.2 Configure Provider Settings

Follow the provider-specific instructions. For example, for Google:

1. Create OAuth credentials in Google Cloud Console
2. Add authorized redirect URI: `https://yourteam.cloudflareaccess.com/cdn-cgi/access/callback`
3. Enter Client ID and Client Secret in Cloudflare

## Step 5: Test Access

### 5.1 Access Your Applications

1. Navigate to `https://jenkins.yourdomain.com`
2. You should be redirected to Cloudflare Access login
3. Authenticate using your configured method
4. You should be redirected to Jenkins

### 5.2 Verify Security

- Test access from different browsers/incognito mode
- Verify unauthorized users cannot access
- Check audit logs in Zero Trust dashboard

## Step 6: Advanced Configuration

### 6.1 Custom Block Page

Create a custom access denied page:

1. Go to **Settings** > **Custom pages**
2. Upload custom HTML for block page
3. Configure branding and messaging

### 6.2 Session Management

Configure session settings:

1. Go to **Settings** > **Authentication**
2. Set global session duration
3. Configure idle timeout
4. Set up session revocation

### 6.3 Audit Logs

Monitor access:

1. Go to **Logs** > **Access requests**
2. Review authentication logs
3. Set up log forwarding if needed
4. Configure alerts for suspicious activity

## Step 7: Security Best Practices

### 7.1 Principle of Least Privilege

- Create specific policies for different user groups
- Use time-based access restrictions
- Implement conditional access based on device state

### 7.2 Multi-Factor Authentication

- Enable MFA for all users
- Use hardware security keys when possible
- Configure backup authentication methods

### 7.3 Regular Auditing

- Review access policies monthly
- Monitor authentication logs
- Update user access as needed
- Remove inactive users

### 7.4 Device Compliance

- Configure device trust policies
- Require managed devices for sensitive access
- Implement device certificates

## Troubleshooting

### Common Issues

**DNS Resolution Problems:**
```bash
# Check DNS propagation
dig jenkins.yourdomain.com
nslookup jenkins.yourdomain.com
```

**Tunnel Connectivity:**
```bash
# Check tunnel status
cloudflared tunnel info your-tunnel-name

# Test tunnel connectivity
cloudflared tunnel --url http://localhost:8080
```

**Access Policy Issues:**
- Verify email domains in policies
- Check policy order (more specific first)
- Test with different browsers
- Clear browser cache and cookies

**Certificate Issues:**
- Ensure DNS records are proxied (orange cloud)
- Wait for certificate provisioning (up to 15 minutes)
- Check certificate status in SSL/TLS dashboard

### Log Analysis

**Cloudflared Logs:**
```bash
# System service logs
journalctl --user -u cloudflared.service -f

# Manual tunnel logs
cloudflared tunnel --loglevel debug run
```

**Zero Trust Logs:**
- Access request logs in dashboard
- Authentication events
- Policy evaluation results

## References

- [Cloudflare Zero Trust Documentation](https://developers.cloudflare.com/cloudflare-one/)
- [Cloudflared Tunnel Documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
- [Access Policy Configuration](https://developers.cloudflare.com/cloudflare-one/policies/access/)
- [Identity Provider Setup](https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/)

## Support

For issues and questions:

1. Check Cloudflare Community: [https://community.cloudflare.com/](https://community.cloudflare.com/)
2. Cloudflare Support: [https://support.cloudflare.com/](https://support.cloudflare.com/)
3. Documentation: [https://developers.cloudflare.com/](https://developers.cloudflare.com/)

## Security Considerations

- Keep tunnel credentials secure and rotate regularly
- Monitor access logs for suspicious activity
- Use strong authentication methods
- Implement device compliance policies
- Regular security audits and policy reviews
- Keep Cloudflared updated to latest version