//! lint 子命令：Collection 与 Spec（OpenAPI / AsyncAPI）的本地静态检查。
//!
//! Spec 规则移植自 packages/shared/src/spec-validate.ts（规则名沿用 Spectral，
//! 与 Web 端 Issues 面板一致）；差异：CLI 不计算行号/列号（path 已可定位）。
//! Collection 规则为 RabbitPost 内置最佳实践集（Postman 的云端治理规则无服务端对应）。
//!
//! 退出码约定：存在 error 级 issue 时返回 1，否则 0（CI 门禁可直接使用）。
use std::collections::{HashMap, HashSet};

use rp_core::model::RequestConfig;
use serde::Serialize;
use serde_json::Value;

use crate::convert::ImportedNode;

#[derive(Debug, Clone, Serialize)]
pub struct LintIssue {
    pub severity: String,
    pub rule: String,
    pub message: String,
    /// 定位路径，如 paths./pets.get.responses 或「文件夹 / 请求」
    pub path: String,
}

fn error(rule: &str, message: impl Into<String>, path: &str) -> LintIssue {
    LintIssue {
        severity: "error".to_string(),
        rule: rule.to_string(),
        message: message.into(),
        path: path.to_string(),
    }
}

fn warning(rule: &str, message: impl Into<String>, path: &str) -> LintIssue {
    LintIssue {
        severity: "warning".to_string(),
        rule: rule.to_string(),
        message: message.into(),
        path: path.to_string(),
    }
}

/// errors 在前、warnings 在后（各自保持发现顺序）
fn sort_issues(issues: &mut [LintIssue]) {
    issues.sort_by_key(|i| if i.severity == "error" { 0 } else { 1 });
}

pub fn summarize_issues(issues: &[LintIssue]) -> (usize, usize) {
    let errors = issues.iter().filter(|i| i.severity == "error").count();
    (errors, issues.len() - errors)
}

// ---------------------------------------------------------------------------
// Spec lint（OpenAPI 3.0 / 3.1 / AsyncAPI 2.0）
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpecType {
    Openapi30,
    Openapi31,
    Asyncapi2,
}

impl SpecType {
    pub fn parse(value: &str) -> anyhow::Result<Self> {
        match value {
            "openapi-3.0" => Ok(Self::Openapi30),
            "openapi-3.1" => Ok(Self::Openapi31),
            "asyncapi-2.0" => Ok(Self::Asyncapi2),
            other => anyhow::bail!(
                "invalid spec type `{other}`: expect openapi-3.0 / openapi-3.1 / asyncapi-2.0"
            ),
        }
    }

    fn is_asyncapi(self) -> bool {
        self == Self::Asyncapi2
    }
}

/// 从解析后的定义推断类型（未显式 --type 时）
fn detect_spec_type(data: &Value) -> Option<SpecType> {
    let version = data.get("openapi").and_then(Value::as_str);
    if let Some(v) = version {
        if v.starts_with("3.1") {
            return Some(SpecType::Openapi31);
        }
        if v.starts_with("3.0") {
            return Some(SpecType::Openapi30);
        }
    }
    let asyncapi = data.get("asyncapi").and_then(Value::as_str);
    if asyncapi.is_some_and(|v| v.starts_with("2.")) {
        return Some(SpecType::Asyncapi2);
    }
    // 字段存在但版本不认识：按 OpenAPI 3.0 校验以产生 spec-type-mismatch
    if version.is_some() {
        return Some(SpecType::Openapi30);
    }
    if asyncapi.is_some() {
        return Some(SpecType::Asyncapi2);
    }
    None
}

const HTTP_OPERATIONS: [&str; 8] = [
    "get", "put", "post", "delete", "options", "head", "patch", "trace",
];
const PARAMETER_LOCATIONS: [&str; 4] = ["path", "query", "header", "cookie"];

fn as_obj(value: &Value) -> Option<&serde_json::Map<String, Value>> {
    value.as_object()
}

fn as_text(value: Option<&Value>) -> &str {
    value.and_then(Value::as_str).unwrap_or("").trim()
}

/// 提取 URL 模板中的 {param} 占位符
fn template_params(template: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        if let Some(end) = rest[start..].find('}') {
            out.push(rest[start + 1..start + end].to_string());
            rest = &rest[start + end + 1..];
        } else {
            break;
        }
    }
    out
}

