#!/usr/bin/env bash
set -euo pipefail

# AfterEdit build script
# Usage: ./build.sh [dev|release|bundle]
#   dev     - Build debug version (default)
#   release - Build optimized release version
#   bundle  - Build and create distributable bundles (.dmg, .app, etc.)

MODE="${1:-dev}"
PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; exit 1; }

# Check required tools
check_deps() {
    info "Checking dependencies..."

    command -v node >/dev/null 2>&1 || error "Node.js is required but not installed"
    command -v npm >/dev/null 2>&1 || error "npm is required but not installed"
    command -v cargo >/dev/null 2>&1 || error "Rust/Cargo is required but not installed"
    command -v rustc >/dev/null 2>&1 || error "rustc is required but not installed"

    info "Node: $(node --version)"
    info "npm: $(npm --version)"
    info "Rust: $(rustc --version)"
    info "Cargo: $(cargo --version)"
}

# Install npm dependencies if needed
install_deps() {
    if [[ ! -d "$PROJECT_DIR/node_modules" ]]; then
        info "Installing npm dependencies..."
        npm ci
    elif [[ "$PROJECT_DIR/package.json" -nt "$PROJECT_DIR/node_modules" ]]; then
        info "package.json changed, updating dependencies..."
        npm ci
    else
        info "Dependencies up to date"
    fi
}

# Build frontend
build_frontend() {
    info "Building frontend (TypeScript + Vite)..."
    npm run build
}

# Build Tauri app
build_tauri() {
    local tauri_args=()

    case "$MODE" in
        dev)
            info "Building Tauri app (debug)..."
            tauri_args+=("--debug")
            ;;
        release|bundle)
            info "Building Tauri app (release)..."
            # Release is the default, no extra flags needed
            ;;
        *)
            error "Unknown mode: $MODE (use dev, release, or bundle)"
            ;;
    esac

    if [[ "$MODE" == "bundle" ]]; then
        npm run tauri build "${tauri_args[@]}" --bundles all
    else
        npm run tauri build "${tauri_args[@]}"
    fi
}

# Print build artifacts location
show_artifacts() {
    local target_dir="$PROJECT_DIR/src-tauri/target"

    echo ""
    info "Build complete!"

    case "$MODE" in
        dev)
            info "Debug binary: $target_dir/debug/afteredit"
            ;;
        release)
            info "Release binary: $target_dir/release/afteredit"
            ;;
        bundle)
            info "Bundles location: $target_dir/release/bundle/"
            if [[ -d "$target_dir/release/bundle" ]]; then
                find "$target_dir/release/bundle" -maxdepth 2 -type f \( -name "*.dmg" -o -name "*.app" -o -name "*.deb" -o -name "*.AppImage" -o -name "*.msi" \) 2>/dev/null | while read -r bundle; do
                    info "  $(basename "$bundle")"
                done
            fi
            ;;
    esac
}

# Main
main() {
    cd "$PROJECT_DIR"

    echo ""
    info "AfterEdit Build Script"
    info "Mode: $MODE"
    echo ""

    check_deps
    install_deps
    build_frontend
    build_tauri
    show_artifacts
}

main "$@"
