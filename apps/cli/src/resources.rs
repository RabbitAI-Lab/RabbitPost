//! 团队 / Workspace 写操作、成员管理，以及 org / runner / document / spec / scenario 子命令。
//! 均为服务端契约的薄封装：参数组装成请求体，响应 JSON 原样输出到 stdout。
use serde_json::json;

use crate::client::CliApi;
use crate::crud::read_data_arg;
use crate::output::{print_json, print_table, rows_from, str_field};

// ---------------------------------------------------------------------------
// team 写操作与成员管理
// ---------------------------------------------------------------------------

pub async fn team_create(api: &CliApi, name: &str, slug: Option<&str>) -> anyhow::Result<()> {
    print_json(&api.create_team(&json!({ "name": name, "slug": slug })).await?);
    Ok(())
}

pub async fn team_update(
    api: &CliApi,
    id: &str,
    name: Option<&str>,
    avatar_url: Option<&str>,
) -> anyhow::Result<()> {
    let mut body = serde_json::Map::new();
    if let Some(name) = name {
        body.insert("name".into(), name.into());
    }
    if let Some(avatar_url) = avatar_url {
        // 传空串表示清除头像
        body.insert(
            "avatarUrl".into(),
            if avatar_url.is_empty() {
                serde_json::Value::Null
            } else {
                avatar_url.into()
            },
        );
    }
    if body.is_empty() {
        anyhow::bail!("nothing to update: pass --name and/or --avatar-url");
    }
    print_json(&api.update_team(id, &json!(body)).await?);
    Ok(())
}

pub async fn team_delete(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.delete_team(id).await?);
    Ok(())
}

pub async fn team_members(api: &CliApi, team_id: &str, table: bool) -> anyhow::Result<()> {
    let data = api.team_members(team_id).await?;
    if table {
        let rows = rows_from(&data, &[], |m| {
            vec![
                m.get("user").and_then(|u| u.get("id")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                m.get("user").and_then(|u| u.get("name")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                m.get("user").and_then(|u| u.get("email")).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                str_field(m, "role"),
            ]
        });
        print_table(&["USER_ID", "NAME", "EMAIL", "ROLE"], &rows);
    } else {
        print_json(&data);
    }
    Ok(())
}

pub async fn team_member_add(api: &CliApi, team_id: &str, email: &str, role: &str) -> anyhow::Result<()> {
    print_json(&api.add_team_member(team_id, &json!({ "email": email, "role": role })).await?);
    Ok(())
}

pub async fn team_member_update(api: &CliApi, team_id: &str, user: &str, role: &str) -> anyhow::Result<()> {
    print_json(&api.update_team_member(team_id, &json!({ "userId": user, "role": role })).await?);
    Ok(())
}

pub async fn team_member_remove(api: &CliApi, team_id: &str, user: &str) -> anyhow::Result<()> {
    print_json(&api.remove_team_member(team_id, &json!({ "userId": user })).await?);
    Ok(())
}

// ---------------------------------------------------------------------------
// workspace 写操作
// ---------------------------------------------------------------------------

pub async fn workspace_create(
    api: &CliApi,
    team: &str,
    name: &str,
    description: Option<&str>,
) -> anyhow::Result<()> {
    print_json(
        &api.create_workspace(&json!({ "teamId": team, "name": name, "description": description }))
            .await?,
    );
    Ok(())
}

pub async fn workspace_update(
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
    print_json(&api.update_workspace(id, &json!(body)).await?);
    Ok(())
}

pub async fn workspace_delete(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.delete_workspace(id).await?);
    Ok(())
}

// ---------------------------------------------------------------------------
// org
// ---------------------------------------------------------------------------

pub async fn org_list(api: &CliApi, table: bool) -> anyhow::Result<()> {
    let data = api.orgs().await?;
    if table {
        let rows = rows_from(&data, &[], |o| {
            vec![str_field(o, "id"), str_field(o, "name"), str_field(o, "slug"), str_field(o, "role")]
        });
        print_table(&["ID", "NAME", "SLUG", "ROLE"], &rows);
    } else {
        print_json(&data);
    }
    Ok(())
}

pub async fn org_create(
    api: &CliApi,
    name: &str,
    slug: Option<&str>,
    domain: Option<&str>,
    logo_url: Option<&str>,
) -> anyhow::Result<()> {
    print_json(
        &api.create_org(&json!({ "name": name, "slug": slug, "domain": domain, "logoUrl": logo_url }))
            .await?,
    );
    Ok(())
}

pub async fn org_get(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.org(id).await?);
    Ok(())
}

pub async fn org_update(
    api: &CliApi,
    id: &str,
    name: Option<&str>,
    domain: Option<&str>,
    status: Option<&str>,
) -> anyhow::Result<()> {
    let mut body = serde_json::Map::new();
    if let Some(name) = name {
        body.insert("name".into(), name.into());
    }
    if let Some(domain) = domain {
        body.insert("domain".into(), domain.into());
    }
    if let Some(status) = status {
        body.insert("status".into(), status.into());
    }
    if body.is_empty() {
        anyhow::bail!("nothing to update: pass --name / --domain / --status");
    }
    print_json(&api.update_org(id, &json!(body)).await?);
    Ok(())
}

