//! 管理面 API 封装：读取统一返回 serde_json::Value（原样输出），
//! 仅上传报告等需要后续取字段的接口使用强类型。
use rp_core::http::HttpClient;
use rp_core::model::UploadedRunJob;

use crate::config::Credentials;

/// 执行方标识：写进执行报告的 agent 字段，同时作为 HTTP User-Agent
pub fn agent_string() -> String {
    format!(
        "rabbitpost-cli/{} {}-{}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    )
}

pub struct CliApi {
    http: HttpClient,
}

impl CliApi {
    pub fn new(creds: &Credentials) -> anyhow::Result<Self> {
        Ok(Self {
            http: HttpClient::new(&creds.server, &creds.api_key, &agent_string())?,
        })
    }

    pub async fn me(&self) -> anyhow::Result<serde_json::Value> {
        self.http.get("/api/v1/auth/me").await
    }

    pub async fn teams(&self) -> anyhow::Result<serde_json::Value> {
        self.http.get("/api/v1/teams").await
    }

    pub async fn workspaces(&self, team_id: &str) -> anyhow::Result<serde_json::Value> {
        self.http
            .get(&format!("/api/v1/workspaces?teamId={team_id}"))
            .await
    }

    pub async fn collections(&self, workspace_id: &str) -> anyhow::Result<serde_json::Value> {
        self.http
            .get(&format!("/api/v1/workspaces/{workspace_id}/collections"))
            .await
    }

    pub async fn collection(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.get(&format!("/api/v1/collections/{id}")).await
    }

    pub async fn collection_tree(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http
            .get(&format!("/api/v1/collections/{id}/tree"))
            .await
    }

    pub async fn create_collection(
        &self,
        workspace_id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .post(&format!("/api/v1/workspaces/{workspace_id}/collections"), body)
            .await
    }

    pub async fn update_collection(
        &self,
        id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .patch(&format!("/api/v1/collections/{id}"), body)
            .await
    }

    pub async fn delete_collection(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.delete(&format!("/api/v1/collections/{id}")).await
    }

    pub async fn item(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.get(&format!("/api/v1/items/{id}")).await
    }

    /// 单个请求条目的全部用例（GET /api/v1/items/:id/cases）
    pub async fn item_cases(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.get(&format!("/api/v1/items/{id}/cases")).await
    }

    /// Collection 下全部用例（扁平列表，含 itemId；本地展开时批量拉取）
    pub async fn collection_cases(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http
            .get(&format!("/api/v1/collections/{id}/cases"))
            .await
    }

    pub async fn create_item(
        &self,
        collection_id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .post(&format!("/api/v1/collections/{collection_id}/items"), body)
            .await
    }

    pub async fn update_item(
        &self,
        id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http.patch(&format!("/api/v1/items/{id}"), body).await
    }

    pub async fn delete_item(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.delete(&format!("/api/v1/items/{id}")).await
    }

    pub async fn environments(&self, workspace_id: &str) -> anyhow::Result<serde_json::Value> {
        self.http
            .get(&format!("/api/v1/workspaces/{workspace_id}/environments"))
            .await
    }

    pub async fn environment(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.get(&format!("/api/v1/environments/{id}")).await
    }

    pub async fn create_environment(
        &self,
        workspace_id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .post(
                &format!("/api/v1/workspaces/{workspace_id}/environments"),
                body,
            )
            .await
    }

    pub async fn update_environment(
        &self,
        id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .patch(&format!("/api/v1/environments/{id}"), body)
            .await
    }

    pub async fn delete_environment(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.delete(&format!("/api/v1/environments/{id}")).await
    }

    /// 上传执行报告：POST /api/v1/collections/:id/runs
    pub async fn upload_report(
        &self,
        collection_id: &str,
        report: &serde_json::Value,
    ) -> anyhow::Result<UploadedRunJob> {
        self.http
            .post(&format!("/api/v1/collections/{collection_id}/runs"), report)
            .await
    }
}
