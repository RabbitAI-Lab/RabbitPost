//! 输出约定：数据 JSON 走 stdout（默认 pretty，可直接 jq），日志/错误走 stderr。
//! 退出码：0 成功；1 有用例失败（仅 run）；2 参数/鉴权/网络等操作错误。
use std::process::ExitCode;

/// 打印数据 JSON（pretty，便于人与 AI 同时阅读）
pub fn print_json<T: serde::Serialize>(value: &T) {
    match serde_json::to_string_pretty(value) {
        Ok(text) => println!("{text}"),
        Err(e) => eprintln!("failed to serialize output: {e}"),
    }
}

/// 操作错误：JSON 原文透传到 stderr，退出码 2
pub fn fail(error: &anyhow::Error) -> ExitCode {
    let body = serde_json::json!({
        "error": { "message": format!("{error:#}") }
    });
    eprintln!("{body}");
    ExitCode::from(2)
}

/// --table 模式的极简表格（仅列表类命令使用）
pub fn print_table(headers: &[&str], rows: &[Vec<String>]) {
    let mut widths: Vec<usize> = headers.iter().map(|h| h.len()).collect();
    for row in rows {
        for (i, cell) in row.iter().enumerate() {
            if let Some(w) = widths.get_mut(i) {
                *w = (*w).max(cell.chars().count());
            }
        }
    }
    let line = |cells: &[String]| {
        cells
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{:<width$}", c, width = widths.get(i).copied().unwrap_or(0)))
            .collect::<Vec<_>>()
            .join("  ")
    };
    println!(
        "{}",
        line(&headers.iter().map(|h| h.to_string()).collect::<Vec<_>>())
    );
    for row in rows {
        println!("{}", line(row));
    }
}

/// 从 JSON 数组里取字符串字段组成表格行；缺字段给空串
pub fn rows_from<F>(value: &serde_json::Value, columns: &[&str], map: F) -> Vec<Vec<String>>
where
    F: Fn(&serde_json::Value) -> Vec<String>,
{
    value
        .as_array()
        .map(|items| items.iter().map(map).collect())
        .unwrap_or_else(|| {
            let _ = columns;
            Vec::new()
        })
}

pub fn str_field(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}