pub async fn org_delete(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.delete_org(id).await?);
    Ok(())
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

pub async fn runner_list(api: &CliApi, team_id: &str, table: bool) -> anyhow::Result<()> {
    let data = api.team_runners(team_id).await?;
    if table {
        let rows = rows_from(&data, &[], |r| {
            vec![
                str_field(r, "id"),
                str_field(r, "name"),
                str_field(r, "status"),
                str_field(r, "lastSeenAt"),
            ]
        });
        print_table(&["ID", "NAME", "STATUS", "LAST_SEEN"], &rows);
    } else {
        print_json(&data);
    }
    Ok(())
}

/// 创建 Runner：明文 token 只返回一次，原样输出（调用方负责保存）
pub async fn runner_create(
    api: &CliApi,
    team_id: &str,
    name: &str,
    description: Option<&str>,
) -> anyhow::Result<()> {
    print_json(&api.create_runner(team_id, &json!({ "name": name, "description": description })).await?);
    Ok(())
}

pub async fn runner_get(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.runner(id).await?);
    Ok(())
}

pub async fn runner_update(
    api: &CliApi,
    id: &str,
    name: Option<&str>,
    description: Option<&str>,
    status: Option<&str>,
) -> anyhow::Result<()> {
    let mut body = serde_json::Map::new();
    if let Some(name) = name {
        body.insert("name".into(), name.into());
    }
    if let Some(description) = description {
        body.insert("description".into(), description.into());
    }
    if let Some(status) = status {
        body.insert("status".into(), status.into());
    }
    if body.is_empty() {
        anyhow::bail!("nothing to update: pass --name / --description / --status");
    }
    print_json(&api.update_runner(id, &json!(body)).await?);
    Ok(())
}

pub async fn runner_delete(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.delete_runner(id).await?);
    Ok(())
}

/// 轮换 token：旧 token 立即失效，新 token 只返回一次
pub async fn runner_rotate_token(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.rotate_runner_token(id).await?);
    Ok(())
}

// ---------------------------------------------------------------------------
// document
// ---------------------------------------------------------------------------

pub async fn doc_list(api: &CliApi, workspace_id: &str) -> anyhow::Result<()> {
    print_json(&api.documents(workspace_id).await?);
    Ok(())
}

pub async fn doc_get(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.document(id).await?);
    Ok(())
}

pub async fn doc_create(
    api: &CliApi,
    workspace_id: &str,
    name: &str,
    doc_type: &str,
    parent: Option<&str>,
    content: Option<&str>,
) -> anyhow::Result<()> {
    // --content 支持 @file / - / 字面量（文本，非 JSON）
    let content = match content {
        Some(raw) => Some(read_text_arg(raw)?),
        None => None,
    };
    print_json(
        &api.create_document(
            workspace_id,
            &json!({ "parentId": parent, "type": doc_type, "name": name, "content": content }),
        )
        .await?,
    );
    Ok(())
}

pub async fn doc_update(
    api: &CliApi,
    id: &str,
    name: Option<&str>,
    content: Option<&str>,
    parent: Option<&str>,
) -> anyhow::Result<()> {
    let mut body = serde_json::Map::new();
    if let Some(name) = name {
        body.insert("name".into(), name.into());
    }
    if let Some(raw) = content {
        body.insert("content".into(), read_text_arg(raw)?.into());
    }
    if let Some(parent) = parent {
        body.insert(
            "parentId".into(),
            if parent == "root" {
                serde_json::Value::Null
            } else {
                parent.into()
            },
        );
    }
    if body.is_empty() {
        anyhow::bail!("nothing to update: pass --name / --content / --parent");
    }
    print_json(&api.update_document(id, &json!(body)).await?);
    Ok(())
}

pub async fn doc_delete(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.delete_document(id).await?);
    Ok(())
}

/// 文本参数：@file 读文件、- 读 stdin、其余按字面量（与 read_data_arg 同约定，但不解析 JSON）
fn read_text_arg(data: &str) -> anyhow::Result<String> {
    if data == "-" {
        let mut buf = String::new();
        use std::io::Read;
        std::io::stdin().read_to_string(&mut buf)?;
        Ok(buf)
    } else if let Some(path) = data.strip_prefix('@') {
        Ok(std::fs::read_to_string(path)?)
    } else {
        Ok(data.to_string())
    }
}

// ---------------------------------------------------------------------------
// spec（lint 之外的管理命令）
// ---------------------------------------------------------------------------

