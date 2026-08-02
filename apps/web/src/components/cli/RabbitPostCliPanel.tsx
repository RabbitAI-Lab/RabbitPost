import {
  AppleOutlined,
  CopyOutlined,
  DownloadOutlined,
  LinuxOutlined,
  WindowsOutlined,
} from "@ant-design/icons";
import { Alert, App, Button, Table, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { useEffect, useState } from "react";
import ApiKeyManager from "../common/ApiKeyManager";
import CommandBlock from "./CommandBlock";

const { Paragraph, Text, Title } = Typography;

// ---------------------------------------------------------------------------
// 预编译包下载
// ---------------------------------------------------------------------------

interface CliArtifact {
  file: string;
  os: "macos" | "linux" | "windows";
  arch: "x64" | "arm64";
  target: string;
  size: number;
  sha256: string;
}

interface CliManifest {
  version: string;
  generatedAt: string;
  artifacts: CliArtifact[];
}

const OS_META: Record<CliArtifact["os"], { label: string; icon: React.ReactNode }> = {
  macos: { label: "macOS", icon: <AppleOutlined /> },
  linux: { label: "Linux", icon: <LinuxOutlined /> },
  windows: { label: "Windows", icon: <WindowsOutlined /> },
};

/** 从 UA 推测当前平台；架构不确定时返回 null（不高亮推荐） */
function detectPlatform(): { os: CliArtifact["os"]; arch: CliArtifact["arch"] } | null {
  const ua = navigator.userAgent;
  const os = /Windows/i.test(ua) ? "windows" : /Mac OS X|Macintosh/i.test(ua) ? "macos" : /Linux/i.test(ua) ? "linux" : null;
  if (!os) return null;
  if (/arm64|aarch64/i.test(ua)) return { os, arch: "arm64" };
  if (/x86_64|x64|intel/i.test(ua)) return { os, arch: "x64" };
  return null;
}

/** 预编译包下载区：读 API 的 artifacts 清单，按当前平台推荐 */
function DownloadSection() {
  const { message } = App.useApp();
  const [manifest, setManifest] = useState<CliManifest | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "empty">("loading");

  useEffect(() => {
    fetch("/api/v1/cli/artifacts")
      .then(async (resp) => {
        if (!resp.ok) throw new Error(await resp.text());
        return resp.json() as Promise<CliManifest>;
      })
      .then((data) => {
        setManifest(data);
        setState("ready");
      })
      .catch(() => setState("empty"));
  }, []);

  if (state === "loading") return null;
  if (state === "empty" || !manifest) {
    return (
      <>
        <Title level={5}>1. 下载预编译包</Title>
        <Alert
          type="info"
          showIcon
          message="尚无预编译产物"
          description={
            <span>
              在仓库根执行 <Text code>pnpm cli:package</Text> 即可一次构建全部平台
              （macOS / Linux / Windows，含 ARM），或由 cli-release 工作流发布到
              cli-latest Release。
            </span>
          }
          style={{ marginBottom: 24 }}
        />
      </>
    );
  }

  const detected = detectPlatform();
  const recommended = detected
    ? manifest.artifacts.find((a) => a.os === detected.os && a.arch === detected.arch)
    : undefined;
  const downloadUrl = (file: string) =>
    `/api/v1/cli/artifacts/v${manifest.version}/${file}`;

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 8 }}>
        <Title level={5} style={{ margin: 0, flex: 1 }}>
          1. 下载预编译包
          <Text type="secondary" style={{ fontSize: 12, fontWeight: "normal", marginLeft: 8 }}>
            v{manifest.version} · 构建于 {dayjs(manifest.generatedAt).format("MM-DD HH:mm")}
          </Text>
        </Title>
        {recommended && (
          <Button
            type="primary"
            size="small"
            icon={<DownloadOutlined />}
            href={downloadUrl(recommended.file)}
          >
            下载 {OS_META[recommended.os].label} {recommended.arch}
          </Button>
        )}
      </div>
      <Table<CliArtifact>
        size="small"
        rowKey="file"
        dataSource={manifest.artifacts}
        pagination={false}
        style={{ marginBottom: 8 }}
        columns={[
          {
            title: "平台",
            width: 160,
            render: (_, row) => (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {OS_META[row.os].icon}
                {OS_META[row.os].label} {row.arch}
                {recommended?.file === row.file && <Tag color="orange">当前设备</Tag>}
              </span>
            ),
          },
          {
            title: "文件",
            dataIndex: "file",
            render: (file: string) => <Text code>{file}</Text>,
          },
          {
            title: "大小",
            dataIndex: "size",
            width: 90,
            render: (size: number) => `${(size / 1024 / 1024).toFixed(1)} MB`,
          },
          {
            title: "SHA256",
            dataIndex: "sha256",
            width: 100,
            render: (sha256: string) => (
              <Button
                type="link"
                size="small"
                icon={<CopyOutlined />}
                onClick={() => {
                  void navigator.clipboard.writeText(sha256);
                  message.success("SHA256 已复制");
                }}
              >
                复制
              </Button>
            ),
          },
          {
            title: "操作",
            width: 90,
            render: (_, row) => (
              <Button
                type="link"
                size="small"
                icon={<DownloadOutlined />}
                href={downloadUrl(row.file)}
              >
                下载
              </Button>
            ),
          },
        ]}
      />
      <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 24 }}>
        macOS / Linux：<Text code>chmod +x rabbitpost-* && sudo mv rabbitpost-* /usr/local/bin/rabbitpost</Text>
        ；浏览器下载的包如被 Gatekeeper 拦截，执行{" "}
        <Text code>xattr -d com.apple.quarantine rabbitpost</Text>。
        Windows：重命名为 <Text code>rabbitpost.exe</Text> 并加入 PATH。
      </Paragraph>
    </>
  );
}

