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

// ---------------------------------------------------------------------------
// 实时通道（rt）：api → runner 的 downlink 指令与 runner → api 的事件上行
// ---------------------------------------------------------------------------

/// api 经 downlink（NDJSON 流）下发的单条指令
#[derive(Debug, Deserialize)]
#[serde(tag = "cmd", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RtCommand {
    Start {
        session_id: String,
        protocol: String,
        url: String,
        #[serde(default)]
        config: Option<serde_json::Value>,
    },
    Send {
        session_id: String,
        data: String,
        #[serde(default)]
        encoding: Option<String>,
    },
    Close {
        session_id: String,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RtEventBody<'a> {
    session_id: &'a str,
    event: &'a serde_json::Value,
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

    /// 打开 rt downlink 长连接（GET 流式 NDJSON）；返回未消费的响应，调用方逐行读取。
    /// 连接断开（Ok 流结束或 Err）后由调用方退避重连，api 会重建会话。
    pub async fn open_rt_link(&self) -> anyhow::Result<reqwest::Response> {
        self.client.get_stream("/api/v1/runner/rt/link").await
    }

    /// 上报一条 session 事件（ServerMessage 形状的 JSON），api 写入对应 SSE 队列
    pub async fn post_rt_event(
        &self,
        session_id: &str,
        event: &serde_json::Value,
    ) -> anyhow::Result<()> {
        let _: serde_json::Value = self
            .client
            .post(
                "/api/v1/runner/rt/event",
                &RtEventBody {
                    session_id,
                    event,
                },
            )
            .await?;
        Ok(())
    }
}
