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

    /// Collection 的执行记录：GET /api/v1/collections/:id/runs
    pub async fn collection_runs(
        &self,
        collection_id: &str,
        limit: Option<u32>,
    ) -> anyhow::Result<serde_json::Value> {
        let query = limit.map(|l| format!("?limit={l}")).unwrap_or_default();
        self.http
            .get(&format!("/api/v1/collections/{collection_id}/runs{query}"))
            .await
    }

    /// 单次执行详情：GET /api/v1/runs/:jobId
    pub async fn run_job(&self, job_id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.get(&format!("/api/v1/runs/{job_id}")).await
    }

    /// 下载服务端生成的执行报告（html/junit，非 JSON 信封，原文返回）
    pub async fn run_report(&self, job_id: &str, format: &str) -> anyhow::Result<String> {
        let resp = self
            .http
            .get_stream(&format!("/api/v1/runs/{job_id}/report?format={format}"))
            .await?;
        Ok(resp.text().await?)
    }

    /// 请求历史：GET /api/v1/workspaces/:id/history
    pub async fn workspace_history(
        &self,
        workspace_id: &str,
        limit: Option<u32>,
        offset: u32,
    ) -> anyhow::Result<serde_json::Value> {
        let mut query = format!("?offset={offset}");
        if let Some(limit) = limit {
            query.push_str(&format!("&limit={limit}"));
        }
        self.http
            .get(&format!("/api/v1/workspaces/{workspace_id}/history{query}"))
            .await
    }

    /// 清空请求历史：DELETE /api/v1/workspaces/:id/history
    pub async fn clear_history(&self, workspace_id: &str) -> anyhow::Result<serde_json::Value> {
        self.http
            .delete(&format!("/api/v1/workspaces/{workspace_id}/history"))
            .await
    }

    /// 单个 spec（含定义正文与类型）：GET /api/v1/specs/:id
    pub async fn spec(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.get(&format!("/api/v1/specs/{id}")).await
    }

    // ------------------------------------------------------------------
    // 团队 / Workspace 写操作与成员管理
    // ------------------------------------------------------------------

    pub async fn create_team(&self, body: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
        self.http.post("/api/v1/teams", body).await
    }

    pub async fn update_team(
        &self,
        id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http.patch(&format!("/api/v1/teams/{id}"), body).await
    }

    pub async fn delete_team(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.delete(&format!("/api/v1/teams/{id}")).await
    }

    pub async fn team_members(&self, team_id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.get(&format!("/api/v1/teams/{team_id}/members")).await
    }

    pub async fn add_team_member(
        &self,
        team_id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .post(&format!("/api/v1/teams/{team_id}/members"), body)
            .await
    }

    pub async fn update_team_member(
        &self,
        team_id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .patch(&format!("/api/v1/teams/{team_id}/members"), body)
            .await
    }

    pub async fn remove_team_member(
        &self,
        team_id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .delete_with_body(&format!("/api/v1/teams/{team_id}/members"), body)
            .await
    }

    pub async fn create_workspace(
        &self,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http.post("/api/v1/workspaces", body).await
    }

    pub async fn update_workspace(
        &self,
        id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http.patch(&format!("/api/v1/workspaces/{id}"), body).await
    }

    pub async fn delete_workspace(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.delete(&format!("/api/v1/workspaces/{id}")).await
    }

    // ------------------------------------------------------------------
    // 组织 / Runner / 文档 / Spec / 场景步骤
    // ------------------------------------------------------------------

    pub async fn orgs(&self) -> anyhow::Result<serde_json::Value> {
        self.http.get("/api/v1/orgs").await
    }

    pub async fn create_org(&self, body: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
        self.http.post("/api/v1/orgs", body).await
    }

    pub async fn org(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.get(&format!("/api/v1/orgs/{id}")).await
    }

    pub async fn update_org(
        &self,
        id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http.patch(&format!("/api/v1/orgs/{id}"), body).await
    }

    pub async fn delete_org(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.delete(&format!("/api/v1/orgs/{id}")).await
    }

    pub async fn team_runners(&self, team_id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.get(&format!("/api/v1/teams/{team_id}/runners")).await
    }

    pub async fn create_runner(
        &self,
        team_id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .post(&format!("/api/v1/teams/{team_id}/runners"), body)
            .await
    }

    pub async fn runner(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.get(&format!("/api/v1/runners/{id}")).await
    }

    pub async fn update_runner(
        &self,
        id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http.patch(&format!("/api/v1/runners/{id}"), body).await
    }

    pub async fn delete_runner(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.delete(&format!("/api/v1/runners/{id}")).await
    }

    pub async fn rotate_runner_token(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http
            .post(&format!("/api/v1/runners/{id}/token"), &serde_json::Value::Null)
            .await
    }

    pub async fn documents(&self, workspace_id: &str) -> anyhow::Result<serde_json::Value> {
        self.http
            .get(&format!("/api/v1/workspaces/{workspace_id}/documents"))
            .await
    }

    pub async fn create_document(
        &self,
        workspace_id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .post(&format!("/api/v1/workspaces/{workspace_id}/documents"), body)
            .await
    }

    pub async fn document(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.get(&format!("/api/v1/documents/{id}")).await
    }

    pub async fn update_document(
        &self,
        id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http.patch(&format!("/api/v1/documents/{id}"), body).await
    }

    pub async fn delete_document(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.delete(&format!("/api/v1/documents/{id}")).await
    }

    pub async fn workspace_specs(&self, workspace_id: &str) -> anyhow::Result<serde_json::Value> {
        self.http
            .get(&format!("/api/v1/workspaces/{workspace_id}/specs"))
            .await
    }

    pub async fn create_spec(
        &self,
        workspace_id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .post(&format!("/api/v1/workspaces/{workspace_id}/specs"), body)
            .await
    }

    pub async fn update_spec(
        &self,
        id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http.patch(&format!("/api/v1/specs/{id}"), body).await
    }

    pub async fn delete_spec(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.delete(&format!("/api/v1/specs/{id}")).await
    }

    pub async fn scenario_steps(&self, scenario_id: &str) -> anyhow::Result<serde_json::Value> {
        self.http
            .get(&format!("/api/v1/scenarios/{scenario_id}/steps"))
            .await
    }

    pub async fn add_scenario_step(
        &self,
        scenario_id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .post(&format!("/api/v1/scenarios/{scenario_id}/steps"), body)
            .await
    }

    pub async fn reorder_scenario_steps(
        &self,
        scenario_id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .patch(&format!("/api/v1/scenarios/{scenario_id}/steps"), body)
            .await
    }

    pub async fn sync_all_scenario_steps(
        &self,
        scenario_id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .post(&format!("/api/v1/scenarios/{scenario_id}/steps/sync-all"), body)
            .await
    }

    pub async fn update_scenario_step(
        &self,
        step_id: &str,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http
            .patch(&format!("/api/v1/scenario-steps/{step_id}"), body)
            .await
    }

    pub async fn delete_scenario_step(&self, step_id: &str) -> anyhow::Result<serde_json::Value> {
        self.http
            .delete(&format!("/api/v1/scenario-steps/{step_id}"))
            .await
    }

    pub async fn sync_scenario_step(&self, step_id: &str) -> anyhow::Result<serde_json::Value> {
        self.http
            .post(
                &format!("/api/v1/scenario-steps/{step_id}/sync"),
                &serde_json::Value::Null,
            )
            .await
    }

    // ------------------------------------------------------------------
    // rt 长连接会话
    // ------------------------------------------------------------------

    pub async fn rt_create_session(
        &self,
        body: &serde_json::Value,
    ) -> anyhow::Result<serde_json::Value> {
        self.http.post("/api/v1/rt/sessions", body).await
    }

    pub async fn rt_send(&self, id: &str, body: &serde_json::Value) -> anyhow::Result<serde_json::Value> {
        self.http.post(&format!("/api/v1/rt/sessions/{id}/send"), body).await
    }

    pub async fn rt_close(&self, id: &str) -> anyhow::Result<serde_json::Value> {
        self.http.delete(&format!("/api/v1/rt/sessions/{id}")).await
    }

    /// rt 事件流（SSE）：返回未消费的响应，调用方按行解析
    pub async fn rt_events(&self, id: &str) -> anyhow::Result<reqwest::Response> {
        self.http
            .get_stream(&format!("/api/v1/rt/sessions/{id}/events"))
            .await
    }
}
