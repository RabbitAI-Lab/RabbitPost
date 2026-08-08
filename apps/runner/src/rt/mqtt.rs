//! MQTT 协议 session：rumqttc AsyncClient 连接 broker，事件经 channel 回传。
//! 帧契约与 apps/api/src/lib/rt.ts（帧契约） 一致（status/message/error 形状）。
//! - url：mqtt://host:port（默认 1883）、mqtts://（默认 8883，rustls + 系统根证书）；
//!   ws(s):// 暂不支持，明确报错。
//! - 消息帧（in/out 的 data 字段，JSON 字符串）：{ "topic", "payload", "qos", "retain" }
//! - 发送动作帧：{"action":"subscribe"|"unsubscribe"|"publish", ...}

use std::sync::Arc;
use std::time::Duration;

use rumqttc::{AsyncClient, ConnectionError, Event, Incoming, LastWill, MqttOptions, QoS, Transport};
use serde_json::{json, Value};
use tokio::sync::mpsc;

use super::SessionCtl;

/// 遗嘱消息（Last Will）配置
pub struct WillConfig {
    pub topic: String,
    pub payload: String,
    pub qos: QoS,
    pub retain: bool,
}

/// MQTT session 连接参数（从 downlink start 指令的 config 解析）
pub struct MqttSessionConfig {
    pub url: String,
    pub client_id: String,
    pub username: Option<String>,
    pub password: Option<String>,
    /// clean session，默认 true
    pub clean: bool,
    /// 心跳间隔（秒）
    pub keep_alive: Option<u64>,
    pub will: Option<WillConfig>,
}

impl MqttSessionConfig {
    /// config 形状（与 apps/api/src/lib/rt.ts（帧契约） 一致）：
    /// `{ clientId?, username?, password?, clean?, keepAlive?, willTopic?, willPayload?, willQos?, willRetain? }`
    pub fn from_parts(url: String, config: Option<Value>) -> Self {
        let cfg = config.unwrap_or(Value::Null);
        let client_id = cfg
            .get("clientId")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(default_client_id);
        let will = cfg.get("willTopic").and_then(Value::as_str).map(|topic| {
            WillConfig {
                topic: topic.to_string(),
                payload: cfg
                    .get("willPayload")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                qos: json_qos(cfg.get("willQos")).unwrap_or(QoS::AtMostOnce),
                retain: cfg
                    .get("willRetain")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
            }
        });
        Self {
            url,
            client_id,
            username: cfg
                .get("username")
                .and_then(Value::as_str)
                .map(str::to_string),
            password: cfg
                .get("password")
                .and_then(Value::as_str)
                .map(str::to_string),
            clean: cfg.get("clean").and_then(Value::as_bool).unwrap_or(true),
            keep_alive: cfg.get("keepAlive").and_then(Value::as_u64),
            will,
        }
    }
}

