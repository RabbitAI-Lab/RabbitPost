import { Spin } from "antd";
import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import AuthCallbackPage from "./pages/AuthCallbackPage";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import { useAppStore } from "./stores/app";

export default function App() {
  const user = useAppStore((s) => s.user);
  const bootstrapped = useAppStore((s) => s.bootstrapped);
  const bootstrap = useAppStore((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (!bootstrapped) {
    return (
      <div style={{ height: "100%", display: "grid", placeItems: "center" }}>
        <Spin size="large" description="RabbitPost 加载中..." />
      </div>
    );
  }

  return (
    <Routes>
      <Route
        path="/login"
        element={user ? <Navigate to="/" replace /> : <LoginPage />}
      />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route
        path="/*"
        element={user ? <HomePage /> : <Navigate to="/login" replace />}
      />
    </Routes>
  );
}
