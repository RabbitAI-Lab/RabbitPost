//! 增删改查子命令：auth / team / workspace / collection / folder / request / env。
//! 数据默认以 JSON 输出到 stdout；--table 时列表类命令输出对齐表格。
use rp_core::model::{CollectionItemNode, Environment};
use serde_json::json;

use crate::client::CliApi;
use crate::config;
use crate::output::{print_json, print_table, str_field};

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

pub async fn auth_status(api: &CliApi) -> anyhow::Result<()> {
    print_json(&api.me().await?);
    Ok(())
}

pub fn auth_logout() -> anyhow::Result<()> {
    config::clear()?;
    print_json(&json!({ "loggedOut": true }));
    Ok(())
}

// ---------------------------------------------------------------------------
// team / workspace（只读，供 AI 导航取 id）
// ---------------------------------------------------------------------------

pub async fn team_list(api: &CliApi, table: bool) -> anyhow::Result<()> {
    let data = api.teams().await?;
    if table {
        let rows = crate::output::rows_from(&data, &[], |t| {
            vec![str_field(t, "id"), str_field(t, "name"), str_field(t, "role")]
        });
        print_table(&["ID", "NAME", "ROLE"], &rows);
    } else {
        print_json(&data);
    }
    Ok(())
}

pub async fn workspace_list(api: &CliApi, team_id: &str, table: bool) -> anyhow::Result<()> {
    let data = api.workspaces(team_id).await?;
    if table {
        let rows = crate::output::rows_from(&data, &[], |w| {
            vec![str_field(w, "id"), str_field(w, "name")]
        });
        print_table(&["ID", "NAME"], &rows);
    } else {
        print_json(&data);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// collection
// ---------------------------------------------------------------------------

pub async fn collection_list(api: &CliApi, workspace_id: &str, table: bool) -> anyhow::Result<()> {
    let data = api.collections(workspace_id).await?;
    if table {
        let rows = crate::output::rows_from(&data, &[], |c| {
            vec![str_field(c, "id"), str_field(c, "name")]
        });
        print_table(&["ID", "NAME"], &rows);
    } else {
        print_json(&data);
    }
    Ok(())
}

pub async fn collection_get(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.collection(id).await?);
    Ok(())
}

pub async fn collection_tree(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.collection_tree(id).await?);
    Ok(())
}

pub async fn collection_create(
    api: &CliApi,
    workspace_id: &str,
    name: &str,
    description: Option<&str>,
) -> anyhow::Result<()> {
    let body = json!({ "name": name, "description": description });
    print_json(&api.create_collection(workspace_id, &body).await?);
    Ok(())
}

pub async fn collection_update(
    api: &CliApi,
    id: &str,
    name: Option<&str>,
    description: Option<&str>,
) -> anyhow::Result<()> {
    let mut body = serde_json::Map::new();
    if let Some(name) = name {
        body.insert("name".into(), name.into());
    }
    if let Some(description) = description {
        body.insert("description".into(), description.into());
    }
    if body.is_empty() {
        anyhow::bail!("nothing to update: pass --name and/or --description");
    }
    print_json(&api.update_collection(id, &json!(body)).await?);
    Ok(())
}

pub async fn collection_delete(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.delete_collection(id).await?);
    Ok(())
}

// ---------------------------------------------------------------------------
// folder / request（Collection 树条目）
// ---------------------------------------------------------------------------

/// 展开树为 (路径名, 节点) 先序列表；folder_prefix 形如 "A / B / "
fn flatten_tree(nodes: &[CollectionItemNode]) -> Vec<(String, &CollectionItemNode)> {
    fn walk<'a>(
        nodes: &'a [CollectionItemNode],
        prefix: &str,
        out: &mut Vec<(String, &'a CollectionItemNode)>,
    ) {
        for node in nodes {
            let path = format!("{prefix}{}", node.name);
            out.push((path.clone(), node));
            if node.item_type == "folder" {
                walk(&node.children, &format!("{path} / "), out);
            }
        }
    }
    let mut out = Vec::new();
    walk(nodes, "", &mut out);
    out
}

async fn load_tree(api: &CliApi, collection_id: &str) -> anyhow::Result<Vec<CollectionItemNode>> {
    let tree = api.collection_tree(collection_id).await?;
    Ok(serde_json::from_value(tree)?)
}

