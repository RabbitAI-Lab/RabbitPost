import { Spin } from "antd";
import { useEffect } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import AuthCallbackPage from "./pages/AuthCallbackPage";
import HomePage from "./pages/HomePage";
import LoginPage from "./pages/LoginPage";
import ConsoleLayout from "./pages/console/ConsoleLayout";
import ConsoleDashboard from "./pages/console/ConsoleDashboard";
import ConsoleTeams from "./pages/console/ConsoleTeams";
import ConsoleMembers from "./pages/console/ConsoleMembers";
import ConsoleWorkspaces from "./pages/console/ConsoleWorkspaces";
import ConsoleUsage from "./pages/console/ConsoleUsage";
import ConsoleApiKeys from "./pages/console/ConsoleApiKeys";
import ConsoleRunners from "./pages/console/ConsoleRunners";
import ConsoleAuditLog from "./pages/console/ConsoleAuditLog";
import ConsoleSettings from "./pages/console/ConsoleSettings";
import ConsoleBilling from "./pages/console/ConsoleBilling";
import ConsoleNotifications from "./pages/console/ConsoleNotifications";
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
        path="/console"
        element={user ? <ConsoleLayout /> : <Navigate to="/login" replace />}
      >
        <Route index element={<ConsoleDashboard />} />
        <Route path="teams" element={<ConsoleTeams />} />
        <Route path="members" element={<ConsoleMembers />} />
        <Route path="workspaces" element={<ConsoleWorkspaces />} />
        <Route path="usage" element={<ConsoleUsage />} />
        <Route path="api-keys" element={<ConsoleApiKeys />} />
        <Route path="runners" element={<ConsoleRunners />} />
        <Route path="audit" element={<ConsoleAuditLog />} />
        <Route path="notifications" element={<ConsoleNotifications />} />
        <Route path="settings" element={<ConsoleSettings />} />
        <Route path="billing" element={<ConsoleBilling />} />
      </Route>
      <Route
        path="/*"
        element={user ? <HomePage /> : <Navigate to="/login" replace />}
      />
    </Routes>
  );
}
