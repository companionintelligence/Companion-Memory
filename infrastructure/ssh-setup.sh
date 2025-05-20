#!/usr/bin/env bash
set -euo pipefail

# ─── CONFIGURE ME ──────────────────────────────────────────────────────────────
# You can override these by passing args: ./setup-ssh.sh USERNAME PORT
DEFAULT_USER="sshuser"
SSH_PORT="${2:-22}"
# ────────────────────────────────────────────────────────────────────────────────

# Determine username (first arg or default)
USERNAME="${1:-$DEFAULT_USER}"

# Ensure we’re root
if [[ "$(id -u)" -ne 0 ]]; then
  echo "❌ Please run as root: sudo $0" >&2
  exit 1
fi

# 1) Install and enable SSH server
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server

# 2) Optionally change SSH port
if [[ "$SSH_PORT" != "22" ]]; then
  sed -i "s/^#\?Port .*/Port $SSH_PORT/" /etc/ssh/sshd_config
fi

# 3) Create the user and set a random password
#    Requires openssl (installed by default on Ubuntu)
PASSWORD="$(openssl rand -base64 12)"
if id "$USERNAME" &>/dev/null; then
  echo "⚠️  User '$USERNAME' already exists, resetting its password."
else
  useradd -m -s /bin/bash "$USERNAME"
fi
echo "${USERNAME}:${PASSWORD}" | chpasswd

# 4) Ensure SSH daemon is running
systemctl enable ssh
systemctl restart ssh

# 5) Fetch the primary IP address
IP_ADDRESS="$(hostname -I | awk '{print $1}')"

# 6) Print out connection instructions
cat << EOF

✅ SSH setup complete!

To connect from your client machine:

    ssh -p ${SSH_PORT} ${USERNAME}@${IP_ADDRESS}

When prompted, use the password:

    ${PASSWORD}

EOF