pub async fn folder_list(api: &CliApi, collection_id: &str, table: bool) -> anyhow::Result<()> {
    let nodes = load_tree(api, collection_id).await?;
    let folders: Vec<_> = flatten_tree(&nodes)
        .into_iter()
        .filter(|(_, n)| n.item_type == "folder")
        .collect();
    if table {
        let rows: Vec<Vec<String>> = folders
            .iter()
            .map(|(path, n)| vec![n.id.clone(), path.clone()])
            .collect();
        print_table(&["ID", "PATH"], &rows);
    } else {
        let data: Vec<serde_json::Value> = folders
            .into_iter()
            .map(|(path, n)| {
                json!({
                    "id": n.id,
                    "collectionId": n.collection_id,
                    "parentId": n.parent_id,
                    "name": n.name,
                    "path": path,
                    "sortOrder": n.sort_order,
                })
            })
            .collect();
        print_json(&data);
    }
    Ok(())
}

pub async fn folder_create(
    api: &CliApi,
    collection_id: &str,
    name: &str,
    parent: Option<&str>,
) -> anyhow::Result<()> {
    let body = json!({ "type": "folder", "name": name, "parentId": parent });
    print_json(&api.create_item(collection_id, &body).await?);
    Ok(())
}

pub async fn folder_update(
    api: &CliApi,
    id: &str,
    name: Option<&str>,
    parent: Option<&str>,
) -> anyhow::Result<()> {
    let mut body = serde_json::Map::new();
    if let Some(name) = name {
        body.insert("name".into(), name.into());
    }
    if let Some(parent) = parent {
        // 空串（main 把 --parent root 映射为空串）表示移回根级
        body.insert(
            "parentId".into(),
            if parent.is_empty() {
                serde_json::Value::Null
            } else {
                parent.into()
            },
        );
    }
    if body.is_empty() {
        anyhow::bail!("nothing to update: pass --name and/or --parent");
    }
    print_json(&api.update_item(id, &json!(body)).await?);
    Ok(())
}

pub async fn request_list(api: &CliApi, collection_id: &str, table: bool) -> anyhow::Result<()> {
    let nodes = load_tree(api, collection_id).await?;
    let requests: Vec<_> = flatten_tree(&nodes)
        .into_iter()
        .filter(|(_, n)| n.item_type == "request")
        .collect();
    if table {
        let rows: Vec<Vec<String>> = requests
            .iter()
            .map(|(path, n)| {
                let method = n
                    .request
                    .as_ref()
                    .map(|r| r.method.clone())
                    .unwrap_or_default();
                vec![n.id.clone(), method, path.clone()]
            })
            .collect();
        print_table(&["ID", "METHOD", "PATH"], &rows);
    } else {
        let data: Vec<serde_json::Value> = requests
            .into_iter()
            .map(|(path, n)| {
                json!({
                    "id": n.id,
                    "collectionId": n.collection_id,
                    "parentId": n.parent_id,
                    "name": n.name,
                    "path": path,
                    "method": n.request.as_ref().map(|r| r.method.clone()),
                    "url": n.request.as_ref().map(|r| r.url.clone()),
                })
            })
            .collect();
        print_json(&data);
    }
    Ok(())
}

pub async fn request_get(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.item(id).await?);
    Ok(())
}

/// --data 的三种来源：@file 读文件、- 读 stdin、其余按 JSON 字面量解析
pub fn read_data_arg(data: &str) -> anyhow::Result<serde_json::Value> {
    let text = if data == "-" {
        let mut buf = String::new();
        use std::io::Read;
        std::io::stdin().read_to_string(&mut buf)?;
        buf
    } else if let Some(path) = data.strip_prefix('@') {
        std::fs::read_to_string(path)?
    } else {
        data.to_string()
    };
    Ok(serde_json::from_str(&text)?)
}

pub async fn request_create(
    api: &CliApi,
    collection_id: &str,
    name: &str,
    parent: Option<&str>,
    method: Option<&str>,
    url: Option<&str>,
    data: Option<&str>,
) -> anyhow::Result<()> {
    let request = match data {
        Some(raw) => Some(read_data_arg(raw)?),
        None => {
            if method.is_none() && url.is_none() {
                None
            } else {
                Some(json!({
                    "method": method.unwrap_or("GET").to_uppercase(),
                    "url": url.unwrap_or_default(),
                }))
            }
        }
    };
    let mut body = json!({ "type": "request", "name": name, "parentId": parent });
    if let Some(request) = request {
        body["request"] = request;
    }
    print_json(&api.create_item(collection_id, &body).await?);
    Ok(())
}