/// 网关端 clientId 形如 rabbitpost-<8 位 hex>；无 rand 依赖，用时间戳异或进程号凑
fn default_client_id() -> String {
    let seed = now_ms() as u64 ^ (std::process::id() as u64) << 16;
    format!("rabbitpost-{seed:08x}")
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn send(events: &mpsc::UnboundedSender<Value>, event: Value) {
    let _ = events.send(event);
}

/// config 里的 qos 字段：0/1/2，缺省 0
fn json_qos(v: Option<&Value>) -> Result<QoS, String> {
    match v.and_then(Value::as_u64) {
        None => Ok(QoS::AtMostOnce),
        Some(0) => Ok(QoS::AtMostOnce),
        Some(1) => Ok(QoS::AtLeastOnce),
        Some(2) => Ok(QoS::ExactlyOnce),
        Some(n) => Err(format!("qos 仅支持 0/1/2，收到 {n}")),
    }
}

/// broker 地址与传输方式
#[derive(Debug)]
enum BrokerTransport {
    Plain,
    Tls,
}

/// 解析 mqtt:// 与 mqtts://（host[:port][/path]，path 忽略）；ws(s):// 明确报错
fn parse_broker(url: &str) -> Result<(String, u16, BrokerTransport), String> {
    let (rest, default_port, transport) = if let Some(rest) = url.strip_prefix("mqtt://") {
        (rest, 1883, BrokerTransport::Plain)
    } else if let Some(rest) = url.strip_prefix("mqtts://") {
        (rest, 8883, BrokerTransport::Tls)
    } else if url.starts_with("ws://") || url.starts_with("wss://") {
        return Err("runner 端暂不支持 ws(s):// MQTT，请改用 mqtt:// 或 mqtts://".to_string());
    } else {
        return Err(format!("MQTT url 需以 mqtt:// 或 mqtts:// 开头：{url}"));
    };
    let authority = rest.split('/').next().unwrap_or("");
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => {
            let port = p
                .parse::<u16>()
                .map_err(|_| format!("MQTT url 端口非法：{authority}"))?;
            (h.to_string(), port)
        }
        None => (authority.to_string(), default_port),
    };
    if host.is_empty() {
        return Err(format!("MQTT url 缺少 host：{url}"));
    }
    Ok((host, port, transport))
}

/// mqtts:// 传输：rustls + 系统根证书
fn tls_transport() -> Result<Transport, String> {
    use rumqttc::tokio_rustls::rustls;
    let mut roots = rustls::RootCertStore::empty();
    let certs = rustls_native_certs::load_native_certs()
        .map_err(|e| format!("加载系统根证书失败：{e}"))?;
    for cert in certs {
        roots
            .add(cert)
            .map_err(|e| format!("系统根证书无效：{e}"))?;
    }
    let config = rustls::ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Ok(Transport::Tls(rumqttc::TlsConfiguration::Rustls(Arc::new(
        config,
    ))))
}

/// 运行一个 MQTT session 直到连接结束；事件（不带 id）逐条送入 events。
pub async fn run_mqtt_session(
    cfg: MqttSessionConfig,
    mut ctl: mpsc::Receiver<SessionCtl>,
    events: mpsc::UnboundedSender<Value>,
) {
    send(&events, json!({"t": "status", "state": "connecting"}));

    let (host, port, transport) = match parse_broker(&cfg.url) {
        Ok(parsed) => parsed,
        Err(reason) => {
            send(&events, json!({"t": "status", "state": "error", "reason": reason}));
            return;
        }
    };

    let mut options = MqttOptions::new(cfg.client_id, host, port);
    options.set_clean_session(cfg.clean);
    if let (Some(username), password) = (cfg.username, cfg.password) {
        options.set_credentials(username, password.unwrap_or_default());
    }
    if let Some(secs) = cfg.keep_alive {
        options.set_keep_alive(Duration::from_secs(secs));
    }
    if let Some(will) = cfg.will {
        options.set_last_will(LastWill::new(will.topic, will.payload, will.qos, will.retain));
    }
    if let BrokerTransport::Tls = transport {
        match tls_transport() {
            Ok(t) => {
                options.set_transport(t);
            }
            Err(reason) => {
                send(&events, json!({"t": "status", "state": "error", "reason": reason}));
                return;
            }
        }
    }

    let (client, mut eventloop) = AsyncClient::new(options, 64);

    // EventLoop 独立 task 驱动：网络事件经内部 channel 交给主循环统一转成 session 事件；
    // poll 出错（含连接被拒）按 gateway 行为：报错并结束，不做自动重连
    let (net_tx, mut net_rx) = mpsc::channel::<Result<Event, ConnectionError>>(64);
    let driver = tokio::spawn(async move {
        loop {
            let event = eventloop.poll().await;
            let fatal = event.is_err();
            if net_tx.send(event).await.is_err() || fatal {
                break;
            }
        }
    });

    let mut opened = false;
    loop {
        tokio::select! {
            net = net_rx.recv() => {
                match net {
                    Some(Ok(Event::Incoming(Incoming::ConnAck(_)))) => {
                        opened = true;
                        send(&events, json!({"t": "status", "state": "open"}));
                    }
                    Some(Ok(Event::Incoming(Incoming::Publish(p)))) => {
                        send(&events, json!({
                            "t": "message", "dir": "in",
                            "data": serde_json::to_string(&json!({
                                "topic": p.topic,
                                "payload": String::from_utf8_lossy(&p.payload),
                                "qos": p.qos as u8,
                                "retain": p.retain,
                            })).unwrap_or_default(),
                            "encoding": "text", "ts": now_ms(),
                        }));
                    }
                    Some(Ok(Event::Incoming(Incoming::Disconnect))) => {
                        send(&events, json!({"t": "status", "state": "closed"}));
                        break;
                    }
                    // SubAck/PubAck/PingResp 等无需上报
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        send(&events, json!({"t": "error", "message": e.to_string()}));
                        send(&events, json!({"t": "status", "state": "closed"}));
                        break;
                    }
                    // driver 意外退出（不应发生）：按断线处理
                    None => {
                        if opened {
                            send(&events, json!({"t": "status", "state": "closed"}));
                        }
                        break;
                    }
                }
            }
            command = ctl.recv() => {
                match command {
                    Some(SessionCtl::Send { data, .. }) => {
                        handle_action(&client, &events, &data).await;
                    }
                    // 控制通道关闭（downlink 断开）等价于 close：优雅收尾
                    Some(SessionCtl::Close) | None => {
                        let _ = client.disconnect().await;
                        send(&events, json!({
                            "t": "status", "state": "closed", "reason": "closed by client",
                        }));
                        break;
                    }
                }
            }
        }
    }
    driver.abort();
}