/// 递归收集 $ref 目标（未使用组件检测）
fn collect_refs(value: &Value, out: &mut HashSet<String>) {
    match value {
        Value::Array(list) => {
            for child in list {
                collect_refs(child, out);
            }
        }
        Value::Object(obj) => {
            for (key, child) in obj {
                if key == "$ref" {
                    if let Some(target) = child.as_str() {
                        out.insert(target.to_string());
                    }
                } else {
                    collect_refs(child, out);
                }
            }
        }
        _ => {}
    }
}

/// 校验 spec 定义正文（YAML 1.2 是 JSON 超集，统一按 YAML 解析）。
/// spec_type 为 None 时自动识别；识别不出按内容存在 openapi/asyncapi 字段兜底。
pub fn lint_spec(content: &str, spec_type: Option<SpecType>) -> anyhow::Result<Vec<LintIssue>> {
    if content.trim().is_empty() {
        return Ok(vec![error("spec-syntax", "定义内容为空", "")]);
    }
    let data: Value = serde_yaml::from_str(content)
        .map_err(|e| anyhow::anyhow!("spec YAML/JSON 解析失败：{e}"))?;
    if !data.is_object() {
        return Ok(vec![error("spec-syntax", "定义须为 YAML/JSON 对象", "")]);
    }

    let spec_type = match spec_type.or_else(|| detect_spec_type(&data)) {
        Some(t) => t,
        None => {
            return Ok(vec![error(
                "spec-syntax",
                "无法识别 spec 类型：缺少 openapi / asyncapi 版本字段",
                "",
            )])
        }
    };

    let mut issues = Vec::new();
    validate_info(&data, spec_type, &mut issues);
    if spec_type.is_asyncapi() {
        validate_asyncapi(&data, &mut issues);
    } else {
        validate_openapi(&data, spec_type, &mut issues);
    }
    sort_issues(&mut issues);
    Ok(issues)
}

/// 版本字段与 info 对象：OpenAPI / AsyncAPI 共用
fn validate_info(data: &Value, spec_type: SpecType, issues: &mut Vec<LintIssue>) {
    let async_api = spec_type.is_asyncapi();
    let version_key = if async_api { "asyncapi" } else { "openapi" };
    let expected_prefix = match spec_type {
        SpecType::Asyncapi2 => "2.",
        SpecType::Openapi31 => "3.1",
        SpecType::Openapi30 => "3.0",
    };
    let schema_rule = if async_api { "asyncapi-schema" } else { "oas3-schema" };
    let version = as_text(data.get(version_key));

    if version.is_empty() {
        issues.push(error(
            schema_rule,
            format!("定义缺少必填字段「{version_key}」"),
            "",
        ));
    } else if !version.starts_with(expected_prefix) {
        issues.push(error(
            "spec-type-mismatch",
            format!("{version_key}: {version} 与当前 spec 类型（要求 {expected_prefix}x）不一致"),
            version_key,
        ));
    }

    let Some(info) = as_obj(&data["info"]) else {
        issues.push(error(schema_rule, "定义缺少必填字段「info」", ""));
        return;
    };
    if as_text(info.get("title")).is_empty() {
        issues.push(error(schema_rule, "info 缺少必填字段「title」", "info"));
    }
    if as_text(info.get("version")).is_empty() {
        issues.push(error(schema_rule, "info 缺少必填字段「version」", "info"));
    }
    if as_text(info.get("description")).is_empty() {
        issues.push(warning(
            if async_api {
                "asyncapi-info-description"
            } else {
                "info-description"
            },
            "info 建议提供 description",
            "info",
        ));
    }
    if as_obj(info.get("contact").unwrap_or(&Value::Null)).is_none() {
        issues.push(warning(
            if async_api {
                "asyncapi-info-contact"
            } else {
                "info-contact"
            },
            "info 建议提供 contact 对象",
            "info",
        ));
    }
    if let Some(license) = as_obj(info.get("license").unwrap_or(&Value::Null)) {
        if as_text(license.get("url")).is_empty() && as_text(license.get("identifier")).is_empty() {
            issues.push(warning("license-url", "license 建议提供 url", "info.license"));
        }
    }
}

