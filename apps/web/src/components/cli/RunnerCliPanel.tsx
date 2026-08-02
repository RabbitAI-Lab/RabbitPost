import {
  AppleOutlined,
  DownloadOutlined,
  LinuxOutlined,
  WindowsOutlined,
} from "@ant-design/icons";
import { Alert, Button, Collapse, Steps, Table, Tag, Typography } from "antd";
import CommandBlock from "./CommandBlock";

const { Paragraph, Text, Title } = Typography;

const REPO_URL = "https://github.com/RabbitAI-Lab/RabbitPost.git";
/** 预编译包固定指向 runner-latest 滚动 Release（由 runner-release 工作流维护） */
const RELEASE_BASE =
  "https://github.com/RabbitAI-Lab/RabbitPost/releases/download/runner-latest";

type OsKind = "macos" | "linux" | "windows";
type ArchKind = "arm64" | "x64";

const OS_META: Record<OsKind, { label: string; icon: React.ReactNode }> = {
  macos: { label: "macOS", icon: <AppleOutlined /> },
  linux: { label: "Linux", icon: <LinuxOutlined /> },
  windows: { label: "Windows", icon: <WindowsOutlined /> },
};

/** 从 UA 推测当前平台；架构不确定时返回 null（不高亮推荐） */
function detectPlatform(): { os: OsKind; arch: ArchKind } | null {
  const ua = navigator.userAgent;
  const os: OsKind | null = /Windows/i.test(ua)
    ? "windows"
    : /Mac OS X|Macintosh/i.test(ua)
      ? "macos"
      : /Linux/i.test(ua)
        ? "linux"
        : null;
  if (!os) return null;
  if (/arm64|aarch64/i.test(ua)) return { os, arch: "arm64" };
  if (/x86_64|x64|intel/i.test(ua)) return { os, arch: "x64" };
  return null;
}

interface PlatformDownload {
  os: OsKind;
  arch: ArchKind;
  file: string;
  note?: string;
  /** 安装命令（多行）；Windows 用 PowerShell */
  install: string;
}

const DOWNLOADS: PlatformDownload[] = [
  {
    os: "macos",
    arch: "arm64",
    file: "rabbitpost-runner-macos-arm64.zip",
    install: `curl -fSL -o rabbitpost-runner.zip ${RELEASE_BASE}/rabbitpost-runner-macos-arm64.zip
unzip rabbitpost-runner.zip
sudo mv rabbitpost-runner /usr/local/bin/
# 经浏览器下载 + Finder 解压时，首次运行前需解除 Gatekeeper 隔离
xattr -d com.apple.quarantine /usr/local/bin/rabbitpost-runner`,
  },
  {
    os: "macos",
    arch: "x64",
    file: "rabbitpost-runner-macos-x64.zip",
    install: `curl -fSL -o rabbitpost-runner.zip ${RELEASE_BASE}/rabbitpost-runner-macos-x64.zip
unzip rabbitpost-runner.zip
sudo mv rabbitpost-runner /usr/local/bin/
# 经浏览器下载 + Finder 解压时，首次运行前需解除 Gatekeeper 隔离
xattr -d com.apple.quarantine /usr/local/bin/rabbitpost-runner`,
  },
  {
    os: "linux",
    arch: "x64",
    file: "rabbitpost-runner-linux-x64.zip",
    note: "glibc ≥ 2.35（Ubuntu 22.04+ / Debian 12+ 等）",
    install: `curl -fSL -o rabbitpost-runner.zip ${RELEASE_BASE}/rabbitpost-runner-linux-x64.zip
unzip rabbitpost-runner.zip
sudo mv rabbitpost-runner /usr/local/bin/`,
  },
  {
    os: "linux",
    arch: "arm64",
    file: "rabbitpost-runner-linux-arm64.zip",
    note: "glibc ≥ 2.35，适用于 ARM 服务器 / 树莓派 64 位系统",
    install: `curl -fSL -o rabbitpost-runner.zip ${RELEASE_BASE}/rabbitpost-runner-linux-arm64.zip
unzip rabbitpost-runner.zip
sudo mv rabbitpost-runner /usr/local/bin/`,
  },
  {
    os: "windows",
    arch: "x64",
    file: "rabbitpost-runner-windows-x64.zip",
    note: "PowerShell 中执行；首次运行如被 SmartScreen 拦截，选「仍要运行」",
    install: `Invoke-WebRequest -Uri ${RELEASE_BASE}/rabbitpost-runner-windows-x64.zip -OutFile rabbitpost-runner.zip
Expand-Archive rabbitpost-runner.zip -DestinationPath .
.\rabbitpost-runner.exe --version`,
  },
];

