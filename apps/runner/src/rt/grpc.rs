//! gRPC 协议 session：tonic + prost-reflect 动态消息客户端。
//! 帧契约与 apps/api/src/lib/rt.ts（帧契约） 一致：
//! - 连接成功 → status open + in {"action":"serviceList","result":{"services":[...]}}
//! - send 动作帧（JSON 字符串）：invoke / push / halfClose
//! - 调用事件流：{"action":"invoke","event":"data"|"end"|"error", ...}
//! - 同一 session 同时只允许一个进行中的调用（单 flight）

use std::collections::HashSet;
use std::time::Duration;

use base64::Engine;
use prost::Message as _;
use prost_reflect::{
    DescriptorPool, DynamicMessage, FieldDescriptor, Kind, MessageDescriptor, SerializeOptions,
};
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_stream::wrappers::ReceiverStream;
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::metadata::{Ascii, MetadataKey, MetadataMap, MetadataValue};
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use tonic::{Request, Status};
use tonic_reflection::pb::v1alpha::server_reflection_client::ServerReflectionClient;
use tonic_reflection::pb::v1alpha::server_reflection_request::MessageRequest;
use tonic_reflection::pb::v1alpha::server_reflection_response::MessageResponse;
use tonic_reflection::pb::v1alpha::ServerReflectionRequest;

use super::SessionCtl;

/// 服务发现与连接就绪的超时
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(5);

/// 响应 JSON 序列化选项
/// （proto 字段名、64 位整数转字符串、枚举用名字、省略默认值）
const SER_OPTS: SerializeOptions = SerializeOptions::new().use_proto_field_name(true);

/// gRPC session 连接参数（从 downlink start 指令解析）
pub struct GrpcSessionConfig {
    /// host:port（已剥掉 scheme 前缀）
    pub address: String,
    pub tls: bool,
    /// .proto 文本，reflection 不可用时的兜底服务描述
    pub proto_text: Option<String>,
    /// 每次调用附加的 metadata（已过滤 enabled != false 与空 key）
    pub metadata: Vec<(String, String)>,
}

