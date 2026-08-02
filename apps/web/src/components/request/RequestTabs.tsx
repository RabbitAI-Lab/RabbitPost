import { DeploymentUnitOutlined, ExperimentOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { Button, Empty, Tabs } from "antd";
import { useLayoutEffect, useRef } from "react";
import { useTabsStore, isTabDirty } from "../../stores/tabs";
import { confirmCloseTab } from "../../lib/save-shortcut";
import CliCenter from "../cli/CliCenter";
import CollectionEditor from "../collection/CollectionEditor";
import DocumentEditor from "../document/DocumentEditor";
import EnvironmentEditor from "../environment/EnvironmentEditor";
import ProfileCenter from "../profile/ProfileCenter";
import CollectionRunner from "../runner/CollectionRunner";
import ScenarioEditor from "../scenario/ScenarioEditor";
import SpecEditor from "../spec/SpecEditor";
import EnvSwitcher from "./EnvSwitcher";
import RequestEditor from "./RequestEditor";

/** tab 默认宽度 / 最小宽度（px）；宽度不足时先收缩，触底后由 antd 导航条滚动 */
const TAB_WIDTH = 170;
const TAB_MIN_WIDTH = 75;

export default function RequestTabs() {
  const { tabs, activeKey, setActive, openDraft } = useTabsStore();
  const rootRef = useRef<HTMLDivElement>(null);

  // 根据导航条可用空间动态计算 tab 宽度：默认 170，空间不足时收缩，最小 75，再小则滚动
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || tabs.length === 0) return;
    const update = () => {
      const navWrap = root.querySelector<HTMLElement>(".ant-tabs-nav-wrap");
      const addBtn = root.querySelector<HTMLElement>(".ant-tabs-nav-list .ant-tabs-nav-add");
      const ops = root.querySelector<HTMLElement>(".ant-tabs-nav-operations");
      if (!navWrap) return;
      // operations（溢出“…”按钮）出现时会挤占 wrap 宽度，计算时还原，避免抖动
      const opsWidth =
        ops && !ops.className.includes("hidden")
          ? ops.getBoundingClientRect().width
          : 0;
      const addWidth = addBtn ? addBtn.getBoundingClientRect().width + 2 : 0;
      // card tab 从第二个起各有 margin-inline-start（antd 默认 2px），总量 (n-1)*gap
      const secondTab = root.querySelectorAll(".ant-tabs-tab")[1];
      const gap = secondTab
        ? parseFloat(getComputedStyle(secondTab).marginInlineStart) || 2
        : 2;
      // n*w + (n-1)*gap + add <= available  =>  w <= (available + gap) / n - gap
      const available = navWrap.clientWidth + opsWidth - addWidth;
      const width = Math.max(
        TAB_MIN_WIDTH,
        Math.min(TAB_WIDTH, Math.floor((available + gap) / tabs.length - gap)),
      );
      root.style.setProperty("--rp-tab-width", `${width}px`);
    };
    update();
    const observer = new ResizeObserver(update);
    const navWrap = root.querySelector(".ant-tabs-nav-wrap");
    if (navWrap) observer.observe(navWrap);
    return () => observer.disconnect();
  }, [tabs.length]);

  if (tabs.length === 0) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
        <Empty
          description={
            <>
              从左侧 Collection 打开一个请求，或
              <Button type="link" onClick={() => openDraft()}>
                新建请求
              </Button>
            </>
          }
        />
      </div>
    );
  }

  return (
    <div ref={rootRef} style={{ height: "100%" }}>
      <Tabs
        type="editable-card"
        size="small"
        className="request-tabs"
        activeKey={activeKey ?? undefined}
        onChange={setActive}
        onEdit={(key, action) => {
          if (action === "remove" && typeof key === "string") {
            confirmCloseTab(key);
          } else if (action === "add") {
            // 新建草稿继承最后一个请求 tab 的请求方法
            const lastRequest = [...tabs]
              .reverse()
              .find((t) => t.kind === "request");
            openDraft(lastRequest?.config.method);
          }
        }}
        style={{ height: "100%", padding: "0 8px" }}
        tabBarExtraContent={{ right: <EnvSwitcher /> }}
        items={tabs.map((tab) => ({
          key: tab.key,
          label: (
            <span className="request-tab-label">
              {/* 用例 tab：紫色实验图标前缀 */}
              {tab.kind === "request" && tab.caseId ? (
                <ExperimentOutlined style={{ marginRight: 4, color: "#722ed1" }} />
              ) : null}
              {/* Runner tab：播放图标前缀 */}
              {tab.kind === "runner" ? (
                <PlayCircleOutlined style={{ marginRight: 4, color: "#fa8c16" }} />
              ) : null}
              {/* Scenario tab：编排图标前缀 */}
              {tab.kind === "scenario" ? (
                <DeploymentUnitOutlined style={{ marginRight: 4, color: "#722ed1" }} />
              ) : null}
              {tab.name}
              {/* 未保存修改：右侧悬浮胡萝卜橙圆点（hover 时让位给关闭按钮） */}
              {isTabDirty(tab) && <span className="request-tab-dirty-dot" />}
            </span>
          ),
          children:
            tab.kind === "request" ? (
              <RequestEditor tab={tab} />
            ) : tab.kind === "environment" ? (
              <EnvironmentEditor tab={tab} />
            ) : tab.kind === "document" ? (
              <DocumentEditor tab={tab} />
            ) : tab.kind === "spec" ? (
              <SpecEditor tab={tab} />
            ) : tab.kind === "cli" ? (
              <CliCenter tab={tab} />
            ) : tab.kind === "profile" ? (
              <ProfileCenter />
            ) : tab.kind === "runner" ? (
              <CollectionRunner tab={tab} />
            ) : tab.kind === "scenario" ? (
              <ScenarioEditor tab={tab} />
            ) : (
              <CollectionEditor tab={tab} />
            ),
        }))}
      />
    </div>
  );
}
