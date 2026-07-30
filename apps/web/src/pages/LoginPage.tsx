import { LoginOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Typography } from "antd";
import { useState } from "react";
import { authApi } from "../api";
import { ApiError } from "../api/client";

export default function LoginPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async () => {
    setLoading(true);
    setError(null);
    try {
      const { authorizeUrl } = await authApi.loginUrl();
      window.location.href = authorizeUrl;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        placeItems: "center",
        background: "linear-gradient(135deg, #fff7f0 0%, #ffe8d6 100%)",
      }}
    >
      <Card style={{ width: 380, textAlign: "center" }}>
        <Typography.Title level={3} style={{ color: "#ff6c37", marginBottom: 4 }}>
          🥕 RabbitPost
        </Typography.Title>
        <Typography.Text type="secondary">
          团队协作的 API 调试平台
        </Typography.Text>
        <div style={{ marginTop: 32 }}>
          {error && (
            <Alert
              type="error"
              showIcon
              message={error}
              style={{ marginBottom: 16, textAlign: "left" }}
            />
          )}
          <Button
            type="primary"
            size="large"
            icon={<LoginOutlined />}
            loading={loading}
            block
            onClick={handleLogin}
          >
            使用 Casdoor 登录
          </Button>
        </div>
      </Card>
    </div>
  );
}