fn validate_openapi(data: &Value, spec_type: SpecType, issues: &mut Vec<LintIssue>) {
    match data.get("servers").and_then(Value::as_array) {
        Some(servers) if !servers.is_empty() => {
            for (i, server) in servers.iter().enumerate() {
                let obj = as_obj(server);
                if obj.is_none() || as_text(obj.and_then(|o| o.get("url"))).is_empty() {
                    issues.push(error(
                        "oas3-schema",
                        "server 缺少必填字段「url」",
                        &format!("servers.{i}"),
                    ));
                }
            }
        }
        _ => issues.push(warning(
            "oas3-api-servers",
            "定义建议提供非空的 servers 列表",
            "",
        )),
    }

    let mut defined_tags: HashSet<String> = HashSet::new();
    match data.get("tags").and_then(Value::as_array) {
        Some(tags) if !tags.is_empty() => {
            for (i, tag) in tags.iter().enumerate() {
                let obj = as_obj(tag);
                let name = as_text(obj.and_then(|o| o.get("name")));
                if name.is_empty() {
                    issues.push(error(
                        "oas3-schema",
                        "tag 缺少必填字段「name」",
                        &format!("tags.{i}"),
                    ));
                    continue;
                }
                defined_tags.insert(name.to_string());
                if as_text(obj.and_then(|o| o.get("description"))).is_empty() {
                    issues.push(warning(
                        "tag-description",
                        format!("tag「{name}」建议提供 description"),
                        &format!("tags.{i}"),
                    ));
                }
            }
        }
        _ => issues.push(warning(
            "openapi-tags",
            "定义建议提供非空的 tags 列表",
            "",
        )),
    }

    let paths = as_obj(&data["paths"]);
    let path_count = paths.map(|p| p.len()).unwrap_or(0);
    if path_count == 0 {
        let has_webhooks = as_obj(&data["webhooks"]).is_some_and(|w| !w.is_empty());
        if spec_type == SpecType::Openapi31 && has_webhooks {
            // 3.1 允许只描述 webhooks
        } else if spec_type == SpecType::Openapi31 {
            issues.push(warning("oas3-schema", "定义未包含任何 paths 或 webhooks", ""));
        } else {
            issues.push(error("oas3-schema", "定义缺少必填字段「paths」", ""));
        }
    }

    let mut operation_ids: HashMap<String, String> = HashMap::new();
    if let Some(paths) = paths {
        for (path_key, path_value) in paths {
            validate_path_item(path_key, path_value, &defined_tags, &mut operation_ids, issues);
        }
    }

    validate_unused_components(data, issues);
}

