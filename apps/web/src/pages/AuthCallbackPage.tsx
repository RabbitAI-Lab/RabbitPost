import { Alert, Spin } from "antd";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { authApi } from "../api";
import { useAppStore } from "../stores/app";

export default function AuthCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const signIn = useAppStore((s) => s.signIn);
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const code = params.get("code");
    if (!code) {
      setError("Missing authorization code in callback URL");
      return;
    }
    authApi
      .callback(code, `${window.location.origin}/auth/callback`)
      .then(async ({ user }) => {
        await signIn(user);
        navigate("/", { replace: true });
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [params, navigate, signIn]);

  return (
    <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
      {error ? (
        <Alert
          type="error"
          showIcon
          message="登录失败"
          description={error}
          style={{ maxWidth: 480 }}
        />
      ) : (
        <Spin size="large" description="正在完成登录..." />
      )}
    </div>
  );
}