pub async fn request_update(
    api: &CliApi,
    id: &str,
    name: Option<&str>,
    method: Option<&str>,
    url: Option<&str>,
    data: Option<&str>,
) -> anyhow::Result<()> {
    let mut body = serde_json::Map::new();
    if let Some(name) = name {
        body.insert("name".into(), name.into());
    }
    if let Some(raw) = data {
        // 全量替换请求配置（与服务端 PATCH 语义一致）
        body.insert("request".into(), read_data_arg(raw)?);
    } else if method.is_some() || url.is_some() {
        // 局部修改：先取回现有配置，改完整体回写
        let item = api.item(id).await?;
        let mut request = item
            .get("request")
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("item {id} has no request config"))?;
        if let Some(method) = method {
            request["method"] = method.to_uppercase().into();
        }
        if let Some(url) = url {
            request["url"] = url.into();
        }
        body.insert("request".into(), request);
    }
    if body.is_empty() {
        anyhow::bail!("nothing to update: pass --name / --method / --url / --data");
    }
    print_json(&api.update_item(id, &json!(body)).await?);
    Ok(())
}

pub async fn item_delete(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.delete_item(id).await?);
    Ok(())
}

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

pub async fn env_list(api: &CliApi, workspace_id: &str, table: bool) -> anyhow::Result<()> {
    let data = api.environments(workspace_id).await?;
    if table {
        let rows = crate::output::rows_from(&data, &[], |e| {
            vec![str_field(e, "id"), str_field(e, "name")]
        });
        print_table(&["ID", "NAME"], &rows);
    } else {
        print_json(&data);
    }
    Ok(())
}

pub async fn env_get(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.environment(id).await?);
    Ok(())
}

/// 解析 --set KEY=VALUE 列表为变量数组（新建条目生成 id 并默认启用）
fn parse_set_pairs(pairs: &[String]) -> anyhow::Result<Vec<(String, String)>> {
    pairs
        .iter()
        .map(|pair| {
            let (key, value) = pair
                .split_once('=')
                .ok_or_else(|| anyhow::anyhow!("invalid --set `{pair}`: expected KEY=VALUE"))?;
            if key.is_empty() {
                anyhow::bail!("invalid --set `{pair}`: key is empty");
            }
            Ok((key.to_string(), value.to_string()))
        })
        .collect()
}

pub async fn env_create(
    api: &CliApi,
    workspace_id: &str,
    name: &str,
    sets: &[String],
) -> anyhow::Result<()> {
    let variables: Vec<serde_json::Value> = parse_set_pairs(sets)?
        .into_iter()
        .map(|(key, value)| {
            json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "key": key,
                "value": value,
                "enabled": true,
            })
        })
        .collect();
    let body = json!({ "name": name, "variables": variables });
    print_json(&api.create_environment(workspace_id, &body).await?);
    Ok(())
}

pub async fn env_update(
    api: &CliApi,
    id: &str,
    name: Option<&str>,
    sets: &[String],
    unsets: &[String],
) -> anyhow::Result<()> {
    if name.is_none() && sets.is_empty() && unsets.is_empty() {
        anyhow::bail!("nothing to update: pass --name / --set / --unset");
    }
    let current: Environment = serde_json::from_value(api.environment(id).await?)?;
    let mut variables = current.variables;

    // --unset 先删，--set 后覆盖/追加（同一 key 以后者为准）
    for key in unsets {
        variables.retain(|v| v.key != *key);
    }
    for (key, value) in parse_set_pairs(sets)? {
        if let Some(existing) = variables.iter_mut().find(|v| v.key == key) {
            existing.value = value;
            existing.enabled = true;
        } else {
            variables.push(rp_core::model::EnvironmentVariable {
                id: Some(uuid::Uuid::new_v4().to_string()),
                key,
                value,
                enabled: true,
                secret: None,
            });
        }
    }

    let mut body = json!({ "variables": variables });
    if let Some(name) = name {
        body["name"] = name.into();
    }
    print_json(&api.update_environment(id, &body).await?);
    Ok(())
}

pub async fn env_delete(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.delete_environment(id).await?);
    Ok(())
}

// ---------------------------------------------------------------------------
// collection 导出 / 导入（rabbitpost.collection / Postman v2.1 文件）
// ---------------------------------------------------------------------------

/// CollectionItemNode 树 -> 交换格式节点（只保留业务字段，顺序即数组顺序）
fn to_export_nodes(items: &[CollectionItemNode]) -> Vec<serde_json::Value> {
    items
        .iter()
        .map(|item| {
            if item.item_type == "folder" {
                json!({
                    "type": "folder",
                    "name": item.name,
                    "description": item.description,
                    "items": to_export_nodes(&item.children),
                })
            } else {
                json!({
                    "type": "request",
                    "name": item.name,
                    "request": item.request,
                })
            }
        })
        .collect()
}