pub async fn spec_list(api: &CliApi, workspace_id: &str, table: bool) -> anyhow::Result<()> {
    let data = api.workspace_specs(workspace_id).await?;
    if table {
        let rows = rows_from(&data, &[], |s| {
            vec![str_field(s, "id"), str_field(s, "name"), str_field(s, "type"), str_field(s, "format")]
        });
        print_table(&["ID", "NAME", "TYPE", "FORMAT"], &rows);
    } else {
        print_json(&data);
    }
    Ok(())
}

pub async fn spec_create(
    api: &CliApi,
    workspace_id: &str,
    name: &str,
    spec_type: &str,
    format: Option<&str>,
    content: Option<&str>,
) -> anyhow::Result<()> {
    let content = match content {
        Some(raw) => Some(read_text_arg(raw)?),
        None => None,
    };
    print_json(
        &api.create_spec(
            workspace_id,
            &json!({ "name": name, "type": spec_type, "format": format, "content": content }),
        )
        .await?,
    );
    Ok(())
}

pub async fn spec_update(
    api: &CliApi,
    id: &str,
    name: Option<&str>,
    format: Option<&str>,
    content: Option<&str>,
) -> anyhow::Result<()> {
    let mut body = serde_json::Map::new();
    if let Some(name) = name {
        body.insert("name".into(), name.into());
    }
    if let Some(format) = format {
        body.insert("format".into(), format.into());
    }
    if let Some(raw) = content {
        body.insert("content".into(), read_text_arg(raw)?.into());
    }
    if body.is_empty() {
        anyhow::bail!("nothing to update: pass --name / --format / --content");
    }
    print_json(&api.update_spec(id, &json!(body)).await?);
    Ok(())
}

pub async fn spec_delete(api: &CliApi, id: &str) -> anyhow::Result<()> {
    print_json(&api.delete_spec(id).await?);
    Ok(())
}

// ---------------------------------------------------------------------------
// scenario 步骤
// ---------------------------------------------------------------------------

pub async fn scenario_steps(api: &CliApi, scenario_id: &str, table: bool) -> anyhow::Result<()> {
    let data = api.scenario_steps(scenario_id).await?;
    if table {
        let rows = rows_from(&data, &[], |s| {
            vec![
                str_field(s, "id"),
                str_field(s, "name"),
                str_field(s, "diffStatus"),
                s.get("request")
                    .and_then(|r| r.get("method"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string(),
            ]
        });
        print_table(&["ID", "NAME", "DIFF", "METHOD"], &rows);
    } else {
        print_json(&data);
    }
    Ok(())
}

pub async fn scenario_step_add(
    api: &CliApi,
    scenario_id: &str,
    source_item: Option<&str>,
    name: Option<&str>,
    data: Option<&str>,
) -> anyhow::Result<()> {
    let mut body = serde_json::Map::new();
    if let Some(source_item) = source_item {
        body.insert("sourceItemId".into(), source_item.into());
    }
    if let Some(name) = name {
        body.insert("name".into(), name.into());
    }
    if let Some(raw) = data {
        body.insert("request".into(), read_data_arg(raw)?);
    }
    if body.is_empty() {
        anyhow::bail!("nothing to add: pass --source-item and/or --name / --data");
    }
    print_json(&api.add_scenario_step(scenario_id, &json!(body)).await?);
    Ok(())
}

pub async fn scenario_step_update(
    api: &CliApi,
    step_id: &str,
    name: Option<&str>,
    data: Option<&str>,
) -> anyhow::Result<()> {
    let mut body = serde_json::Map::new();
    if let Some(name) = name {
        body.insert("name".into(), name.into());
    }
    if let Some(raw) = data {
        body.insert("request".into(), read_data_arg(raw)?);
    }
    if body.is_empty() {
        anyhow::bail!("nothing to update: pass --name and/or --data");
    }
    print_json(&api.update_scenario_step(step_id, &json!(body)).await?);
    Ok(())
}

pub async fn scenario_step_delete(api: &CliApi, step_id: &str) -> anyhow::Result<()> {
    print_json(&api.delete_scenario_step(step_id).await?);
    Ok(())
}

pub async fn scenario_step_sync(api: &CliApi, step_id: &str) -> anyhow::Result<()> {
    print_json(&api.sync_scenario_step(step_id).await?);
    Ok(())
}

pub async fn scenario_sync_all(api: &CliApi, scenario_id: &str, step_ids: &[String]) -> anyhow::Result<()> {
    if step_ids.is_empty() {
        anyhow::bail!("sync-all requires at least one --step id");
    }
    print_json(
        &api.sync_all_scenario_steps(scenario_id, &json!({ "stepIds": step_ids }))
            .await?,
    );
    Ok(())
}

pub async fn scenario_reorder(api: &CliApi, scenario_id: &str, ordered_ids: &[String]) -> anyhow::Result<()> {
    if ordered_ids.is_empty() {
        anyhow::bail!("reorder requires at least one --step id");
    }
    print_json(
        &api.reorder_scenario_steps(scenario_id, &json!({ "orderedIds": ordered_ids }))
            .await?,
    );
    Ok(())
}
