#!/usr/bin/env bash
set -euo pipefail

#----------------------------------------
# Configuration
#----------------------------------------
USER_NAME=${SUDO_USER:-$USER}
CODENAME=$(lsb_release -cs)

# Docker Desktop DEB URL
DOCKER_DEB_URL="https://desktop.docker.com/linux/main/amd64/docker-desktop-amd64.deb"

# AMDGPU installer version (update as needed)
AMDGPU_DEB_VERSION="6.4.60400-1"
AMDGPU_INSTALL_DEB="amdgpu-install_${AMDGPU_DEB_VERSION}_all.deb"
AMDGPU_URL="https://repo.radeon.com/amdgpu-install/6.4/ubuntu/${CODENAME}/${AMDGPU_INSTALL_DEB}"

#----------------------------------------
# 1. Update & prerequisites
#----------------------------------------
echo "=> Updating APT and installing prerequisites..."
apt-get update
apt-get install -y \
  apt-transport-https \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  software-properties-common \
  wget \
  gnome-terminal

#----------------------------------------
# 2. Install Docker Desktop
#----------------------------------------
echo "=> Installing Docker Desktop..."
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

cat > /etc/apt/sources.list.d/docker.list <<EOF
deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu \
${CODENAME} stable
EOF

apt-get update
curl -L -o docker-desktop.deb "${DOCKER_DEB_URL}"
apt-get install -y ./docker-desktop.deb
rm docker-desktop.deb

# Add your user to 'docker' group to run without sudo
usermod -aG docker "${USER_NAME}"

#----------------------------------------
# 3. Install Ollama
#----------------------------------------
echo "=> Installing Ollama..."
curl -fsSL https://ollama.com/install.sh | sh

#----------------------------------------
# 4. Install latest Python (3.12)
#----------------------------------------
echo "=> Installing Python 3.12..."
add-apt-repository ppa:deadsnakes/ppa -y
apt-get update
apt-get install -y python3.12 python3.12-venv python3.12-dev python3-pip
update-alternatives --install /usr/bin/python3 python3 /usr/bin/python3.12 2

#----------------------------------------
# 5. Install AMD ROCm (AMDGPU stack)
#----------------------------------------
echo "=> Installing AMD ROCm..."
# Keyring for ROCm
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://repo.radeon.com/rocm/rocm.gpg.key \
  | gpg --dearmor | tee /etc/apt/keyrings/rocm.gpg > /dev/null

# Download & install the AMDGPU installer
wget -q "${AMDGPU_URL}"
apt-get install -y ./"${AMDGPU_INSTALL_DEB}"
rm "${AMDGPU_INSTALL_DEB}"

# Now install ROCm usecase
apt-get update
amdgpu-install --usecase=rocm --accept-eula -y

# Add your user to render & video groups for GPU access
usermod -aG render,video "${USER_NAME}"

#----------------------------------------
echo "✅ CI SERVER SETUP DONE! ✅"
echo "Please reboot to finalize."