/**
 * RabbitPost CLI 面板：本地命令行工具（Rust 单二进制，bin 名 rabbitpost），
 * 负责接口增删改查、本机执行用例（含 rp.* 断言）、生成测试报告并上传。
 */
export default function RabbitPostCliPanel() {
  const origin = window.location.origin;

  return (
    <div style={{ maxWidth: 860 }}>
      <Alert
        type="info"
        showIcon
        message="RabbitPost CLI 与 Runner CLI 是两个独立二进制"
        description="rabbitpost 在用户本机 / CI 运行：增删改查接口、执行用例、生成并上传报告；rabbitpost-runner 在服务器常驻，领取 Web 派发的任务。两者凭证不同（API Key vs Runner Token）。"
        style={{ marginBottom: 16 }}
      />

      <DownloadSection />

      <ApiKeyManager showHint={false} />

      <Title level={5}>3. 配置凭证（无需登录）</Title>
      <Paragraph type="secondary" style={{ marginBottom: 8 }}>
        API Key 即凭证，任选一种方式提供：命令行参数{" "}
        <Text code>--server / --api-key</Text>、环境变量（CI 推荐），或写入配置文件。
        优先级：参数 &gt; 环境变量 &gt; 配置文件。{" "}
        如需从源码构建：<Text code>pnpm cli:build</Text>。
      </Paragraph>
      <CommandBlock
        multiline
        command={`export RABBITPOST_SERVER=${origin}
export RABBITPOST_API_KEY=<API_KEY>
rabbitpost auth status   # 验证凭证`}
      />
      <Paragraph type="secondary" style={{ marginBottom: 8 }}>
        或一次性写入 <Text code>~/.rabbitpost/config.json</Text>（权限建议 600），之后所有命令免带参数：
      </Paragraph>
      <CommandBlock
        multiline
        command={`mkdir -p ~/.rabbitpost && cat > ~/.rabbitpost/config.json <<EOF
{
  "server": "${origin}",
  "apiKey": "<API_KEY>"
}
EOF
chmod 600 ~/.rabbitpost/config.json`}
      />

      <Title level={5} style={{ marginTop: 24 }}>
        4. 增删改查（默认 JSON 输出，适合 AI 与脚本）
      </Title>
      <CommandBlock
        multiline
        command={`rabbitpost team list
rabbitpost workspace list --team <TEAM_ID>
rabbitpost collection list --workspace <WORKSPACE_ID>
rabbitpost request list --collection <COLLECTION_ID>
rabbitpost request create --collection <COLLECTION_ID> \\
  --name "获取用户" --method GET --url "{{host}}/users/1"
rabbitpost request update <ITEM_ID> --data @request.json
rabbitpost env update <ENV_ID> --set host=https://api.example.com`}
      />

      <Title level={5} style={{ marginTop: 24 }}>
        5. 执行用例、生成报告并上传
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 8 }}>
        本机执行（含 rp.* 断言脚本），报告支持 json / html / junit 三种格式；
        --upload 后记录会出现在该 Collection 的 Runs tab。
      </Paragraph>
      <CommandBlock
        multiline
        command={`rabbitpost run \\
  --collection <COLLECTION_ID> \\
  --env <ENVIRONMENT_ID> \\
  --concurrency 8 \\
  --report json,html,junit --report-dir ./reports \\
  --upload`}
      />

      <Title level={5} style={{ marginTop: 24 }}>
        6. 退出码
      </Title>
      <Paragraph type="secondary" style={{ marginBottom: 0 }}>
        全部用例通过返回 <Tag color="green">0</Tag>，存在失败用例返回{" "}
        <Tag color="red">1</Tag>，参数 / 鉴权 / 网络等操作错误返回{" "}
        <Tag>2</Tag>；CI 可直接作为门禁。
      </Paragraph>
    </div>
  );
}