fn validate_path_item(
    path_key: &str,
    path_value: &Value,
    defined_tags: &HashSet<String>,
    operation_ids: &mut HashMap<String, String>,
    issues: &mut Vec<LintIssue>,
) {
    let base = format!("paths.{path_key}");
    if !path_key.starts_with('/') {
        issues.push(error(
            "oas3-schema",
            format!("path「{path_key}」必须以 / 开头"),
            &base,
        ));
    }
    if path_key.len() > 1 && path_key.ends_with('/') {
        issues.push(warning(
            "path-keys-no-trailing-slash",
            format!("path「{path_key}」不应以 / 结尾"),
            &base,
        ));
    }
    if path_key.contains('?') {
        issues.push(error(
            "path-not-include-query",
            format!("path「{path_key}」不能包含 query 串"),
            &base,
        ));
    }
    let declared = template_params(path_key);
    if declared.iter().any(|name| name.trim().is_empty()) {
        issues.push(error(
            "path-declarations-must-exist",
            format!("path「{path_key}」含空的 {{}} 占位符"),
            &base,
        ));
    }

    let Some(path_item) = as_obj(path_value) else {
        issues.push(error(
            "oas3-schema",
            format!("path「{path_key}」的值必须是对象"),
            &base,
        ));
        return;
    };

    let path_level_params = collect_parameters(path_item.get("parameters"), &base, issues);

    for method in HTTP_OPERATIONS {
        let Some(operation) = as_obj(path_item.get(method).unwrap_or(&Value::Null)) else {
            continue;
        };
        let op_path = format!("{base}.{method}");

        let operation_id = as_text(operation.get("operationId"));
        if operation_id.is_empty() {
            issues.push(warning(
                "operation-operationId",
                "操作建议提供 operationId",
                &op_path,
            ));
        } else if let Some(first) = operation_ids.get(operation_id) {
            issues.push(error(
                "operation-operationId-unique",
                format!("operationId「{operation_id}」重复（另见 {first}）"),
                &op_path,
            ));
        } else {
            operation_ids.insert(operation_id.to_string(), op_path.clone());
        }

        if as_text(operation.get("summary")).is_empty()
            && as_text(operation.get("description")).is_empty()
        {
            issues.push(warning(
                "operation-description",
                "操作建议提供 summary 或 description",
                &op_path,
            ));
        }

        let empty_tags = Vec::new();
        let op_tags = operation
            .get("tags")
            .and_then(Value::as_array)
            .unwrap_or(&empty_tags);
        if op_tags.is_empty() {
            issues.push(warning("operation-tags", "操作建议提供 tags", &op_path));
        } else {
            for tag in op_tags {
                let name = as_text(Some(tag));
                if !name.is_empty() && !defined_tags.contains(name) {
                    issues.push(warning(
                        "operation-tag-defined",
                        format!("操作使用的 tag「{name}」未在根级 tags 中定义"),
                        &op_path,
                    ));
                }
            }
        }

        match as_obj(operation.get("responses").unwrap_or(&Value::Null)) {
            Some(responses) if !responses.is_empty() => {
                for (code, response) in responses {
                    let res_obj = as_obj(response);
                    if res_obj.is_some_and(|o| o.contains_key("$ref")) {
                        continue;
                    }
                    if res_obj.is_none()
                        || as_text(res_obj.and_then(|o| o.get("description"))).is_empty()
                    {
                        issues.push(error(
                            "oas3-schema",
                            format!("响应「{code}」缺少必填字段「description」"),
                            &format!("{op_path}.responses.{code}"),
                        ));
                    }
                }
            }
            _ => issues.push(error(
                "operation-responses",
                "操作缺少必填字段「responses」",
                &op_path,
            )),
        }

        let op_params = collect_parameters(operation.get("parameters"), &op_path, issues);
        let effective: Vec<&(String, String)> = path_level_params.iter().chain(op_params.iter()).collect();
        let path_param_names: HashSet<&str> = effective
            .iter()
            .filter(|(_, location)| location == "path")
            .map(|(name, _)| name.as_str())
            .collect();
        for name in &declared {
            if !name.trim().is_empty() && !path_param_names.contains(name.trim()) {
                issues.push(error(
                    "path-params",
                    format!("path 占位符「{{{name}}}」未声明为 in: path 参数"),
                    &op_path,
                ));
            }
        }
        for (name, location) in &effective {
            if location == "path" && !declared.iter().any(|d| d == name) {
                issues.push(error(
                    "path-params",
                    format!("参数「{name}」声明为 in: path，但 path「{path_key}」中没有对应占位符"),
                    &op_path,
                ));
            }
        }
    }
}

/// 校验 parameters 数组并返回 (name, in) 条目（供 path 占位符匹配）
fn collect_parameters(
    value: Option<&Value>,
    base: &str,
    issues: &mut Vec<LintIssue>,
) -> Vec<(String, String)> {
    let Some(arr) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut result = Vec::new();
    for (i, raw) in arr.iter().enumerate() {
        let param_path = format!("{base}.parameters.{i}");
        let Some(obj) = as_obj(raw) else {
            issues.push(error("oas3-schema", "parameters 条目必须是对象", &param_path));
            continue;
        };
        // $ref 引用的参数不在此处展开校验
        if obj.contains_key("$ref") {
            continue;
        }
        let name = as_text(obj.get("name"));
        let location = as_text(obj.get("in"));
        if name.is_empty() {
            issues.push(error("oas3-schema", "参数缺少必填字段「name」", &param_path));
        }
        if location.is_empty() {
            issues.push(error("oas3-schema", "参数缺少必填字段「in」", &param_path));
        } else if !PARAMETER_LOCATIONS.contains(&location) {
            issues.push(error(
                "oas3-schema",
                format!("参数 in「{location}」非法，可选值：{}", PARAMETER_LOCATIONS.join(" / ")),
                &param_path,
            ));
        }
        if location == "path" && obj.get("required") != Some(&Value::Bool(true)) {
            issues.push(error(
                "path-params",
                format!("path 参数「{name}」必须声明 required: true"),
                &param_path,
            ));
        }
        if as_obj(obj.get("schema").unwrap_or(&Value::Null)).is_none()
            && as_obj(obj.get("content").unwrap_or(&Value::Null)).is_none()
        {
            issues.push(warning(
                "oas3-schema",
                format!("参数「{name}」建议提供 schema"),
                &param_path,
            ));
        }
        if !name.is_empty() && !location.is_empty() {
            result.push((name.to_string(), location.to_string()));
        }
    }
    result
}

