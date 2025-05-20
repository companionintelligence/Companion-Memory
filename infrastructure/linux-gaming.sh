#!/usr/bin/env bash
# Ubuntu 24.04 Gaming Setup - Steam, Proton, GPU drivers
# Run with:  sudo bash setup-gaming.sh
set -euo pipefail

###############################################################################
# 0.  Don't let root HOME confuse Steam paths - capture invoking user
###############################################################################
STEAM_USER=${SUDO_USER:-$USER}
STEAM_HOME="/home/${STEAM_USER}"

###############################################################################
# 1.  Repos, architecture & basic tools
###############################################################################
echo ">>> Enabling multiverse repo & 32-bit architecture"
add-apt-repository -y multiverse
dpkg --add-architecture i386

echo ">>> Updating package lists"
apt update

echo ">>> Installing common gaming utilities"
COMMON_PKGS=(
steam-launcher      # Steam itself (includes official Proton builds)
gamemode            # Feral Interactive's performance daemon
mangohud            # In-game FPS/metrics overlay
curl wget tar       # used later for Proton-GE
)
apt install -y "${COMMON_PKGS[@]}"

###############################################################################
# 2.  GPU-specific driver & Vulkan stack
###############################################################################
echo ">>> Detecting GPU vendor"
GPU_VENDOR=$(lspci -nnk | grep -EiA3 'VGA|3D' | grep 'Kernel driver' | head -n1 | awk '{print tolower($3)}')
echo "    Detected: $GPU_VENDOR"

case "$GPU_VENDOR" in
nvidia)
echo ">>> Installing NVIDIA proprietary driver + 32-bit libs"
apt install -y ubuntu-drivers-common
ubuntu-drivers autoinstall                # pulls in e.g. nvidia-driver-550
apt install -y libnvidia-gl-550:i386      # 32-bit OpenGL for Proton
;;
amd)
echo ">>> Installing Mesa & Vulkan for AMD"
apt install -y \
mesa-vulkan-drivers mesa-vulkan-drivers:i386 \
libgl1-mesa-dri libgl1-mesa-dri:i386
;;
intel)
echo ">>> Installing Mesa & Vulkan for Intel"
apt install -y \
mesa-vulkan-drivers mesa-vulkan-drivers:i386 \
libgl1-mesa-dri libgl1-mesa-dri:i386
;;
*)
echo ">>> GPU vendor not recognised - installing generic Mesa stack."
apt install -y mesa-utils
;;
esac

###############################################################################
# 3.  OPTIONAL - Proton-GE (latest community build)
###############################################################################
read -p "Download & install the latest Proton-GE build? [y/N] " -r REPLY
if [[ "$REPLY" =~ ^[Yy]$ ]]; then
echo ">>> Fetching Proton-GE tag from GitHub"
PROTON_GE_VERSION=$(curl -s https://api.github.com/repos/GloriousEggroll/proton-ge-custom/releases/latest \
| grep '"tag_name":' | cut -d '"' -f4)

echo ">>> Downloading Proton-${PROTON_GE_VERSION} (~1 GiB)"
mkdir -p /opt/proton-ge
curl -L "https://github.com/GloriousEggroll/proton-ge-custom/releases/download/${PROTON_GE_VERSION}/Proton-${PROTON_GE_VERSION}.tar.gz" \
| tar -xz -C /opt/proton-ge

# Register with the invoking user's Steam install
COMPAT_DIR="${STEAM_HOME}/.steam/root/compatibilitytools.d"
mkdir -p "$COMPAT_DIR"
ln -sfn "/opt/proton-ge/Proton-${PROTON_GE_VERSION}" \
"${COMPAT_DIR}/Proton-${PROTON_GE_VERSION}"

chown -R "${STEAM_USER}:${STEAM_USER}" /opt/proton-ge "$COMPAT_DIR"
echo ">>> Proton-GE installed. Select it per-game in Steam  Properties  Compatibility."
else
echo ">>> Skipping Proton-GE."
fi

###############################################################################
# 4.  All done
###############################################################################
echo -e "\n=== Setup complete! ==="
echo " Reboot is highly recommended to load new drivers."
echo " Launch Steam, log in, and enable proton per game as desired."
echo " For maximum performance, run games with:"
echo "    gamemoderun %command%"
echo "  or tick the GameMode box in Steam's per-game Launch Options helper."
echo "Enjoy your Ubuntu 24.04 gaming rig! "

)
