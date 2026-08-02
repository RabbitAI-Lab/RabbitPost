//! Runner 侧接口封装：心跳 / 领取任务 / 展开目标 / 上报结果 / 收尾。
//! 认证使用 Runner Token（rpr_...），与 CLI 的 API Key 互不通用。
use serde::{Deserialize, Serialize};

use crate::http::HttpClient;
use crate::model::{JobAssignment, JobResult};

#[derive(Debug, Deserialize)]
struct ClaimResponse {
    /// 队列为空时为 null
    #[serde(default)]
    job: Option<JobAssignment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HeartbeatBody {
    version: String,
    platform: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExpandBody {
    target_type: &'static str,
    target_id: String,
    environment_id: Option<String>,
    concurrency: usize,
}

#[derive(Debug, Serialize)]
struct ResultsBody<'a> {
    results: &'a [JobResult],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CompleteBody {
    status: &'static str,
    error: Option<String>,
}

pub struct RunnerApi {
    client: HttpClient,
}

impl RunnerApi {
    pub fn new(server: &str, token: &str, version: &str) -> anyhow::Result<Self> {
        let user_agent = format!("RabbitPostRunner/{version}");
        Ok(Self {
            client: HttpClient::new(server, token, &user_agent)?,
        })
    }

    /// 上线与保活；同时把版本与平台写回服务端，供管理页展示
    pub async fn heartbeat(&self, version: &str) -> anyhow::Result<()> {
        let _: serde_json::Value = self
            .client
            .post(
                "/api/v1/runner/heartbeat",
                &HeartbeatBody {
                    version: version.to_string(),
                    platform: format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH),
                },
            )
            .await?;
        Ok(())
    }

    /// 领取一个任务；队列为空返回 None
    pub async fn claim(&self) -> anyhow::Result<Option<JobAssignment>> {
        let resp: ClaimResponse = self
            .client
            .post("/api/v1/runner/jobs/claim", &serde_json::json!({}))
            .await?;
        Ok(resp.job)
    }

    /// 直接取一次目标定义（本地一次性执行用，不产生服务端任务）
    pub async fn expand(
        &self,
        target_type: &'static str,
        target_id: &str,
        environment_id: Option<String>,
        concurrency: usize,
    ) -> anyhow::Result<JobAssignment> {
        self.client
            .post(
                "/api/v1/runner/expand",
                &ExpandBody {
                    target_type,
                    target_id: target_id.to_string(),
                    environment_id,
                    concurrency,
                },
            )
            .await
    }

    pub async fn report(&self, job_id: &str, results: &[JobResult]) -> anyhow::Result<()> {
        let _: serde_json::Value = self
            .client
            .post(
                &format!("/api/v1/runner/jobs/{job_id}/results"),
                &ResultsBody { results },
            )
            .await?;
        Ok(())
    }

    pub async fn complete(
        &self,
        job_id: &str,
        succeeded: bool,
        error: Option<String>,
    ) -> anyhow::Result<()> {
        let _: serde_json::Value = self
            .client
            .post(
                &format!("/api/v1/runner/jobs/{job_id}/complete"),
                &CompleteBody {
                    status: if succeeded { "succeeded" } else { "failed" },
                    error,
                },
            )
            .await?;
        Ok(())
    }
}