/// 处理一帧发送动作（JSON 字符串）：subscribe / unsubscribe / publish
async fn handle_action(
    client: &AsyncClient,
    events: &mpsc::UnboundedSender<Value>,
    data: &str,
) {
    let action: Value = match serde_json::from_str(data) {
        Ok(v) => v,
        Err(_) => {
            send(
                events,
                json!({"t": "error", "message": "发送内容需为 JSON 动作帧（subscribe/unsubscribe/publish）"}),
            );
            return;
        }
    };
    match action.get("action").and_then(Value::as_str) {
        Some("subscribe") => {
            let Some(topic) = action.get("topic").and_then(Value::as_str) else {
                send(events, json!({"t": "error", "message": "subscribe 缺少 topic"}));
                return;
            };
            let qos = match json_qos(action.get("qos")) {
                Ok(q) => q,
                Err(message) => {
                    send(events, json!({"t": "error", "message": message}));
                    return;
                }
            };
            match client.subscribe(topic, qos).await {
                Ok(()) => send(events, json!({
                    "t": "message", "dir": "out",
                    "data": serde_json::to_string(&json!({
                        "topic": topic,
                        "payload": format!("[已订阅] qos={}", qos as u8),
                    })).unwrap_or_default(),
                    "encoding": "text", "ts": now_ms(),
                })),
                Err(e) => send(events, json!({
                    "t": "error", "message": format!("订阅失败：{e}"),
                })),
            }
        }
        Some("unsubscribe") => {
            let Some(topic) = action.get("topic").and_then(Value::as_str) else {
                send(events, json!({"t": "error", "message": "unsubscribe 缺少 topic"}));
                return;
            };
            if let Err(e) = client.unsubscribe(topic).await {
                send(events, json!({"t": "error", "message": format!("退订失败：{e}")}));
            }
        }
        Some("publish") => {
            let Some(topic) = action.get("topic").and_then(Value::as_str) else {
                send(events, json!({"t": "error", "message": "publish 缺少 topic"}));
                return;
            };
            let payload = action
                .get("payload")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let qos = match json_qos(action.get("qos")) {
                Ok(q) => q,
                Err(message) => {
                    send(events, json!({"t": "error", "message": message}));
                    return;
                }
            };
            let retain = action
                .get("retain")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            match client.publish(topic, qos, retain, payload.clone()).await {
                // 受理成功：回推 out 原信息
                Ok(()) => send(events, json!({
                    "t": "message", "dir": "out",
                    "data": serde_json::to_string(&json!({
                        "topic": topic,
                        "payload": payload,
                        "qos": qos as u8,
                        "retain": retain,
                    })).unwrap_or_default(),
                    "encoding": "text", "ts": now_ms(),
                })),
                Err(e) => send(events, json!({
                    "t": "error", "message": format!("发布失败：{e}"),
                })),
            }
        }
        other => send(events, json!({
            "t": "error",
            "message": format!("未知动作：{}", other.unwrap_or("<missing>")),
        })),
    }
}

