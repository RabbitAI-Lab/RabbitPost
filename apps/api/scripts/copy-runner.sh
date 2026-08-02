#!/bin/bash
# 复制 Runner 二进制到 API 目录，供内嵌 Runner 使用
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNNER_DIR="$API_DIR/../runner"
RUNNER_BINARY="$RUNNER_DIR/target/release/rabbitpost-runner"
TARGET_BINARY="$API_DIR/rabbitpost-runner"

# 检查 Runner 是否已构建
if [ ! -f "$RUNNER_BINARY" ]; then
    echo "Runner binary not found at $RUNNER_BINARY"
    echo "Please build runner first: cd apps/runner && cargo build --release"
    exit 1
fi

# 复制二进制
cp "$RUNNER_BINARY" "$TARGET_BINARY"
chmod +x "$TARGET_BINARY"

echo "Runner binary copied to $TARGET_BINARY"