/// collection export：服务端 Collection -> rabbitpost.collection 交换文件
pub async fn collection_export(api: &CliApi, id: &str, file: Option<&str>) -> anyhow::Result<()> {
    let collection = api.collection(id).await?;
    let tree: Vec<CollectionItemNode> = serde_json::from_value(api.collection_tree(id).await?)?;
    let file_json = json!({
        "format": crate::convert::RP_COLLECTION_FORMAT,
        "version": 1,
        "exportedAt": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
        "name": collection.get("name").cloned().unwrap_or(serde_json::Value::Null),
        "description": collection.get("description").cloned().unwrap_or(serde_json::Value::Null),
        "variables": collection.get("variables").cloned().unwrap_or_else(|| json!([])),
        "items": to_export_nodes(&tree),
    });
    match file {
        Some(path) => {
            tokio::fs::write(path, serde_json::to_string_pretty(&file_json)?).await?;
            eprintln!("collection exported: {path}");
            print_json(&json!({ "exported": true, "path": path }));
        }
        None => print_json(&file_json),
    }
    Ok(())
}

/// 递归创建 folder/request（Postman / RabbitPost 文件通用），返回导入的请求数
fn import_nodes<'a>(
    api: &'a CliApi,
    collection_id: &'a str,
    nodes: &'a [crate::convert::ImportedNode],
    parent_id: Option<&'a str>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<u64>> + Send + 'a>> {
    Box::pin(async move {
        let mut count = 0;
        for node in nodes {
            match node {
                crate::convert::ImportedNode::Folder {
                    name,
                    description,
                    items,
                } => {
                    let folder = api
                        .create_item(
                            collection_id,
                            &json!({ "type": "folder", "name": name, "parentId": parent_id }),
                        )
                        .await?;
                    let folder_id = folder
                        .get("id")
                        .and_then(|v| v.as_str())
                        .ok_or_else(|| anyhow::anyhow!("create folder returned no id"))?
                        .to_string();
                    if let Some(description) = description {
                        api.update_item(&folder_id, &json!({ "description": description }))
                            .await?;
                    }
                    count += import_nodes(api, collection_id, items, Some(&folder_id)).await?;
                }
                crate::convert::ImportedNode::Request { name, request } => {
                    let mut body = json!({ "type": "request", "name": name, "parentId": parent_id });
                    if let Some(request) = request {
                        body["request"] = json!(request);
                    }
                    api.create_item(collection_id, &body).await?;
                    count += 1;
                }
            }
        }
        Ok(count)
    })
}

/// collection import：rabbitpost.collection / Postman v2.1 文件 -> 服务端 Collection
pub async fn collection_import(api: &CliApi, workspace_id: &str, file: &str) -> anyhow::Result<()> {
    let path = file.strip_prefix('@').unwrap_or(file);
    let text = std::fs::read_to_string(path)
        .map_err(|e| anyhow::anyhow!("cannot read collection file {path}: {e}"))?;
    let imported = crate::convert::parse_collection(&text)?;

    // 服务端 description 上限 1024 字符（zod max(1024)），超长截断而非报错
    let description = imported
        .description
        .map(|d| d.chars().take(1024).collect::<String>());
    let collection = api
        .create_collection(
            workspace_id,
            &json!({ "name": imported.name, "description": description }),
        )
        .await?;
    let collection_id = collection
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("create collection returned no id"))?
        .to_string();

    if !imported.variables.is_empty() {
        api.update_collection(&collection_id, &json!({ "variables": imported.variables }))
            .await?;
    }
    let count = import_nodes(api, &collection_id, &imported.items, None).await?;
    eprintln!("imported `{}` ({count} request(s))", imported.name);
    print_json(&json!({
        "imported": true,
        "collectionId": collection_id,
        "name": imported.name,
        "requests": count,
    }));
    Ok(())
}

// ---------------------------------------------------------------------------
// runs：执行记录查询与报告下载
// ---------------------------------------------------------------------------

