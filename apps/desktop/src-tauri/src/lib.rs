//! 桌面壳启动时拉起本地执行代理（rabbitpost-runner local-agent，随安装包
//! 以 externalBin 形式分发）。agent 只监听 127.0.0.1，不连接任何服务器；
//! 前端探测到它后把"执行"类请求改道本机。应用退出时回收子进程。

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::Manager;

/// local-agent 子进程句柄（None = 未启动，前端回退服务器执行）
struct AgentProcess(Mutex<Option<Child>>);

fn find_agent_binary() -> Option<PathBuf> {
    // 显式覆盖（调试）
    if let Ok(path) = std::env::var("RABBITPOST_RUNNER_PATH") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let exe_name = format!("rabbitpost-runner{}", std::env::consts::EXE_SUFFIX);
    // 打包产物 / tauri dev：externalBin 与主程序同目录
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(&exe_name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    // 开发兜底：src-tauri/bin/ 下按 target triple 命名的副本
    let bin_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("bin");
    if let Ok(entries) = std::fs::read_dir(bin_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            if name.to_string_lossy().starts_with("rabbitpost-runner")
                && entry.path().is_file()
            {
                return Some(entry.path());
            }
        }
    }
    None
}

fn spawn_local_agent() -> Option<Child> {
    let binary = find_agent_binary()?;
    match Command::new(binary)
        .arg("local-agent")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => Some(child),
        Err(e) => {
            eprintln!("[desktop] failed to spawn local agent: {e}");
            None
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let agent = AgentProcess(Mutex::new(spawn_local_agent()));
    if agent.0.lock().unwrap().is_none() {
        eprintln!("[desktop] local agent not available; execution falls back to the server");
    }

    let app = tauri::Builder::default()
        .manage(agent)
        .build(tauri::generate_context!())
        .expect("error while building RabbitPost desktop");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(mut child) = app_handle
                .state::<AgentProcess>()
                .0
                .lock()
                .unwrap()
                .take()
            {
                let _ = child.kill();
            }
        }
    });
}