/**
 * Runner CLI 安装引导：优先下载预编译包（无需 Rust 工具链），
 * 预编译包由 runner-release 工作流发布到 runner-latest Release。
 */
export default function RunnerCliPanel() {
  const origin = window.location.origin;
  const detected = detectPlatform();
  const recommended = detected
    ? DOWNLOADS.find((d) => d.os === detected.os && d.arch === detected.arch)
    : undefined;

  return (
    <div style={{ maxWidth: 880 }}>
      <Alert
        type="info"
        showIcon
        title="Runner CLI 是什么"
        description="部署在你自己机器（构建机 / 内网跳板机）上的常驻执行程序：向本服务轮询领取「Runner 管理」里派发的任务，在本地并发发送请求，再把逐请求结果回传。因此内网地址、专线环境的接口也能跑通。"
        style={{ marginBottom: 20 }}
      />

      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <Title level={5} style={{ margin: 0, flex: 1 }}>
          下载（推荐，无需构建）
        </Title>
        {recommended && (
          <Button
            type="primary"
            size="small"
            icon={<DownloadOutlined />}
            href={`${RELEASE_BASE}/${recommended.file}`}
            target="_blank"
          >
            下载 {OS_META[recommended.os].label} {recommended.arch}
          </Button>
        )}
      </div>
      <Paragraph type="secondary" style={{ marginBottom: 12 }}>
        下载 zip 解压即可使用（已保留可执行位，无需 chmod）；每个包附带同名{" "}
        <Text code>.sha256</Text> 校验文件。点击行左侧箭头展开查看安装命令。
      </Paragraph>
      <Table<PlatformDownload>
        size="small"
        rowKey="file"
        dataSource={DOWNLOADS}
        pagination={false}
        style={{ marginBottom: 8 }}
        expandable={{
          expandedRowRender: (d) => <CommandBlock multiline command={d.install} />,
          defaultExpandedRowKeys: recommended ? [recommended.file] : [],
        }}
        columns={[
          {
            title: "平台",
            width: 200,
            render: (_, d) => (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {OS_META[d.os].icon}
                {OS_META[d.os].label} · {d.arch}
                {recommended?.file === d.file && <Tag color="orange">当前设备</Tag>}
              </span>
            ),
          },
          {
            title: "文件",
            dataIndex: "file",
            render: (file: string) => <Text code>{file}</Text>,
          },
          {
            title: "说明",
            dataIndex: "note",
            render: (note?: string) =>
              note ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {note}
                </Text>
              ) : (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  -
                </Text>
              ),
          },
          {
            title: "操作",
            width: 90,
            render: (_, d) => (
              <Button
                type="link"
                size="small"
                icon={<DownloadOutlined />}
                href={`${RELEASE_BASE}/${d.file}`}
                target="_blank"
              >
                下载
              </Button>
            ),
          },
        ]}
      />
      <Paragraph type="secondary" style={{ marginBottom: 20 }}>
        校验完整性：下载同名 <Text code>.sha256</Text> 后执行
        <Text code> shasum -a 256 -c rabbitpost-runner-*.zip.sha256</Text>。
      </Paragraph>

      <Collapse
        size="small"
        style={{ marginBottom: 20 }}
        items={[
          {
            key: "source",
            label: "从源码构建（备选）",
            children: (
              <Steps
                orientation="vertical"
                size="small"
                current={-1}
                items={[
                  {
                    title: "准备 Rust 工具链",
                    content: (
                      <div style={{ paddingTop: 4 }}>
                        <Paragraph type="secondary" style={{ marginBottom: 8 }}>
                          Runner CLI 由 Rust 编写，需要 1.75 以上的工具链；已安装可跳过。
                        </Paragraph>
                        <CommandBlock command="curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh" />
                      </div>
                    ),
                  },
                  {
                    title: "获取源码",
                    content: (
                      <div style={{ paddingTop: 4 }}>
                        <CommandBlock multiline command={`git clone ${REPO_URL}\ncd RabbitPost`} />
                      </div>
                    ),
                  },
                  {
                    title: "编译并安装到 PATH",
                    content: (
                      <div style={{ paddingTop: 4 }}>
                        <Paragraph type="secondary" style={{ marginBottom: 8 }}>
                          安装到 ~/.cargo/bin，之后可直接使用 rabbitpost-runner 命令。
                        </Paragraph>
                        <CommandBlock command="cargo install --path apps/runner" />
                        <Paragraph type="secondary" style={{ margin: "8px 0" }}>
                          只想在仓库内构建、不装进 PATH 的话：
                        </Paragraph>
                        <CommandBlock command="pnpm runner:build" />
                        <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
                          产物路径：apps/runner/target/release/rabbitpost-runner
                        </Paragraph>
                      </div>
                    ),
                  },
                  {
                    title: "验证安装",
                    content: (
                      <div style={{ paddingTop: 4 }}>
                        <CommandBlock command="rabbitpost-runner --version" />
                      </div>
                    ),
                  },
                ]}
              />
            ),
          },
        ]}
      />

      <Title level={5}>启动</Title>
      <Paragraph type="secondary" style={{ marginBottom: 8 }}>
        Token 在「Runner 管理」标签页注册 Runner 时生成，仅显示一次；丢失后可重新生成。
      </Paragraph>
      <CommandBlock
        multiline
        command={`rabbitpost-runner serve \\
  --server ${origin} \\
  --token <RUNNER_TOKEN> \\
  --concurrency 8`}
      />
      <Paragraph type="secondary" style={{ marginTop: 8 }}>
        参数也可用环境变量提供：<Text code>RABBITPOST_SERVER</Text>、
        <Text code>RABBITPOST_RUNNER_TOKEN</Text>。启动后「Runner 管理」里该 Runner
        会在一分钟内变为「在线」。
      </Paragraph>

      <Title level={5} style={{ marginTop: 20 }}>
        作为服务常驻（Linux systemd）
      </Title>
      <CommandBlock
        multiline
        command={`# /etc/systemd/system/rabbitpost-runner.service
[Unit]
Description=RabbitPost Runner
After=network-online.target

[Service]
Environment=RABBITPOST_SERVER=${origin}
Environment=RABBITPOST_RUNNER_TOKEN=<RUNNER_TOKEN>
ExecStart=/usr/local/bin/rabbitpost-runner serve --concurrency 8
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target`}
      />
      <Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
        写好后执行 <Text code>systemctl enable --now rabbitpost-runner</Text>；
        日志用 <Text code>journalctl -u rabbitpost-runner -f</Text> 查看。
      </Paragraph>

      <Title level={5} style={{ marginTop: 20 }}>
        参数说明
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        <Text code>--concurrency</Text> 是本机并发上限，与派发任务时设置的并发数取较小值；
        <Text code>--poll-interval</Text> 是队列为空时的轮询间隔（秒，默认 3）。
        Ctrl-C 可随时停止，但执行中的任务会停留在「执行中」，需在「Runner 管理」里手动取消。
      </Paragraph>
    </div>
  );
}
