#!/usr/bin/env bash
# Installs the release build of Flight Deck into the current user's app menu
# (no sudo). Re-run after `npx tauri build --no-bundle` to update.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_SRC="$ROOT/src-tauri/target/release/flight-deck"
ICONS="$ROOT/src-tauri/icons"
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"

[ -x "$BIN_SRC" ] || { echo "Build first: npx tauri build --no-bundle" >&2; exit 1; }

install -Dm755 "$BIN_SRC" "$HOME/.local/bin/flight-deck"

install -Dm644 "$ICONS/32x32.png"      "$DATA/icons/hicolor/32x32/apps/flight-deck.png"
install -Dm644 "$ICONS/64x64.png"      "$DATA/icons/hicolor/64x64/apps/flight-deck.png"
install -Dm644 "$ICONS/128x128.png"    "$DATA/icons/hicolor/128x128/apps/flight-deck.png"
install -Dm644 "$ICONS/128x128@2x.png" "$DATA/icons/hicolor/256x256/apps/flight-deck.png"
install -Dm644 "$ICONS/icon.png"       "$DATA/icons/hicolor/512x512/apps/flight-deck.png"
install -Dm644 "$ROOT/assets/logo.svg" "$DATA/icons/hicolor/scalable/apps/flight-deck.svg"

cat > "$DATA/applications/flight-deck.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Flight Deck
Comment=Personal developer dashboard
Exec=$HOME/.local/bin/flight-deck
Icon=flight-deck
Terminal=false
Categories=Development;
StartupWMClass=flight-deck
DESKTOP

gtk-update-icon-cache -q "$DATA/icons/hicolor" 2>/dev/null || true
update-desktop-database -q "$DATA/applications" 2>/dev/null || true
echo "Installed. Search for \"Flight Deck\" in your app launcher."
