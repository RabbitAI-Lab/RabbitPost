import React from "react";
import ReactDOM from "react-dom/client";
import { App as AntdApp, ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        // 紧凑算法对齐 Postman 网页版密度（4K 屏 100% 缩放下默认尺寸显大）
        algorithm: [theme.defaultAlgorithm, theme.compactAlgorithm],
        token: {
          // 胡萝卜橙品牌色
          colorPrimary: "#ff6c37",
          colorLink: "#ff6c37",
          borderRadius: 6,
          fontSize: 12,
        },
      }}
    >
      <AntdApp>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