// ---------------------------------------------------------------------------
// 测试：最小 TCP MQTT 3.1.1 fake broker（固定字节回复），验证 subscribe/publish 链路
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// fake broker：CONNECT→CONNACK、SUBSCRIBE→SUBACK（授予请求的 qos）、
    /// UNSUBSCRIBE→UNSUBACK、QoS1 PUBLISH→PUBACK、DISCONNECT→关连接。
    /// 订阅成功后主动向客户端推一条 PUBLISH，验证 in 消息链路。
    async fn spawn_fake_broker() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    loop {
                        // 固定头：packet type + remaining length（变长编码）
                        let mut head = [0u8; 2];
                        if stream.read_exact(&mut head).await.is_err() {
                            return;
                        }
                        let packet_type = head[0] >> 4;
                        let mut remaining = (head[1] & 0x7f) as usize;
                        let mut shift = 7;
                        let mut byte = head[1];
                        while byte & 0x80 != 0 {
                            let mut b = [0u8; 1];
                            if stream.read_exact(&mut b).await.is_err() {
                                return;
                            }
                            byte = b[0];
                            remaining += ((byte & 0x7f) as usize) << shift;
                            shift += 7;
                        }
                        let mut body = vec![0u8; remaining];
                        if stream.read_exact(&mut body).await.is_err() {
                            return;
                        }
                        match packet_type {
                            // CONNECT → CONNACK（session present=0, rc=0）
                            1 => {
                                if stream.write_all(&[0x20, 0x02, 0x00, 0x00]).await.is_err() {
                                    return;
                                }
                            }
                            // SUBSCRIBE → SUBACK：pkid 为 body 前 2 字节，授予最后 1 字节的 qos
                            8 => {
                                let pkid = &body[0..2];
                                let granted = *body.last().unwrap_or(&0);
                                let suback = [0x90, 0x03, pkid[0], pkid[1], granted];
                                if stream.write_all(&suback).await.is_err() {
                                    return;
                                }
                                // 稍后推一条 PUBLISH（QoS0）验证 in 消息
                                let publish = build_publish("a/b", "hello");
                                tokio::time::sleep(Duration::from_millis(50)).await;
                                if stream.write_all(&publish).await.is_err() {
                                    return;
                                }
                            }
                            // PUBLISH：QoS1 需回 PUBACK，QoS0 忽略
                            3 => {
                                if head[0] & 0x06 == 0x02 {
                                    // body = topic len(2) + topic + pkid(2) + payload
                                    let topic_len =
                                        u16::from_be_bytes([body[0], body[1]]) as usize;
                                    let pkid = &body[2 + topic_len..4 + topic_len];
                                    let puback = [0x40, 0x02, pkid[0], pkid[1]];
                                    if stream.write_all(&puback).await.is_err() {
                                        return;
                                    }
                                }
                            }
                            // UNSUBSCRIBE → UNSUBACK
                            10 => {
                                let unsuback = [0xB0, 0x02, body[0], body[1]];
                                if stream.write_all(&unsuback).await.is_err() {
                                    return;
                                }
                            }
                            // DISCONNECT → 关闭
                            14 => return,
                            _ => {}
                        }
                    }
                });
            }
        });
        port
    }

    /// 组一条 QoS0 PUBLISH 包（仅用于测试包 < 128 字节）
    fn build_publish(topic: &str, payload: &str) -> Vec<u8> {
        let mut body = (topic.len() as u16).to_be_bytes().to_vec();
        body.extend_from_slice(topic.as_bytes());
        body.extend_from_slice(payload.as_bytes());
        let mut packet = vec![0x30, body.len() as u8];
        packet.extend_from_slice(&body);
        packet
    }

    async fn next_event(rx: &mut mpsc::UnboundedReceiver<Value>) -> Value {
        tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for session event")
            .expect("event channel closed unexpectedly")
    }

    #[test]
    fn mqtt_config_parsing() {
        // 缺省：clean=true，clientId 自动生成
        let cfg = MqttSessionConfig::from_parts("mqtt://h:1".to_string(), None);
        assert!(cfg.clean);
        assert!(cfg.client_id.starts_with("rabbitpost-"));
        assert!(cfg.will.is_none());

        let cfg = MqttSessionConfig::from_parts(
            "mqtt://h:1".to_string(),
            Some(json!({
                "clientId": "dev-1", "username": "u", "password": "p",
                "clean": false, "keepAlive": 30,
                "willTopic": "w/t", "willPayload": "bye", "willQos": 1, "willRetain": true,
            })),
        );
        assert_eq!(cfg.client_id, "dev-1");
        assert_eq!(cfg.username.as_deref(), Some("u"));
        assert!(!cfg.clean);
        assert_eq!(cfg.keep_alive, Some(30));
        let will = cfg.will.unwrap();
        assert_eq!(will.topic, "w/t");
        assert_eq!(will.payload, "bye");
        assert_eq!(will.qos, QoS::AtLeastOnce);
        assert!(will.retain);
    }

    #[test]
    fn mqtt_url_parsing() {
        let (h, p, t) = parse_broker("mqtt://broker.local").unwrap();
        assert_eq!((h.as_str(), p), ("broker.local", 1883));
        assert!(matches!(t, BrokerTransport::Plain));
        let (h, p, t) = parse_broker("mqtts://broker.local:8884/path").unwrap();
        assert_eq!((h.as_str(), p), ("broker.local", 8884));
        assert!(matches!(t, BrokerTransport::Tls));
        assert!(parse_broker("ws://broker.local/mqtt").unwrap_err().contains("暂不支持"));
        assert!(parse_broker("http://broker.local").is_err());
        assert!(parse_broker("mqtt://").is_err());
    }

    #[tokio::test]
    async fn mqtt_session_subscribe_publish_roundtrip() {
        let port = spawn_fake_broker().await;
        let (ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let session = tokio::spawn(run_mqtt_session(
            MqttSessionConfig::from_parts(format!("mqtt://127.0.0.1:{port}"), None),
            ctl_rx,
            ev_tx,
        ));

        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        assert_eq!(next_event(&mut ev_rx).await["state"], "open");

        // subscribe：受理回 out 回执
        ctl_tx
            .send(SessionCtl::Send {
                data: r#"{"action":"subscribe","topic":"a/b","qos":1}"#.to_string(),
                encoding: "text".to_string(),
            })
            .await
            .unwrap();
        let out = next_event(&mut ev_rx).await;
        assert_eq!(out["t"], "message");
        assert_eq!(out["dir"], "out");
        let data: Value = serde_json::from_str(out["data"].as_str().unwrap()).unwrap();
        assert_eq!(data, json!({"topic": "a/b", "payload": "[已订阅] qos=1"}));
        assert_eq!(out["encoding"], "text");
        assert!(out["ts"].as_i64().unwrap() > 0);

        // broker 推送的 PUBLISH → in 消息
        let incoming = next_event(&mut ev_rx).await;
        assert_eq!(incoming["dir"], "in");
        let data: Value = serde_json::from_str(incoming["data"].as_str().unwrap()).unwrap();
        assert_eq!(
            data,
            json!({"topic": "a/b", "payload": "hello", "qos": 0, "retain": false})
        );

        // publish：受理回 out 原信息
        ctl_tx
            .send(SessionCtl::Send {
                data: r#"{"action":"publish","topic":"a/b","payload":"yo","qos":1,"retain":true}"#
                    .to_string(),
                encoding: "text".to_string(),
            })
            .await
            .unwrap();
        let out = next_event(&mut ev_rx).await;
        assert_eq!(out["dir"], "out");
        let data: Value = serde_json::from_str(out["data"].as_str().unwrap()).unwrap();
        assert_eq!(
            data,
            json!({"topic": "a/b", "payload": "yo", "qos": 1, "retain": true})
        );

        // 错误路径：非 JSON、未知动作、缺 topic、非法 qos
        for (bad, expect) in [
            ("not json", "发送内容需为 JSON 动作帧"),
            (r#"{"action":"noop"}"#, "未知动作：noop"),
            (r#"{"action":"subscribe"}"#, "subscribe 缺少 topic"),
            (r#"{"action":"publish","topic":"a/b","qos":3}"#, "qos 仅支持 0/1/2"),
        ] {
            ctl_tx
                .send(SessionCtl::Send {
                    data: bad.to_string(),
                    encoding: "text".to_string(),
                })
                .await
                .unwrap();
            let ev = next_event(&mut ev_rx).await;
            assert_eq!(ev["t"], "error");
            assert!(
                ev["message"].as_str().unwrap().contains(expect),
                "unexpected error: {ev}"
            );
        }

        // close：回传 closed，任务结束
        ctl_tx.send(SessionCtl::Close).await.unwrap();
        let closed = next_event(&mut ev_rx).await;
        assert_eq!(closed["t"], "status");
        assert_eq!(closed["state"], "closed");
        tokio::time::timeout(Duration::from_secs(5), session)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn mqtt_session_reports_connect_error() {
        // 连接未监听端口：error 事件 + status closed（与 gateway 行为一致），任务退出
        let (_ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let session = tokio::spawn(run_mqtt_session(
            MqttSessionConfig::from_parts("mqtt://127.0.0.1:1".to_string(), None),
            ctl_rx,
            ev_tx,
        ));
        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        let mut saw_error = false;
        let mut saw_closed = false;
        for _ in 0..2 {
            let ev = next_event(&mut ev_rx).await;
            if ev["t"] == "error" {
                saw_error = true;
            }
            if ev["state"] == "closed" {
                saw_closed = true;
            }
        }
        assert!(saw_error && saw_closed);
        tokio::time::timeout(Duration::from_secs(5), session)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn mqtt_session_rejects_ws_url() {
        let (_ctl_tx, ctl_rx) = mpsc::channel(8);
        let (ev_tx, mut ev_rx) = mpsc::unbounded_channel();
        let session = tokio::spawn(run_mqtt_session(
            MqttSessionConfig::from_parts("ws://127.0.0.1:8083/mqtt".to_string(), None),
            ctl_rx,
            ev_tx,
        ));
        assert_eq!(next_event(&mut ev_rx).await["state"], "connecting");
        let ev = next_event(&mut ev_rx).await;
        assert_eq!(ev["state"], "error");
        assert!(ev["reason"].as_str().unwrap().contains("暂不支持"));
        tokio::time::timeout(Duration::from_secs(5), session)
            .await
            .unwrap()
            .unwrap();
    }
}