impl GrpcSessionConfig {
    /// config 形状：`{ tls?: bool, protoText?: string, metadata?: [{key, value, enabled?}] }`
    pub fn from_parts(url: String, config: Option<Value>) -> Self {
        let address = match url.find("://") {
            Some(idx) => url[idx + 3..].to_string(),
            None => url,
        };
        let tls = config
            .as_ref()
            .and_then(|c| c.get("tls"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let proto_text = config
            .as_ref()
            .and_then(|c| c.get("protoText"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let metadata = config
            .as_ref()
            .and_then(|c| c.get("metadata"))
            .and_then(Value::as_array)
            .map(|list| {
                list.iter()
                    .filter_map(|h| {
                        let enabled = h.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                        let key = h.get("key")?.as_str()?;
                        let value = h.get("value")?.as_str()?;
                        (enabled && !key.is_empty())
                            .then(|| (key.to_string(), value.to_string()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        Self {
            address,
            tls,
            proto_text,
            metadata,
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn send(events: &mpsc::UnboundedSender<Value>, event: Value) {
    let _ = events.send(event);
}

/// in 方向的协议消息（data 为 JSON 字符串）
fn reply(events: &mpsc::UnboundedSender<Value>, payload: Value) {
    send(
        events,
        json!({
            "t": "message", "dir": "in", "data": payload.to_string(),
            "encoding": "text", "ts": now_ms(),
        }),
    );
}

/// send 受理后的 out 回执
fn receipt(events: &mpsc::UnboundedSender<Value>, data: &str) {
    send(
        events,
        json!({
            "t": "message", "dir": "out", "data": data,
            "encoding": "text", "ts": now_ms(),
        }),
    );
}

// ---------------------------------------------------------------------------
// 动态消息编解码
// ---------------------------------------------------------------------------

/// DynamicMessage → JSON（省略默认值；proto 字段名、枚举用名字、64 位整数转字符串）
fn message_to_json(msg: &DynamicMessage) -> Value {
    msg.serialize_with_options(serde_json::value::Serializer, &SER_OPTS)
        .unwrap_or(Value::Null)
}

/// JSON → DynamicMessage；接受 proto 字段名与 lowerCamelCase 两种键
fn json_to_message(desc: &MessageDescriptor, payload: &Value) -> Result<DynamicMessage, String> {
    DynamicMessage::deserialize(desc.clone(), payload.clone())
        .map_err(|e| format!("payload 与请求消息类型不匹配: {e}"))
}

/// 按消息类型生成 JSON 模板：标量给默认值，嵌套消息展开一层
fn example_from_descriptor(desc: &MessageDescriptor, depth: u32) -> Value {
    let mut map = serde_json::Map::new();
    for field in desc.fields() {
        map.insert(field.name().to_string(), field_default(&field, depth));
    }
    Value::Object(map)
}

fn field_default(field: &FieldDescriptor, depth: u32) -> Value {
    if field.is_map() {
        return json!({});
    }
    if field.is_list() {
        return json!([]);
    }
    match field.kind() {
        Kind::Enum(e) => e
            .values()
            .next()
            .map(|v| json!(v.name()))
            .unwrap_or(json!(0)),
        Kind::Message(m) if depth < 1 => example_from_descriptor(&m, depth + 1),
        Kind::Message(_) => json!({}),
        Kind::String | Kind::Bytes => json!(""),
        Kind::Bool => json!(false),
        _ => json!(0),
    }
}

/// tonic Codec：DynamicMessage 编解码（encoder 依赖消息自描述，decoder 需响应类型）
#[derive(Clone)]
struct DynamicCodec {
    output: MessageDescriptor,
}

struct DynamicEncoder;

struct DynamicDecoder(MessageDescriptor);

impl Codec for DynamicCodec {
    type Encode = DynamicMessage;
    type Decode = DynamicMessage;
    type Encoder = DynamicEncoder;
    type Decoder = DynamicDecoder;

    fn encoder(&mut self) -> Self::Encoder {
        DynamicEncoder
    }

    fn decoder(&mut self) -> Self::Decoder {
        DynamicDecoder(self.output.clone())
    }
}

impl Encoder for DynamicEncoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn encode(&mut self, item: Self::Item, dst: &mut EncodeBuf<'_>) -> Result<(), Self::Error> {
        item.encode(dst)
            .map_err(|e| Status::internal(format!("encode failed: {e}")))
    }
}

impl Decoder for DynamicDecoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<Self::Item>, Self::Error> {
        DynamicMessage::decode(self.0.clone(), src)
            .map(Some)
            .map_err(|e| Status::internal(format!("decode failed: {e}")))
    }
}

// ---------------------------------------------------------------------------
// 服务发现
// ---------------------------------------------------------------------------

struct Discovery {
    pool: DescriptorPool,
    services: Value,
}

/// 从 pool 构建 serviceList 元数据（过滤 reflection 自身的服务）
fn service_list(pool: &DescriptorPool) -> Value {
    let services: Vec<Value> = pool
        .services()
        .filter(|s| !s.full_name().starts_with("grpc.reflection."))
        .map(|s| {
            let methods: Vec<Value> = s
                .methods()
                .map(|m| {
                    json!({
                        "name": m.name(),
                        "requestStream": m.is_client_streaming(),
                        "responseStream": m.is_server_streaming(),
                        "requestExample": example_from_descriptor(&m.input(), 0),
                    })
                })
                .collect();
            json!({ "name": s.full_name(), "methods": methods })
        })
        .collect();
    json!({ "services": services })
}

/// 优先 gRPC server reflection（v1alpha ServerReflectionInfo 双向流）做服务发现
async fn discover_by_reflection(channel: Channel) -> anyhow::Result<Discovery> {
    let mut client = ServerReflectionClient::new(channel);
    let (tx, rx) = mpsc::channel(8);
    let request = |msg: MessageRequest| ServerReflectionRequest {
        host: String::new(),
        message_request: Some(msg),
    };
    tx.send(request(MessageRequest::ListServices(String::new())))
        .await?;
    let mut stream = client
        .server_reflection_info(ReceiverStream::new(rx))
        .await?
        .into_inner();

    let resp = stream
        .message()
        .await?
        .ok_or_else(|| anyhow::anyhow!("reflection 流提前结束"))?;
    let names: Vec<String> = match resp.message_response {
        Some(MessageResponse::ListServicesResponse(list)) => list
            .service
            .into_iter()
            .map(|s| s.name)
            .filter(|n| !n.is_empty() && !n.starts_with("grpc.reflection."))
            .collect(),
        Some(MessageResponse::ErrorResponse(e)) => {
            anyhow::bail!("reflection listServices 失败: {}", e.error_message)
        }
        _ => anyhow::bail!("reflection 返回了意外的响应"),
    };
    if names.is_empty() {
        anyhow::bail!("reflection 未返回业务服务");
    }

    // 逐服务拉取 FileDescriptorProto（去重后装入 DescriptorPool）
    let mut seen = HashSet::new();
    let mut files = Vec::new();
    for name in &names {
        tx.send(request(MessageRequest::FileContainingSymbol(name.clone())))
            .await?;
        let resp = stream
            .message()
            .await?
            .ok_or_else(|| anyhow::anyhow!("reflection 流提前结束"))?;
        match resp.message_response {
            Some(MessageResponse::FileDescriptorResponse(fd)) => {
                for bytes in fd.file_descriptor_proto {
                    let proto = prost_types::FileDescriptorProto::decode(bytes.as_slice())?;
                    if seen.insert(proto.name().to_string()) {
                        files.push(proto);
                    }
                }
            }
            Some(MessageResponse::ErrorResponse(e)) => {
                anyhow::bail!("reflection 拉取 {name} 失败: {}", e.error_message)
            }
            _ => anyhow::bail!("reflection 返回了意外的响应"),
        }
    }
    let pool = DescriptorPool::from_file_descriptor_set(prost_types::FileDescriptorSet {
        file: files,
    })?;
    let services = service_list(&pool);
    Ok(Discovery { pool, services })
}

/// 兜底：从 config.protoText 经 protox（纯 Rust protoc）编译
fn discover_by_proto_text(proto_text: &str) -> anyhow::Result<Discovery> {
    // protox 只接受文件路径：写入临时目录编译，结束后清理
    let dir = std::env::temp_dir().join(format!(
        "rabbitpost-grpc-{}-{}",
        std::process::id(),
        now_ms()
    ));
    std::fs::create_dir_all(&dir)?;
    let result = (|| {
        let file = dir.join("schema.proto");
        std::fs::write(&file, proto_text)?;
        let fds = protox::compile(["schema.proto"], [&dir])
            .map_err(|e| anyhow::anyhow!("protoText 编译失败: {e}"))?;
        let pool = DescriptorPool::from_file_descriptor_set(fds)?;
        let services = service_list(&pool);
        Ok(Discovery { pool, services })
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq)]
enum CallKind {
    Unary,
    Server,
    Client,
    Bidi,
}

/// 进行中的调用（unary/server 只读，client/bidi 可写流）
struct ActiveCall {
    kind: CallKind,
    input: MessageDescriptor,
    payload_tx: Option<mpsc::Sender<DynamicMessage>>,
    handle: tokio::task::JoinHandle<()>,
}

fn metadata_append(map: &mut MetadataMap, key: &str, value: &str) -> Result<(), String> {
    if key.len() >= 4 && key[key.len() - 4..].eq_ignore_ascii_case("-bin") {
        let k = MetadataKey::from_bytes(key.as_bytes())
            .map_err(|e| format!("无效 metadata 键 `{key}`: {e}"))?;
        let raw = base64::engine::general_purpose::STANDARD
            .decode(value)
            .map_err(|e| format!("metadata `{key}` 的值需为 base64: {e}"))?;
        map.append_bin(k, MetadataValue::from_bytes(&raw));
    } else {
        let k = key
            .parse::<MetadataKey<Ascii>>()
            .map_err(|e| format!("无效 metadata 键 `{key}`: {e}"))?;
        let v = value
            .parse::<MetadataValue<Ascii>>()
            .map_err(|e| format!("无效 metadata 值 `{key}`: {e}"))?;
        map.append(k, v);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// session 主流程
// ---------------------------------------------------------------------------

/// 运行一个 gRPC session 直到关闭；事件（不带 id）逐条送入 events。
pub async fn run_grpc_session(
    cfg: GrpcSessionConfig,
    mut ctl: mpsc::Receiver<SessionCtl>,
    events: mpsc::UnboundedSender<Value>,
) {
    send(&events, json!({"t": "status", "state": "connecting"}));

    let scheme = if cfg.tls { "https" } else { "http" };
    let mut endpoint = match Endpoint::from_shared(format!("{scheme}://{}", cfg.address)) {
        Ok(e) => e.connect_timeout(DISCOVERY_TIMEOUT),
        Err(e) => {
            send(&events, json!({"t": "status", "state": "error", "reason": e.to_string()}));
            return;
        }
    };
    if cfg.tls {
        endpoint = match endpoint.tls_config(ClientTlsConfig::new().with_native_roots()) {
            Ok(e) => e,
            Err(e) => {
                send(&events, json!({"t": "status", "state": "error", "reason": e.to_string()}));
                return;
            }
        };
    }
    let channel = endpoint.connect_lazy();

    // 服务发现：reflection 优先，protoText 兜底
    let reflection = tokio::time::timeout(
        DISCOVERY_TIMEOUT,
        discover_by_reflection(channel.clone()),
    )
    .await;
    let discovered = match reflection {
        Ok(Ok(d)) => Ok(d),
        Ok(Err(e)) => Err(anyhow::anyhow!(e)),
        Err(_) => Err(anyhow::anyhow!("gRPC reflection 超时")),
    };
    let discovered = match (discovered, &cfg.proto_text) {
        (Ok(d), _) => Ok(d),
        (Err(refl_err), Some(text)) => match discover_by_proto_text(text) {
            Ok(d) => {
                // protoText 路径未验证连通性：TCP 探测一下，不可达就早报错
                match tokio::time::timeout(
                    DISCOVERY_TIMEOUT,
                    tokio::net::TcpStream::connect(cfg.address.clone()),
                )
                .await
                {
                    Ok(Ok(_)) => Ok(d),
                    Ok(Err(e)) => Err(anyhow::anyhow!(e)),
                    Err(_) => Err(anyhow::anyhow!("连接超时")),
                }
            }
            Err(e) => Err(e.context(format!("reflection 也不可用: {refl_err:#}"))),
        },
        (Err(e), None) => Err(e),
    };
    let Discovery { pool, services } = match discovered {
        Ok(d) => d,
        Err(e) => {
            send(&events, json!({"t": "status", "state": "error", "reason": format!("{e:#}")}));
            return;
        }
    };

    send(&events, json!({"t": "status", "state": "open"}));
    reply(&events, json!({"action": "serviceList", "result": services}));

    let mut active: Option<ActiveCall> = None;
    // 调用任务完成信号：清掉 active 以放行下一次 invoke
    let (done_tx, mut done_rx) = mpsc::channel::<()>(1);

    loop {
        tokio::select! {
            _ = done_rx.recv(), if active.is_some() => {
                active = None;
            }
            command = ctl.recv() => {
                match command {
                    Some(SessionCtl::Send { data, .. }) => handle_action(
                        &data, &cfg, &channel, &pool, &events, &mut active, &done_tx,
                    ),
                    Some(SessionCtl::Close) | None => {
                        if let Some(call) = active.take() {
                            call.handle.abort();
                        }
                        send(&events, json!({"t": "status", "state": "closed"}));
                        return;
                    }
                }
            }
        }
    }
}

fn handle_action(
    data: &str,
    cfg: &GrpcSessionConfig,
    channel: &Channel,
    pool: &DescriptorPool,
    events: &mpsc::UnboundedSender<Value>,
    active: &mut Option<ActiveCall>,
    done_tx: &mpsc::Sender<()>,
) {
    let action: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => {
            reply(
                events,
                json!({"action": "error", "error": "发送内容需为 JSON 动作帧（invoke/push/halfClose）"}),
            );
            return;
        }
    };
    match action.get("action").and_then(Value::as_str) {
        Some("invoke") => invoke(&action, data, cfg, channel, pool, events, active, done_tx),
        Some("push") => push(&action, data, events, active),
        Some("halfClose") => half_close(data, events, active),
        other => reply(
            events,
            json!({"action": "error", "error": format!("未知动作：{}", other.unwrap_or(""))}),
        ),
    }
}

#[allow(clippy::too_many_arguments)]
fn invoke(
    action: &Value,
    data: &str,
    cfg: &GrpcSessionConfig,
    channel: &Channel,
    pool: &DescriptorPool,
    events: &mpsc::UnboundedSender<Value>,
    active: &mut Option<ActiveCall>,
    done_tx: &mpsc::Sender<()>,
) {
    if active.is_some() {
        reply(
            events,
            json!({"action": "invoke", "event": "error", "error": "已有进行中的调用，请先结束或关闭"}),
        );
        return;
    }
    let service = action.get("service").and_then(Value::as_str).unwrap_or("");
    let method = action.get("method").and_then(Value::as_str).unwrap_or("");
    let method_desc = pool
        .get_service_by_name(service)
        .and_then(|s| s.methods().find(|m| m.name() == method));
    let Some(method_desc) = method_desc else {
        reply(
            events,
            json!({"action": "invoke", "event": "error",
                "error": format!("方法不存在：{service}/{method}")}),
        );
        return;
    };

    // metadata：config 基础项 + 本次调用附加项
    let mut metadata = MetadataMap::new();
    for (key, value) in &cfg.metadata {
        if let Err(e) = metadata_append(&mut metadata, key, value) {
            reply(events, json!({"action": "error", "error": e}));
            return;
        }
    }
    if let Some(obj) = action.get("metadata").and_then(Value::as_object) {
        for (key, value) in obj {
            let value = value.as_str().unwrap_or("");
            if let Err(e) = metadata_append(&mut metadata, key, value) {
                reply(events, json!({"action": "error", "error": e}));
                return;
            }
        }
    }

    let input = method_desc.input();
    let output = method_desc.output();
    let payload = action.get("payload").cloned().unwrap_or(json!({}));
    let initial = match json_to_message(&input, &payload) {
        Ok(m) => m,
        Err(e) => {
            reply(events, json!({"action": "error", "error": e}));
            return;
        }
    };

    let kind = match (
        method_desc.is_client_streaming(),
        method_desc.is_server_streaming(),
    ) {
        (true, true) => CallKind::Bidi,
        (true, false) => CallKind::Client,
        (false, true) => CallKind::Server,
        (false, false) => CallKind::Unary,
    };
    // out 回执先行，事件异步回推
    receipt(events, data);

    let path: tonic::codegen::http::uri::PathAndQuery = format!("/{service}/{method}")
        .parse()
        .expect("service/method 来自合法描述符，路径必然合法");
    let codec = DynamicCodec {
        output: output.clone(),
    };
    let mut grpc = tonic::client::Grpc::new(channel.clone());
    let events2 = events.clone();
    let done_tx2 = done_tx.clone();

    let (payload_tx, request_stream) = match kind {
        CallKind::Client | CallKind::Bidi => {
            let (tx, rx) = mpsc::channel(32);
            // 建流后立即写入首条 payload
            let _ = tx.try_send(initial.clone());
            (Some(tx), Some(ReceiverStream::new(rx)))
        }
        _ => (None, None),
    };

    let handle = tokio::spawn(async move {
        // 生成的 tonic 客户端每次调用前都会 ready()：tower buffer 要求先 poll_reserve
        if let Err(e) = grpc.ready().await {
            reply(&events2, json!({"action": "invoke", "event": "error",
                "error": format!("channel 不可用: {e}")}));
            let _ = done_tx2.send(()).await;
            return;
        }
        match (kind, request_stream) {
            (CallKind::Unary, None) => {
                let mut request = Request::new(initial);
                *request.metadata_mut() = metadata;
                match grpc.unary(request, path, codec).await {
                    Ok(resp) => {
                        reply(&events2, json!({"action": "invoke", "event": "data",
                            "payload": message_to_json(resp.get_ref())}));
                        reply(&events2, json!({"action": "invoke", "event": "end",
                            "status": {"code": 0, "details": "OK"}}));
                    }
                    Err(status) => reply(&events2, json!({"action": "invoke", "event": "error",
                        "error": status.message()})),
                }
            }
            (CallKind::Server, None) => {
                let mut request = Request::new(initial);
                *request.metadata_mut() = metadata;
                match grpc.server_streaming(request, path, codec).await {
                    Ok(resp) => stream_responses(resp.into_inner(), &events2).await,
                    Err(status) => reply(&events2, json!({"action": "invoke", "event": "error",
                        "error": status.message()})),
                }
            }
            (CallKind::Client, Some(stream)) => {
                let mut request = Request::new(stream);
                *request.metadata_mut() = metadata;
                match grpc.client_streaming(request, path, codec).await {
                    Ok(resp) => {
                        reply(&events2, json!({"action": "invoke", "event": "data",
                            "payload": message_to_json(resp.get_ref())}));
                        reply(&events2, json!({"action": "invoke", "event": "end",
                            "status": {"code": 0, "details": "OK"}}));
                    }
                    Err(status) => reply(&events2, json!({"action": "invoke", "event": "error",
                        "error": status.message()})),
                }
            }
            (CallKind::Bidi, Some(stream)) => {
                let mut request = Request::new(stream);
                *request.metadata_mut() = metadata;
                match grpc.streaming(request, path, codec).await {
                    Ok(resp) => stream_responses(resp.into_inner(), &events2).await,
                    Err(status) => reply(&events2, json!({"action": "invoke", "event": "error",
                        "error": status.message()})),
                }
            }
            _ => unreachable!("kind 与 request_stream 成对构造"),
        }
        let _ = done_tx2.send(()).await;
    });

    *active = Some(ActiveCall {
        kind,
        input,
        payload_tx,
        handle,
    });
}

/// 读取 server/bidi 响应流：逐条 data，结束 end，出错 error
async fn stream_responses(
    mut stream: tonic::Streaming<DynamicMessage>,
    events: &mpsc::UnboundedSender<Value>,
) {
    loop {
        match stream.message().await {
            Ok(Some(msg)) => reply(
                events,
                json!({"action": "invoke", "event": "data", "payload": message_to_json(&msg)}),
            ),
            Ok(None) => {
                reply(
                    events,
                    json!({"action": "invoke", "event": "end",
                        "status": {"code": 0, "details": "OK"}}),
                );
                return;
            }
            Err(status) => {
                reply(
                    events,
                    json!({"action": "invoke", "event": "error", "error": status.message()}),
                );
                return;
            }
        }
    }
}

fn push(
    action: &Value,
    data: &str,
    events: &mpsc::UnboundedSender<Value>,
    active: &mut Option<ActiveCall>,
) {
    let call = active.as_ref().filter(|c| {
        matches!(c.kind, CallKind::Client | CallKind::Bidi) && c.payload_tx.is_some()
    });
    let Some(call) = call else {
        reply(
            events,
            json!({"action": "push", "event": "error",
                "error": "当前没有进行中的 client/bidi streaming 调用"}),
        );
        return;
    };
    let payload = action.get("payload").cloned().unwrap_or(json!({}));
    let msg = match json_to_message(&call.input, &payload) {
        Ok(m) => m,
        Err(e) => {
            reply(events, json!({"action": "error", "error": e}));
            return;
        }
    };
    // try_send：通道满说明对端消费不过来，报错而不是阻塞 session 循环
    if let Err(e) = call.payload_tx.as_ref().expect("已过滤").try_send(msg) {
        reply(
            events,
            json!({"action": "push", "event": "error", "error": format!("写入流失败: {e}")}),
        );
        return;
    }
    receipt(events, data);
}

fn half_close(
    data: &str,
    events: &mpsc::UnboundedSender<Value>,
    active: &mut Option<ActiveCall>,
) {
    let ok = matches!(
        active.as_ref(),
        Some(c) if matches!(c.kind, CallKind::Client | CallKind::Bidi) && c.payload_tx.is_some()
    );
    if !ok {
        reply(
            events,
            json!({"action": "halfClose", "event": "error",
                "error": "当前没有进行中的 client/bidi streaming 调用"}),
        );
        return;
    }
    // 丢弃写端：请求流结束（半关闭），响应仍由调用任务继续回推
    if let Some(call) = active.as_mut() {
        call.payload_tx.take();
    }
    receipt(events, data);
}

// ---------------------------------------------------------------------------
// 测试：tonic echo 服务（覆盖四种调用形态 + reflection / protoText 两条发现路径）
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;
    use tokio_stream::wrappers::TcpListenerStream;
    use tonic::transport::Server;

    /// build.rs 生成的 echo 服务代码（proto/echo.proto）
    pub mod echo {
        include!(concat!(env!("OUT_DIR"), "/rabbitpost.test.echo.rs"));
    }

    const ECHO_FDS: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/echo_descriptor.bin"));
    const PROTO_TEXT: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/proto/echo.proto"));

    use echo::echo_server::{Echo, EchoServer};
    use echo::{EchoRequest, EchoResponse};
    use tonic::Response;

    #[derive(Default)]
    struct EchoSvc;

    #[tonic::async_trait]
    impl Echo for EchoSvc {
        async fn unary(
            &self,
            request: Request<EchoRequest>,
        ) -> Result<Response<EchoResponse>, Status> {
            let r = request.into_inner();
            Ok(Response::new(EchoResponse {
                text: format!("echo: {}", r.text),
                seq: 0,
            }))
        }

        type ServerStreamStream = ReceiverStream<Result<EchoResponse, Status>>;

        async fn server_stream(
            &self,
            request: Request<EchoRequest>,
        ) -> Result<Response<Self::ServerStreamStream>, Status> {
            let r = request.into_inner();
            let n = if r.count > 0 { r.count } else { 3 };
            let (tx, rx) = mpsc::channel(8);
            tokio::spawn(async move {
                for i in 0..n {
                    let msg = EchoResponse {
                        text: format!("{}#{i}", r.text),
                        seq: i,
                    };
                    if tx.send(Ok(msg)).await.is_err() {
                        break;
                    }
                }
            });
            Ok(Response::new(ReceiverStream::new(rx)))
        }

        async fn client_stream(
            &self,
            request: Request<tonic::Streaming<EchoRequest>>,
        ) -> Result<Response<EchoResponse>, Status> {
            let mut stream = request.into_inner();
            let mut parts = Vec::new();
            while let Some(r) = stream.message().await? {
                parts.push(r.text);
            }
            Ok(Response::new(EchoResponse {
                text: format!("echo: {}", parts.join(",")),
                seq: 0,
            }))
        }

        type BidiStream = ReceiverStream<Result<EchoResponse, Status>>;

        async fn bidi(
            &self,
            request: Request<tonic::Streaming<EchoRequest>>,
        ) -> Result<Response<Self::BidiStream>, Status> {
            let mut stream = request.into_inner();
            let (tx, rx) = mpsc::channel(8);
            tokio::spawn(async move {
                let mut seq = 0;
                while let Ok(Some(r)) = stream.message().await {
                    let msg = EchoResponse { text: r.text, seq };
                    seq += 1;
                    if tx.send(Ok(msg)).await.is_err() {
                        break;
                    }
                }
            });
            Ok(Response::new(ReceiverStream::new(rx)))
        }
    }

    /// 起本地 echo 服务（可选挂 reflection），返回 host:port
    async fn spawn_echo_server(with_reflection: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let incoming = TcpListenerStream::new(listener);
            let echo = EchoServer::new(EchoSvc);
            if with_reflection {
                let reflection = tonic_reflection::server::Builder::configure()
                    .register_encoded_file_descriptor_set(ECHO_FDS)
                    .build_v1alpha()
                    .unwrap();
                Server::builder()
                    .add_service(echo)
                    .add_service(reflection)
                    .serve_with_incoming(incoming)
                    .await
                    .unwrap();
            } else {
                Server::builder()
                    .add_service(echo)
                    .serve_with_incoming(incoming)
                    .await
                    .unwrap();
            }
        });
        format!("{addr}")
    }

    type SessionHandle = (
        mpsc::Sender<SessionCtl>,
        mpsc::UnboundedReceiver<Value>,
        tokio::task::JoinHandle<()>,
    );

    async fn start_session(address: String, config: Option<Value>) -> SessionHandle {
        let (ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, ev_rx) = mpsc::unbounded_channel();
        let handle = tokio::spawn(run_grpc_session(
            GrpcSessionConfig::from_parts(address, config),
            ctl_rx,
            ev_tx,
        ));
        (ctl_tx, ev_rx, handle)
    }

    async fn next_event(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for session event")
            .expect("event channel closed unexpectedly")
    }

    /// 收到下一条 dir=in 的协议消息并解析 data 为 JSON
    async fn next_reply(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        let ev = next_event(rx).await;
        assert_eq!(ev["t"], "message", "unexpected event: {ev}");
        assert_eq!(ev["dir"], "in", "unexpected event: {ev}");
        serde_json::from_str(ev["data"].as_str().unwrap()).unwrap()
    }

    async fn send_action(ctl: &mpsc::Sender<SessionCtl>, action: Value) {
        ctl.send(SessionCtl::Send {
            data: action.to_string(),
            encoding: "text".to_string(),
        })
        .await
        .unwrap();
    }

    /// 等待 status open 并返回 serviceList 消息
    async fn wait_open(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        assert_eq!(next_event(rx).await["state"], "connecting");
        let ev = next_event(rx).await;
        assert_eq!(ev["state"], "open", "unexpected event: {ev}");
        let list = next_reply(rx).await;
        assert_eq!(list["action"], "serviceList");
        list
    }

    #[tokio::test]
    async fn grpc_reflection_discovers_services() {
        let addr = spawn_echo_server(true).await;
        let (_ctl, mut ev_rx, _h) = start_session(addr, None).await;
        let list = wait_open(&mut ev_rx).await;
        let services = list["result"]["services"].as_array().unwrap();
        let echo = services
            .iter()
            .find(|s| s["name"] == "rabbitpost.test.echo.Echo")
            .expect("serviceList 应包含 Echo 服务");
        let methods = echo["methods"].as_array().unwrap();
        assert_eq!(methods.len(), 4);
        let unary = methods.iter().find(|m| m["name"] == "Unary").unwrap();
        assert_eq!(unary["requestStream"], false);
        assert_eq!(unary["responseStream"], false);
        // requestExample：标量默认值 + 嵌套消息展开一层
        assert_eq!(
            unary["requestExample"],
            json!({"text": "", "count": 0, "nested": {"label": ""}})
        );
        let bidi = methods.iter().find(|m| m["name"] == "Bidi").unwrap();
        assert_eq!(bidi["requestStream"], true);
        assert_eq!(bidi["responseStream"], true);
    }

    #[tokio::test]
    async fn grpc_unary_invoke_via_reflection() {
        let addr = spawn_echo_server(true).await;
        let (ctl, mut ev_rx, _h) = start_session(addr, None).await;
        wait_open(&mut ev_rx).await;

        send_action(
            &ctl,
            json!({"action": "invoke", "service": "rabbitpost.test.echo.Echo",
                "method": "Unary", "payload": {"text": "hi"}}),
        )
        .await;
        // out 回执先行
        let out = next_event(&mut ev_rx).await;
        assert_eq!(out["t"], "message");
        assert_eq!(out["dir"], "out");
        let data = next_reply(&mut ev_rx).await;
        assert_eq!(data["event"], "data");
        assert_eq!(data["payload"]["text"], "echo: hi");
        let end = next_reply(&mut ev_rx).await;
        assert_eq!(end["event"], "end");
        assert_eq!(end["status"]["code"], 0);
    }

    #[tokio::test]
    async fn grpc_server_streaming() {
        let addr = spawn_echo_server(true).await;
        let (ctl, mut ev_rx, _h) = start_session(addr, None).await;
        wait_open(&mut ev_rx).await;

        send_action(
            &ctl,
            json!({"action": "invoke", "service": "rabbitpost.test.echo.Echo",
                "method": "ServerStream", "payload": {"text": "s", "count": 2}}),
        )
        .await;
        next_event(&mut ev_rx).await; // out 回执
        let d1 = next_reply(&mut ev_rx).await;
        assert_eq!(d1["payload"]["text"], "s#0");
        let d2 = next_reply(&mut ev_rx).await;
        assert_eq!(d2["payload"]["text"], "s#1");
        let end = next_reply(&mut ev_rx).await;
        assert_eq!(end["event"], "end");
        assert_eq!(end["status"]["code"], 0);
    }

    #[tokio::test]
    async fn grpc_client_streaming() {
        let addr = spawn_echo_server(true).await;
        let (ctl, mut ev_rx, _h) = start_session(addr, None).await;
        wait_open(&mut ev_rx).await;

        send_action(
            &ctl,
            json!({"action": "invoke", "service": "rabbitpost.test.echo.Echo",
                "method": "ClientStream", "payload": {"text": "a"}}),
        )
        .await;
        next_event(&mut ev_rx).await; // invoke out 回执
        send_action(&ctl, json!({"action": "push", "payload": {"text": "b"}})).await;
        next_event(&mut ev_rx).await; // push out 回执
        send_action(&ctl, json!({"action": "halfClose"})).await;
        next_event(&mut ev_rx).await; // halfClose out 回执
        let data = next_reply(&mut ev_rx).await;
        assert_eq!(data["event"], "data");
        assert_eq!(data["payload"]["text"], "echo: a,b");
        let end = next_reply(&mut ev_rx).await;
        assert_eq!(end["event"], "end");
    }

    #[tokio::test]
    async fn grpc_bidi_streaming() {
        let addr = spawn_echo_server(true).await;
        let (ctl, mut ev_rx, _h) = start_session(addr, None).await;
        wait_open(&mut ev_rx).await;

        send_action(
            &ctl,
            json!({"action": "invoke", "service": "rabbitpost.test.echo.Echo",
                "method": "Bidi", "payload": {"text": "x"}}),
        )
        .await;
        next_event(&mut ev_rx).await; // out 回执
        let d1 = next_reply(&mut ev_rx).await;
        assert_eq!(d1["payload"]["text"], "x");
        send_action(&ctl, json!({"action": "push", "payload": {"text": "y"}})).await;
        next_event(&mut ev_rx).await; // push 回执
        let d2 = next_reply(&mut ev_rx).await;
        assert_eq!(d2["payload"]["text"], "y");
        send_action(&ctl, json!({"action": "halfClose"})).await;
        next_event(&mut ev_rx).await; // halfClose 回执
        let end = next_reply(&mut ev_rx).await;
        assert_eq!(end["event"], "end");
        assert_eq!(end["status"]["code"], 0);
    }

    #[tokio::test]
    async fn grpc_single_flight_and_unknown_method() {
        let addr = spawn_echo_server(true).await;
        let (ctl, mut ev_rx, _h) = start_session(addr, None).await;
        wait_open(&mut ev_rx).await;

        // bidi 调用保持进行中，期间再 invoke 应报单 flight 错误
        send_action(
            &ctl,
            json!({"action": "invoke", "service": "rabbitpost.test.echo.Echo",
                "method": "Bidi", "payload": {"text": "x"}}),
        )
        .await;
        next_event(&mut ev_rx).await; // out 回执
        next_reply(&mut ev_rx).await; // 首条 data

        send_action(
            &ctl,
            json!({"action": "invoke", "service": "rabbitpost.test.echo.Echo",
                "method": "Unary", "payload": {}}),
        )
        .await;
        let err = next_reply(&mut ev_rx).await;
        assert_eq!(err["event"], "error");
        assert!(err["error"].as_str().unwrap().contains("已有进行中的调用"));

        // 结束 bidi 后未知方法报错
        send_action(&ctl, json!({"action": "halfClose"})).await;
        next_event(&mut ev_rx).await; // halfClose 回执
        next_reply(&mut ev_rx).await; // end

        send_action(
            &ctl,
            json!({"action": "invoke", "service": "rabbitpost.test.echo.Echo",
                "method": "Nope"}),
        )
        .await;
        let err = next_reply(&mut ev_rx).await;
        assert_eq!(err["event"], "error");
        assert!(err["error"].as_str().unwrap().contains("方法不存在"));
    }

    #[tokio::test]
    async fn grpc_proto_text_fallback() {
        // 不挂 reflection：reflection 失败后回退 protoText
        let addr = spawn_echo_server(false).await;
        let (ctl, mut ev_rx, _h) =
            start_session(addr, Some(json!({"protoText": PROTO_TEXT}))).await;
        let list = wait_open(&mut ev_rx).await;
        let services = list["result"]["services"].as_array().unwrap();
        assert!(services
            .iter()
            .any(|s| s["name"] == "rabbitpost.test.echo.Echo"));

        send_action(
            &ctl,
            json!({"action": "invoke", "service": "rabbitpost.test.echo.Echo",
                "method": "Unary", "payload": {"text": "via-proto"}}),
        )
        .await;
        next_event(&mut ev_rx).await; // out 回执
        let data = next_reply(&mut ev_rx).await;
        assert_eq!(data["payload"]["text"], "echo: via-proto");
        let end = next_reply(&mut ev_rx).await;
        assert_eq!(end["event"], "end");
    }

    #[tokio::test]
    async fn grpc_unreachable_reports_status_error() {
        let (_ctl, mut ev_rx, handle) = start_session("127.0.0.1:1".to_string(), None).await;
        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["t"], "status");
        assert_eq!(ev["state"], "error");
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn grpc_close_emits_closed() {
        let addr = spawn_echo_server(true).await;
        let (ctl, mut ev_rx, handle) = start_session(addr, None).await;
        wait_open(&mut ev_rx).await;
        ctl.send(SessionCtl::Close).await.unwrap();
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["t"], "status");
        assert_eq!(ev["state"], "closed");
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .unwrap()
            .unwrap();
    }
}
