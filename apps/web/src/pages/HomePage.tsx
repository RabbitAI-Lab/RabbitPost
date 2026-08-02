import { Layout } from "antd";
import RequestTabs from "../components/request/RequestTabs";
import SidebarNav from "../components/sidebar/SidebarNav";
import TopBar from "../components/TopBar";
import { useGlobalCloseTabShortcut, useGlobalSaveShortcut } from "../lib/save-shortcut";

export default function HomePage() {
  // 全局拦截 Cmd/Ctrl+S，转为保存当前激活 tab
  useGlobalSaveShortcut();
  // 全局拦截 Cmd/Ctrl+Alt+W，关闭当前激活 tab
  useGlobalCloseTabShortcut();

  return (
    <Layout style={{ height: "100%" }}>
      <Layout.Header style={{ padding: 0, background: "#fff", height: 44, lineHeight: "44px", borderBottom: "1px solid #f0f0f0" }}>
        <TopBar />
      </Layout.Header>
      <Layout>
        <Layout.Sider
          width={300}
          style={{ background: "#fff", borderRight: "1px solid #f0f0f0" }}
        >
          <SidebarNav />
        </Layout.Sider>
        <Layout.Content style={{ overflow: "hidden", background: "#fafafa" }}>
          <RequestTabs />
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
