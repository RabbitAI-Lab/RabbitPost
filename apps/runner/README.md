# RabbitPost Runner CLI

Runner CLI 是常驻在自有机器上的执行器（Rust 实现），向服务端领取「Runner 管理」派发的
任务并回传结果；内网 / 专线环境的接口因此也能跑通。

提供两个子命令：

- `serve`：常驻进程，轮询领取服务端派发的任务（单个请求或整个 Collection），
  并发执行后把逐请求结果回传，管理页可实时看到进度。这是 Runner CLI 的主用法。
- `run`：在本机一次性执行指定 Collection / 请求，只打印结果不写服务端任务记录，
  用退出码表达成败，适合接入 CI。

> 注意：Runner CLI 与规划中的 RabbitPost CLI 是两个独立的程序 —— 前者由服务端派发驱动、
> 常驻运行，后者由使用者在本机主动调用。当前尚未提供独立的 `rabbitpost` 二进制，
> 需要一次性执行时先用上面的 `run` 子命令。

## 安装

### 预编译包（推荐）

[runner-latest Release](https://github.com/RabbitAI-Lab/RabbitPost/releases/tag/runner-latest)
提供五个平台的 zip 包（已保留可执行位，解压即用，每个包附带同名 `.sha256` 校验文件）：

| 平台 | 包 |
| --- | --- |
| macOS Apple Silicon | `rabbitpost-runner-macos-arm64.zip` |
| macOS Intel | `rabbitpost-runner-macos-x64.zip` |
| Linux x86_64（glibc ≥ 2.35） | `rabbitpost-runner-linux-x64.zip` |
| Linux ARM64（glibc ≥ 2.35） | `rabbitpost-runner-linux-arm64.zip` |
| Windows x86_64 | `rabbitpost-runner-windows-x64.zip` |

预编译包由 `.github/workflows/runner-release.yml` 构建：推送 `runner-v*` tag 时产出带版本号的
Release 并刷新 `runner-latest`；也可在 Actions 页手动 dispatch 刷新。

> macOS 包未签名，首次运行前执行 `xattr -d com.apple.quarantine /usr/local/bin/rabbitpost-runner`。

### 从源码构建

```bash
# 方式一：安装到 ~/.cargo/bin，之后可直接使用 rabbitpost-runner 命令
cargo install --path apps/runner

# 方式二：仅在仓库内构建（产物 apps/runner/target/release/rabbitpost-runner）
pnpm runner:build
```

## 注册与启动

1. 在 Web 端以团队 owner / admin 身份打开右上角 **CLI → Runner CLI**，在「Runner 管理」
   标签页注册一个 Runner，拿到形如 `rpr_...` 的 Token（仅显示一次，丢失后可「重新生成 Token」）。
2. 在目标机器上启动：

```bash
rabbitpost-runner serve \
  --server https://rabbitpost.example.com \
  --token rpr_xxx \
  --concurrency 8
```

参数也可用环境变量提供：`RABBITPOST_SERVER`、`RABBITPOST_RUNNER_TOKEN`。

## CI 用法

```bash
rabbitpost-runner run \
  --server https://rabbitpost.example.com \
  --token rpr_xxx \
  --collection <COLLECTION_ID> \
  --env <ENVIRONMENT_ID> \
  --concurrency 8
```

退出码：`0` 全部成功，`1` 存在失败请求，`2` 参数 / 鉴权 / 网络配置错误。

## 与服务端的分工

| 环节 | 责任方 |
| --- | --- |
| 目标展开（Collection → 请求列表）、环境变量解析 | 服务端（`/api/v1/runner/jobs/claim`、`/api/v1/runner/expand`） |
| `{{var}}` 替换、组装、发送、计时 | Runner |
| 结果落库与进度统计 | 服务端（`/results`、`/complete`） |

并发模型：任务自带 `concurrency`，Runner 侧再用 `--concurrency` 作为本机上限，
取两者较小值作为信号量许可数；结果通过 channel 攒批（20 条或 500ms）上报，
计数在服务端以 SQL 自增完成，因此多协程并发上报不会互相覆盖。
多个 Runner 同时拉取任务时，服务端用 `FOR UPDATE SKIP LOCKED` 保证一个任务只被领取一次。

## 已知边界

- 请求脚本（pre-request / test）由内置 QuickJS 沙箱执行，提供 rp.environment / rp.variables /
  rp.request / rp.response / rp.test / rp.expect / console（pm 为兼容别名）；断言失败等价于用例失败。
- Auth 目前支持 `none` / `basic` / `bearer` / `api-key`；其余类型会明确报错而不是降级为匿名请求。
- Settings 中的 `verifySsl` / `followRedirects` / `maxRedirects` / `timeoutMs` 生效，
  TLS 协议版本与 cipher suite 等精细选项暂未支持。
- `serve` 执行任务过程中被 Ctrl-C 中断时，该任务会停留在「执行中」，需在管理页手动取消。

## 测试

执行引擎与脚本沙箱位于 `crates/rp-core`（Runner 与后续 RabbitPost CLI 共用），测试也分两层：

```bash
# rp-core 单元测试：模型契约 / {{var}} 替换 / 信封解析 / QuickJS 沙箱 / HTTP 执行（wiremock 起真实本地服务）
cargo test --manifest-path crates/rp-core/Cargo.toml

# runner 端到端 CLI 测试：真实二进制 + mock 服务端，覆盖 run / serve 全流程与退出码
cargo test --manifest-path apps/runner/Cargo.toml

# 或一次跑全部
pnpm runner:test
```

测试约定：

- 单元测试放在各模块末尾的 `#[cfg(test)] mod tests`，HTTP 相关用例一律走 wiremock 本地服务，
  不打外网、不依赖本机环境；
- 端到端测试在 `apps/runner/tests/`，用 assert_cmd 驱动真实二进制，锁定退出码
  （0 全成功 / 1 有失败请求 / 2 参数或鉴权错误）与上报内容；
- CI 见 `.github/workflows/runner-test.yml`：push / PR 涉及 `apps/runner` 或 `crates/rp-core`
  时自动执行 cargo test（--locked）与 clippy（-D warnings），两个 Cargo.lock 已随仓库提交。
