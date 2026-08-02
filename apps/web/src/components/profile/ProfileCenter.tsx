import { Avatar, Descriptions, Typography } from "antd";
import dayjs from "dayjs";
import { useAppStore } from "../../stores/app";
import ApiKeyManager from "../common/ApiKeyManager";

const { Title } = Typography;

/** 个人中心：账号信息 + API Key 维护（账号下拉菜单入口打开） */
export default function ProfileCenter() {
  const user = useAppStore((s) => s.user);

  return (
    <div style={{ height: "100%", overflow: "auto", padding: "16px 20px" }}>
      <div style={{ maxWidth: 860 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <Avatar size={48} src={user?.avatarUrl}>
            {user?.name?.slice(0, 1)}
          </Avatar>
          <div>
            <Title level={5} style={{ margin: 0 }}>
              {user?.name}
            </Title>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {user?.email ?? "未绑定邮箱"}
            </Typography.Text>
          </div>
        </div>

        <Descriptions
          size="small"
          column={1}
          bordered
          items={[
            { key: "name", label: "昵称", children: user?.name },
            { key: "email", label: "邮箱", children: user?.email ?? "-" },
            {
              key: "createdAt",
              label: "注册时间",
              children: user?.createdAt ? dayjs(user.createdAt).format("YYYY-MM-DD") : "-",
            },
          ]}
        />

        <Title level={5} style={{ margin: "24px 0 8px" }}>
          API Keys
        </Title>
        <ApiKeyManager />
      </div>
    </div>
  );
}
