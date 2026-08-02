//! CLI 本地配置：~/.rabbitpost/config.json 保存 server 与 API Key。
//! 解析优先级：命令行参数 / 环境变量（clap 已合并）> 配置文件。
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileConfig {
    #[serde(default)]
    pub server: Option<String>,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug)]
pub struct Credentials {
    pub server: String,
    pub api_key: String,
}

fn config_path() -> anyhow::Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot locate home directory"))?;
    Ok(home.join(".rabbitpost").join("config.json"))
}

pub fn load() -> FileConfig {
    let Ok(path) = config_path() else {
        return FileConfig::default();
    };
    let Ok(text) = fs::read_to_string(path) else {
        return FileConfig::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

pub fn clear() -> anyhow::Result<()> {
    let path = config_path()?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    Ok(())
}

/// 合并命令行/环境变量与配置文件（纯函数，便于测试）
fn resolve_from(
    flag_server: Option<&str>,
    flag_key: Option<&str>,
    file: &FileConfig,
) -> anyhow::Result<Credentials> {
    let server = flag_server
        .map(str::to_string)
        .or_else(|| file.server.clone())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no server configured: pass --server, set RABBITPOST_SERVER, \
                 or add \"server\" to ~/.rabbitpost/config.json"
            )
        })?;
    let api_key = flag_key
        .map(str::to_string)
        .or_else(|| file.api_key.clone())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no API key configured: pass --api-key, set RABBITPOST_API_KEY, \
                 or add \"apiKey\" to ~/.rabbitpost/config.json"
            )
        })?;
    Ok(Credentials { server, api_key })
}

/// 合并命令行/环境变量与配置文件，缺任一项即视为未登录
pub fn resolve(flag_server: Option<&str>, flag_key: Option<&str>) -> anyhow::Result<Credentials> {
    resolve_from(flag_server, flag_key, &load())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_beat_file() {
        let file = FileConfig {
            server: Some("http://file".to_string()),
            api_key: Some("file-key".to_string()),
        };
        let creds = resolve_from(Some("http://flag"), Some("flag-key"), &file).unwrap();
        assert_eq!(creds.server, "http://flag");
        assert_eq!(creds.api_key, "flag-key");
    }

    #[test]
    fn falls_back_to_file_then_errors() {
        let file = FileConfig {
            server: Some("http://file".to_string()),
            api_key: Some("file-key".to_string()),
        };
        let creds = resolve_from(None, None, &file).unwrap();
        assert_eq!(creds.server, "http://file");
        assert_eq!(creds.api_key, "file-key");

        let err = resolve_from(None, None, &FileConfig::default()).unwrap_err();
        assert!(format!("{err:#}").contains("no server configured"));

        let err = resolve_from(Some("http://x"), None, &FileConfig::default()).unwrap_err();
        assert!(format!("{err:#}").contains("no API key configured"));
    }

    #[test]
    fn config_roundtrip_via_disk() {
        // 用临时 HOME 隔离真实配置文件
        let dir = std::env::temp_dir().join(format!("rp-cli-test-{}", std::process::id()));
        let cfg_dir = dir.join(".rabbitpost");
        std::fs::create_dir_all(&cfg_dir).unwrap();
        let path = cfg_dir.join("config.json");

        let config = FileConfig {
            server: Some("http://localhost:4000".to_string()),
            api_key: Some("rpk_test".to_string()),
        };
        std::fs::write(&path, serde_json::to_string_pretty(&config).unwrap()).unwrap();
        let loaded: FileConfig =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(loaded.server.as_deref(), Some("http://localhost:4000"));
        assert_eq!(loaded.api_key.as_deref(), Some("rpk_test"));

        std::fs::remove_dir_all(&dir).ok();
    }
}