pub async fn runs_list(
    api: &CliApi,
    collection_id: &str,
    limit: Option<u32>,
    table: bool,
) -> anyhow::Result<()> {
    let data = api.collection_runs(collection_id, limit).await?;
    if table {
        let rows = crate::output::rows_from(&data, &[], |j| {
            vec![
                str_field(j, "id"),
                str_field(j, "status"),
                str_field(j, "targetName"),
                str_field(j, "source"),
                str_field(j, "createdAt"),
            ]
        });
        print_table(&["ID", "STATUS", "TARGET", "SOURCE", "CREATED"], &rows);
    } else {
        print_json(&data);
    }
    Ok(())
}

pub async fn runs_get(api: &CliApi, job_id: &str) -> anyhow::Result<()> {
    print_json(&api.run_job(job_id).await?);
    Ok(())
}

/// runs report：下载服务端生成的 html/junit 报告到文件
pub async fn runs_report(
    api: &CliApi,
    job_id: &str,
    format: &str,
    file: Option<&str>,
) -> anyhow::Result<()> {
    if format != "html" && format != "junit" {
        anyhow::bail!("invalid --format `{format}`: expect html or junit");
    }
    let content = api.run_report(job_id, format).await?;
    let ext = if format == "junit" { "xml" } else { "html" };
    let path = file
        .map(str::to_string)
        .unwrap_or_else(|| format!("rabbitpost-report-{}.{ext}", &job_id[..job_id.len().min(8)]));
    tokio::fs::write(&path, &content).await?;
    eprintln!("report written: {path}");
    print_json(&json!({ "downloaded": true, "jobId": job_id, "format": format, "path": path }));
    Ok(())
}

// ---------------------------------------------------------------------------
// history：请求历史
// ---------------------------------------------------------------------------

pub async fn history_list(
    api: &CliApi,
    workspace_id: &str,
    limit: Option<u32>,
    offset: u32,
    table: bool,
) -> anyhow::Result<()> {
    let data = api.workspace_history(workspace_id, limit, offset).await?;
    if table {
        let rows = crate::output::rows_from(&data, &[], |h| {
            vec![
                str_field(h, "id"),
                h.get("request")
                    .and_then(|r| r.get("method"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string(),
                str_field(h, "name"),
                str_field(h, "createdAt"),
            ]
        });
        print_table(&["ID", "METHOD", "NAME", "CREATED"], &rows);
    } else {
        print_json(&data);
    }
    Ok(())
}

pub async fn history_clear(api: &CliApi, workspace_id: &str) -> anyhow::Result<()> {
    print_json(&api.clear_history(workspace_id).await?);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rp_core::model::CollectionItemNode;

    #[test]
    fn parse_set_pairs_splits_on_first_equals() {
        let pairs = parse_set_pairs(&[
            "host=https://a?x=1".to_string(),
            "token=a=b=c".to_string(),
        ])
        .unwrap();
        assert_eq!(pairs[0], ("host".to_string(), "https://a?x=1".to_string()));
        assert_eq!(pairs[1], ("token".to_string(), "a=b=c".to_string()));

        assert!(parse_set_pairs(&["no-equals".to_string()]).is_err());
        assert!(parse_set_pairs(&["=v".to_string()]).is_err());
    }

    #[test]
    fn read_data_arg_accepts_literal_and_file() {
        let literal = read_data_arg("{\"a\":1}").unwrap();
        assert_eq!(literal["a"], 1);

        let path = std::env::temp_dir().join(format!("rp-data-{}.json", std::process::id()));
        std::fs::write(&path, "{\"b\":2}").unwrap();
        let from_file = read_data_arg(&format!("@{}", path.display())).unwrap();
        assert_eq!(from_file["b"], 2);
        std::fs::remove_file(&path).ok();

        assert!(read_data_arg("not json").is_err());
    }

    fn node(item_type: &str, name: &str, children: Vec<CollectionItemNode>) -> CollectionItemNode {
        CollectionItemNode {
            id: name.to_string(),
            collection_id: "col".to_string(),
            parent_id: None,
            item_type: item_type.to_string(),
            name: name.to_string(),
            description: None,
            sort_order: 0,
            request: None,
            children,
        }
    }

    #[test]
    fn flatten_tree_produces_preorder_paths() {
        let tree = vec![
            node("request", "根请求", vec![]),
            node(
                "folder",
                "外层",
                vec![node(
                    "folder",
                    "内层",
                    vec![node("request", "深请求", vec![])],
                )],
            ),
        ];
        let flat = flatten_tree(&tree);
        let paths: Vec<&str> = flat.iter().map(|(p, _)| p.as_str()).collect();
        assert_eq!(
            paths,
            vec!["根请求", "外层", "外层 / 内层", "外层 / 内层 / 深请求"]
        );
    }
}
