#!/usr/bin/env bash
# rabbitpost CLI 全平台打包：
# 交叉编译 6 个目标平台，产物与 manifest.json 输出到 apps/api/public/cli/v<version>/，
# 由 API 的 /api/v1/cli/artifacts 路由对外提供下载。
#
# 依赖：
#   - rustup stable toolchain（所有目标统一用它构建）
#   - macOS 目标：rustup target add x86_64-apple-darwin
#   - Linux 目标：brew install zig + cargo install cargo-zigbuild
#   - Windows 目标：cargo install cargo-xwin（首次构建自动下载 MSVC SDK）
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI_DIR="$ROOT/apps/cli"
VERSION="$(sed -n 's/^version = "\(.*\)"/\1/p' "$CLI_DIR/Cargo.toml" | head -1)"
OUT="$ROOT/apps/api/public/cli/v$VERSION"
mkdir -p "$OUT"

# 统一使用 rustup stable（brew 的 rustc 无法安装额外 target）。
# 必须把 toolchain 的 bin 目录前置到 PATH：rustup 代理不会改写 cargo 对
# `rustc` 的 PATH 查找，若 PATH 里 homebrew 的 rustc 在前会报 E0463。
export RUSTUP_TOOLCHAIN="${RUSTUP_TOOLCHAIN:-stable}"
HOST_TRIPLE="$(rustup show active-toolchain | cut -d' ' -f1 | sed "s/^${RUSTUP_TOOLCHAIN}-//")"
TOOLCHAIN_BIN="$(rustup show home)/toolchains/${RUSTUP_TOOLCHAIN}-${HOST_TRIPLE}/bin"
export PATH="$TOOLCHAIN_BIN:$PATH"
export RUSTC="$TOOLCHAIN_BIN/rustc"
# 幂等补齐全部目标平台的 rust-std
rustup target add \
  x86_64-apple-darwin \
  x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu \
  x86_64-pc-windows-msvc aarch64-pc-windows-msvc >/dev/null
command -v zig >/dev/null || { echo "[package] zig not found: brew install zig"; exit 1; }
command -v cargo-zigbuild >/dev/null || { echo "[package] cargo-zigbuild not found: cargo install --locked cargo-zigbuild"; exit 1; }
command -v cargo-xwin >/dev/null || { echo "[package] cargo-xwin not found: cargo install --locked cargo-xwin"; exit 1; }

log() { echo "[package] $*"; }

build_cargo() { # $1 target  $2 asset name
  log "build $1 -> $2"
  (cd "$CLI_DIR" && cargo build --release --locked --target "$1")
  cp "$CLI_DIR/target/$1/release/rabbitpost${3:-}" "$OUT/$2"
}

build_zig() { # $1 target  $2 asset name
  log "zigbuild $1 -> $2"
  (cd "$CLI_DIR" && cargo zigbuild --release --locked --target "$1")
  cp "$CLI_DIR/target/$1/release/rabbitpost" "$OUT/$2"
}

build_xwin() { # $1 target  $2 asset name(.exe)
  log "xwin build $1 -> $2"
  (cd "$CLI_DIR" && cargo xwin build --release --locked --target "$1")
  cp "$CLI_DIR/target/$1/release/rabbitpost.exe" "$OUT/$2"
}

# macOS
build_cargo aarch64-apple-darwin rabbitpost-macos-arm64
build_cargo x86_64-apple-darwin rabbitpost-macos-x64
# Linux（zig cc 交叉链接，兼容 glibc）
build_zig x86_64-unknown-linux-gnu rabbitpost-linux-x64
build_zig aarch64-unknown-linux-gnu rabbitpost-linux-arm64
# Windows（xwin 提供 MSVC 交叉环境）
# 注：windows-arm64 暂缺——rquickjs-sys 0.9 未附带 aarch64-pc-windows-msvc 的
# 预生成 bindings（需 bindgen 重新生成），且 ring 在交叉时需要真实 clang-cl；
# 后续可用 rquickjs bindgen + LLVM 补齐（ARM 平台已由 macOS/Linux arm64 覆盖）。
build_xwin x86_64-pc-windows-msvc rabbitpost-windows-x64.exe

# 校验和与清单
log "write manifest.json"
cd "$OUT"
for f in rabbitpost-*; do
  shasum -a 256 "$f" > "$f.sha256"
done

node - "$OUT" <<'EOF'
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const out = process.argv[2];
const version = path.basename(out).replace(/^v/, "");
const META = {
  "rabbitpost-macos-arm64": ["macos", "arm64", "aarch64-apple-darwin"],
  "rabbitpost-macos-x64": ["macos", "x64", "x86_64-apple-darwin"],
  "rabbitpost-linux-x64": ["linux", "x64", "x86_64-unknown-linux-gnu"],
  "rabbitpost-linux-arm64": ["linux", "arm64", "aarch64-unknown-linux-gnu"],
  "rabbitpost-windows-x64.exe": ["windows", "x64", "x86_64-pc-windows-msvc"],
  "rabbitpost-windows-arm64.exe": ["windows", "arm64", "aarch64-pc-windows-msvc"],
};
const artifacts = Object.entries(META)
  .filter(([file]) => fs.existsSync(path.join(out, file)))
  .map(([file, [os, arch, target]]) => {
    const buf = fs.readFileSync(path.join(out, file));
    return {
      file,
      os,
      arch,
      target,
      size: buf.length,
      sha256: crypto.createHash("sha256").update(buf).digest("hex"),
    };
  });
fs.writeFileSync(
  path.join(out, "manifest.json"),
  JSON.stringify({ version, generatedAt: new Date().toISOString(), artifacts }, null, 2) + "\n",
);
console.log(`[package] ${artifacts.length} artifacts -> ${out}`);
EOF