fn validate_unused_components(data: &Value, issues: &mut Vec<LintIssue>) {
    let Some(schemas) = as_obj(&data["components"]).and_then(|c| as_obj(c.get("schemas")?))
    else {
        return;
    };
    let mut refs = HashSet::new();
    collect_refs(data, &mut refs);
    for name in schemas.keys() {
        if !refs.contains(&format!("#/components/schemas/{name}")) {
            issues.push(warning(
                "oas3-unused-component",
                format!("组件 schema「{name}」未被引用"),
                &format!("components.schemas.{name}"),
            ));
        }
    }
}

fn validate_asyncapi(data: &Value, issues: &mut Vec<LintIssue>) {
    match as_obj(&data["servers"]) {
        Some(servers) if !servers.is_empty() => {
            for (name, server) in servers {
                let obj = as_obj(server);
                if obj.is_none() || as_text(obj.and_then(|o| o.get("url"))).is_empty() {
                    issues.push(error(
                        "asyncapi-schema",
                        format!("server「{name}」缺少必填字段「url」"),
                        &format!("servers.{name}"),
                    ));
                }
                if obj.is_some() && as_text(obj.and_then(|o| o.get("protocol"))).is_empty() {
                    issues.push(error(
                        "asyncapi-schema",
                        format!("server「{name}」缺少必填字段「protocol」"),
                        &format!("servers.{name}"),
                    ));
                }
            }
        }
        _ => issues.push(warning(
            "asyncapi-servers",
            "定义建议提供非空的 servers",
            "",
        )),
    }

    let Some(channels) = as_obj(&data["channels"]) else {
        issues.push(error(
            "asyncapi-schema",
            "定义缺少必填字段「channels」",
            "",
        ));
        return;
    };
    if channels.is_empty() {
        issues.push(error(
            "asyncapi-schema",
            "定义缺少必填字段「channels」",
            "",
        ));
        return;
    }

    for (channel_name, channel_value) in channels {
        let base = format!("channels.{channel_name}");
        let Some(channel) = as_obj(channel_value) else {
            issues.push(error(
                "asyncapi-schema",
                format!("channel「{channel_name}」的值必须是对象"),
                &base,
            ));
            continue;
        };
        let operations: Vec<&str> = ["publish", "subscribe"]
            .into_iter()
            .filter(|k| as_obj(channel.get(*k).unwrap_or(&Value::Null)).is_some())
            .collect();
        if operations.is_empty() {
            issues.push(error(
                "asyncapi-channel-operations",
                format!("channel「{channel_name}」至少需要 publish 或 subscribe"),
                &base,
            ));
        }
        for kind in operations {
            let operation = as_obj(channel.get(kind).unwrap_or(&Value::Null)).unwrap();
            let op_path = format!("{base}.{kind}");
            if as_text(operation.get("operationId")).is_empty() {
                issues.push(warning(
                    "asyncapi-operation-operationId",
                    format!("{kind} 操作建议提供 operationId"),
                    &op_path,
                ));
            }
            if as_text(operation.get("summary")).is_empty()
                && as_text(operation.get("description")).is_empty()
            {
                issues.push(warning(
                    "asyncapi-operation-description",
                    format!("{kind} 操作建议提供 summary 或 description"),
                    &op_path,
                ));
            }
            if as_obj(operation.get("message").unwrap_or(&Value::Null)).is_none() {
                issues.push(warning(
                    "asyncapi-message-payload",
                    format!("{kind} 操作建议提供 message"),
                    &op_path,
                ));
            }
        }

        let empty = serde_json::Map::new();
        let declared_params = as_obj(channel.get("parameters").unwrap_or(&Value::Null)).unwrap_or(&empty);
        for name in template_params(channel_name) {
            if !declared_params.contains_key(&name) {
                issues.push(error(
                    "asyncapi-channel-parameters",
                    format!("channel 占位符「{{{name}}}」未在 parameters 中声明"),
                    &base,
                ));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Collection lint（内置最佳实践规则）
// ---------------------------------------------------------------------------

/// Collection lint 的可见变量作用域（unresolved-variable 规则用）
pub struct LintScope {
    pub variables: HashSet<String>,
}

/// 提取文本中的 {{var}} 引用；返回 (变量名列表, 语法是否完整)
fn extract_variables(text: &str) -> (Vec<String>, bool) {
    let opens = text.matches("{{").count();
    let closes = text.matches("}}").count();
    let mut names = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("{{") {
        if let Some(end) = rest[start..].find("}}") {
            names.push(rest[start + 2..start + end].trim().to_string());
            rest = &rest[start + end + 2..];
        } else {
            break;
        }
    }
    (names, opens == closes)
}

/// 校验 Collection 节点树。scope 提供可见变量（Collection 变量 + 可选环境 / globals）。
pub fn lint_collection(nodes: &[ImportedNode], scope: &LintScope) -> Vec<LintIssue> {
    let mut issues = Vec::new();
    lint_level(nodes, "", scope, &mut issues);
    sort_issues(&mut issues);
    issues
}

fn lint_level(
    nodes: &[ImportedNode],
    prefix: &str,
    scope: &LintScope,
    issues: &mut Vec<LintIssue>,
) {
    // duplicate-name：同级同名（warning）
    let mut seen: HashMap<&str, &str> = HashMap::new();
    for node in nodes {
        let (name, path) = match node {
            ImportedNode::Folder { name, .. } | ImportedNode::Request { name, .. } => {
                (name.as_str(), format!("{prefix}{name}"))
            }
        };
        if let Some(first) = seen.insert(name, name) {
            let _ = first;
            issues.push(warning(
                "duplicate-name",
                format!("同级存在重名条目「{name}」"),
                &path,
            ));
        }
        if name.trim().is_empty() {
            issues.push(error("empty-name", "条目名称不能为空", &path));
        }
        match node {
            ImportedNode::Folder { items, name, .. } => {
                lint_level(items, &format!("{prefix}{name} / "), scope, issues);
            }
            ImportedNode::Request { request, .. } => {
                lint_request(request.as_deref(), &path, scope, issues);
            }
        }
    }
}

fn lint_request(
    request: Option<&RequestConfig>,
    path: &str,
    scope: &LintScope,
    issues: &mut Vec<LintIssue>,
) {
    let Some(request) = request else {
        issues.push(error("empty-url", "请求缺少配置（未填写 URL）", path));
        return;
    };

    if request.url.trim().is_empty() {
        issues.push(error("empty-url", "请求 URL 不能为空", path));
    } else if request.url.trim_start().starts_with("http://") {
        issues.push(warning(
            "insecure-url",
            "请求使用 http:// 明文协议，建议改为 https://",
            path,
        ));
    }

    // 变量引用：url / headers / params / raw body
    let mut texts: Vec<&str> = vec![request.url.as_str()];
    for kv in request.headers.iter().chain(request.params.iter()) {
        if kv.enabled {
            texts.push(kv.key.as_str());
            texts.push(kv.value.as_str());
        }
    }
    if let Some(raw) = &request.body.raw {
        texts.push(raw.as_str());
    }
    let mut referenced: HashSet<String> = HashSet::new();
    for text in texts {
        let (names, balanced) = extract_variables(text);
        if !balanced {
            issues.push(error(
                "invalid-variable-syntax",
                "存在不完整的 {{ }} 变量引用",
                path,
            ));
        }
        for name in names {
            if name.is_empty() {
                issues.push(error("invalid-variable-syntax", "存在空的 {{}} 变量引用", path));
            } else {
                referenced.insert(name);
            }
        }
    }
    for name in referenced {
        if !scope.variables.contains(&name) {
            issues.push(warning(
                "unresolved-variable",
                format!("变量「{{{{{name}}}}}」不在可见作用域内（Collection 变量 / 环境 / globals）"),
                path,
            ));
        }
    }

    let has_tests = request
        .scripts
        .test
        .as_deref()
        .is_some_and(|code| !code.trim().is_empty());
    if !has_tests {
        issues.push(warning(
            "no-tests",
            "请求缺少 Tests 脚本（建议至少断言状态码）",
            path,
        ));
    }
}

// ---------------------------------------------------------------------------
// 子命令入口
// ---------------------------------------------------------------------------

use rp_core::model::CollectionItemNode;

use crate::client::CliApi;
use crate::output::print_json;

/// 服务端树节点 -> 导入节点（collection lint 与 run --file 共用同一套规则）
fn server_node(node: &CollectionItemNode) -> ImportedNode {
    if node.item_type == "folder" {
        ImportedNode::Folder {
            name: node.name.clone(),
            description: node.description.clone(),
            items: node.children.iter().map(server_node).collect(),
        }
    } else {
        ImportedNode::Request {
            name: node.name.clone(),
            request: node.request.clone().map(Box::new),
        }
    }
}

/// 从 --env-file / --globals 文件补充可见变量（ lint 的 unresolved-variable 作用域）
fn load_scope_file(scope: &mut LintScope, path: &str) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("cannot read {path}: {e}"))?;
    let (_name, vars) = crate::convert::parse_environment_file(&text)?;
    scope.variables.extend(vars.into_iter().map(|(k, _)| k));
    Ok(())
}

fn print_issues(target: &str, issues: &[LintIssue]) -> (usize, usize) {
    let (errors, warnings) = summarize_issues(issues);
    for issue in issues {
        eprintln!(
            "{} [{}] {} ({})",
            issue.severity.to_uppercase(),
            issue.rule,
            issue.message,
            issue.path
        );
    }
    print_json(&serde_json::json!({
        "target": target,
        "issues": issues,
        "summary": { "errors": errors, "warnings": warnings },
    }));
    (errors, warnings)
}

/// collection lint：服务端 Collection（id）或本地文件（--file）
pub async fn collection_lint(
    api: &CliApi,
    id: Option<&str>,
    file: Option<&str>,
    env_file: Option<&str>,
    globals: Option<&str>,
) -> anyhow::Result<u8> {
    let (target, nodes, collection_vars): (String, Vec<ImportedNode>, Vec<String>) = match (id, file) {
        (Some(id), None) => {
            let collection = api.collection(id).await?;
            let name = collection
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let tree: Vec<CollectionItemNode> =
                serde_json::from_value(api.collection_tree(id).await?)?;
            let vars = collection
                .get("variables")
                .and_then(|v| v.as_array())
                .map(|vars| {
                    vars.iter()
                        .filter(|v| {
                            v.get("enabled").and_then(|e| e.as_bool()).unwrap_or(false)
                        })
                        .filter_map(|v| v.get("key").and_then(|k| k.as_str()).map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            (name, tree.iter().map(server_node).collect(), vars)
        }
        (None, Some(file)) => {
            let text = std::fs::read_to_string(file)
                .map_err(|e| anyhow::anyhow!("cannot read collection file {file}: {e}"))?;
            let imported = crate::convert::parse_collection(&text)?;
            let vars = imported
                .variables
                .iter()
                .filter(|v| v.enabled)
                .map(|v| v.key.clone())
                .collect();
            (imported.name, imported.items, vars)
        }
        _ => anyhow::bail!("collection lint: pass either <id> or --file"),
    };

    let mut scope = LintScope {
        variables: collection_vars.into_iter().collect(),
    };
    if let Some(path) = env_file {
        load_scope_file(&mut scope, path)?;
    }
    if let Some(path) = globals {
        load_scope_file(&mut scope, path)?;
    }

    let issues = lint_collection(&nodes, &scope);
    let (errors, _) = print_issues(&target, &issues);
    Ok(if errors > 0 { 1 } else { 0 })
}

/// spec lint：服务端 spec（id，含类型）或本地文件（--file，类型自动识别或 --type 指定）
pub async fn spec_lint(
    api: &CliApi,
    id: Option<&str>,
    file: Option<&str>,
    spec_type: Option<&str>,
) -> anyhow::Result<u8> {
    let (target, content, detected): (String, String, Option<SpecType>) = match (id, file) {
        (Some(id), None) => {
            let spec = api.spec(id).await?;
            let name = spec
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            let content = spec
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or_else(|| anyhow::anyhow!("spec {id} has no content"))?
                .to_string();
            let detected = spec
                .get("type")
                .and_then(|v| v.as_str())
                .map(SpecType::parse)
                .transpose()?;
            (name, content, detected)
        }
        (None, Some(file)) => {
            let content = std::fs::read_to_string(file)
                .map_err(|e| anyhow::anyhow!("cannot read spec file {file}: {e}"))?;
            (file.to_string(), content, None)
        }
        _ => anyhow::bail!("spec lint: pass either <id> or --file"),
    };
    // 命令行 --type 优先于服务端记录的类型
    let spec_type = match spec_type {
        Some(value) => Some(SpecType::parse(value)?),
        None => detected,
    };
    let issues = lint_spec(&content, spec_type)?;
    let (errors, _) = print_issues(&target, &issues);
    Ok(if errors > 0 { 1 } else { 0 })
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    fn rules(issues: &[LintIssue]) -> Vec<&str> {
        issues.iter().map(|i| i.rule.as_str()).collect()
    }

    #[test]
    fn clean_openapi_spec_passes() {
        let spec = r##"
openapi: 3.0.3
info:
  title: Demo
  version: 1.0.0
  description: d
  contact:
    name: support
servers:
  - url: https://api.example.com
tags:
  - name: pets
    description: 宠物
paths:
  /pets/{id}:
    get:
      operationId: getPet
      summary: 获取
      tags: [pets]
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: ok
"##;
        let issues = lint_spec(spec, None).unwrap();
        assert!(issues.is_empty(), "{issues:?}");
    }

    #[test]
    fn reports_schema_and_best_practice_issues() {
        let spec = r#"
openapi: 3.0.3
info:
  title: ""
paths:
  pets:
    get:
      responses: {}
"#;
        let issues = lint_spec(spec, Some(SpecType::Openapi30)).unwrap();
        let rules = rules(&issues);
        assert!(rules.contains(&"oas3-schema"), "{rules:?}"); // title 缺失 / path 无 / 等
        assert!(rules.contains(&"operation-responses"), "{rules:?}");
        // errors 排在 warnings 前
        let first_warning = issues.iter().position(|i| i.severity == "warning");
        if let Some(pos) = first_warning {
            assert!(issues[..pos].iter().all(|i| i.severity == "error"));
        }
    }

    #[test]
    fn detects_type_mismatch_and_asyncapi() {
        let issues = lint_spec("openapi: \"2.0\"\ninfo: {title: t, version: v}\npaths: {}\n", Some(SpecType::Openapi30)).unwrap();
        assert!(rules(&issues).contains(&"spec-type-mismatch"));

        let async_spec = "asyncapi: 2.6.0\ninfo: {title: t, version: v}\nchannels: {}\n";
        let issues = lint_spec(async_spec, None).unwrap();
        assert!(rules(&issues).contains(&"asyncapi-schema")); // channels 为空
    }

    #[test]
    fn collection_lint_rules() {
        let json = r#"{
            "format": "rabbitpost.collection",
            "name": "Demo",
            "variables": [{"key": "host", "value": "https://a", "enabled": true}],
            "items": [
                {"type": "request", "name": "r1", "request": {
                    "method": "GET", "url": "http://{{host}}/x",
                    "scripts": {"test": "rp.test('ok', () => {});"}
                }},
                {"type": "request", "name": "r2", "request": {"method": "GET", "url": "{{missing}}/y"}},
                {"type": "request", "name": "r2"},
                {"type": "folder", "name": "", "items": []}
            ]
        }"#;
        let col = crate::convert::parse_collection(json).unwrap();
        let scope = LintScope {
            variables: HashSet::from(["host".to_string()]),
        };
        let issues = lint_collection(&col.items, &scope);
        let rules = rules(&issues);
        assert!(rules.contains(&"insecure-url"), "{rules:?}");
        assert!(rules.contains(&"unresolved-variable"), "{rules:?}");
        assert!(rules.contains(&"no-tests"), "{rules:?}");
        assert!(rules.contains(&"duplicate-name"), "{rules:?}");
        assert!(rules.contains(&"empty-name"), "{rules:?}");
        assert!(rules.contains(&"empty-url"), "{rules:?}"); // r2 无配置
        let (errors, _) = summarize_issues(&issues);
        assert!(errors > 0);
    }

    #[test]
    fn extract_variables_checks_balance() {
        let (names, balanced) = extract_variables("{{host}}/x/{{id}}");
        assert!(balanced);
        assert_eq!(names, vec!["host".to_string(), "id".to_string()]);
        let (_, balanced) = extract_variables("{{host}/x");
        assert!(!balanced);
    }
}
