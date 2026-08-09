//! 跨请求 Cookie Jar（对齐 newman --cookie-jar / --export-cookie-jar）。
//! 引擎不启用 reqwest 的自动 cookie 管理（避免与 Runner 长任务串味），
//! 由调用方持有 Jar 并显式传入执行上下文；CLI 一次 run 内共享一个 Jar。
//!
//! 文件格式兼容两种：Postman 导出的 cookie jar（外层数组或 { cookies: [...] }，
//! 元素带 name/value/domain/path/secure/expires）与极简的 [{name,value,domain,...}]。
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cookie {
    pub name: String,
    #[serde(default)]
    pub value: String,
    /// 前导点已剥除；host_only 表示只允许精确域名匹配
    pub domain: String,
    #[serde(default = "default_path")]
    pub path: String,
    #[serde(default)]
    pub secure: bool,
    /// 过期时间（Unix 秒）；None 为会话 cookie。容忍 Postman 导出的字符串形态
    #[serde(
        default,
        deserialize_with = "de_expires",
        skip_serializing_if = "Option::is_none"
    )]
    pub expires: Option<i64>,
    #[serde(default, rename = "hostOnly", skip_serializing_if = "is_false")]
    pub host_only: bool,
    /// Postman 导出里的 httpOnly 标记，序列化保留
    #[serde(default, rename = "httpOnly", skip_serializing_if = "is_false")]
    pub http_only: bool,
}

fn default_path() -> String {
    "/".to_string()
}

fn is_false(v: &bool) -> bool {
    !*v
}

/// expires 兼容数字与字符串（Postman 导出两种都出现过）
fn de_expires<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Option::<serde_json::Value>::deserialize(deserializer)?;
    Ok(match value {
        Some(serde_json::Value::Number(n)) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Some(serde_json::Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    })
}

/// 线程安全的 Cookie 存储：同一 run 内所有请求共享
#[derive(Debug, Default)]
pub struct CookieJar {
    cookies: Mutex<Vec<Cookie>>,
}

impl CookieJar {
    pub fn new() -> Self {
        Self::default()
    }

    /// 从 JSON 文本加载（Postman cookie jar 导出 / 极简数组）
    pub fn load_json(text: &str) -> anyhow::Result<Self> {
        let raw: serde_json::Value = serde_json::from_str(text)
            .map_err(|e| anyhow::anyhow!("cookie jar JSON 解析失败：{e}"))?;
        let list = match &raw {
            serde_json::Value::Array(_) => &raw,
            serde_json::Value::Object(_) => raw
                .get("cookies")
                .ok_or_else(|| anyhow::anyhow!("cookie jar 对象须包含 cookies 数组"))?,
            _ => anyhow::bail!("cookie jar 须为数组或含 cookies 字段的对象"),
        };
        let mut cookies: Vec<Cookie> = serde_json::from_value(list.clone())?;
        for cookie in &mut cookies {
            cookie.domain = cookie.domain.trim_start_matches('.').to_string();
            if cookie.path.is_empty() {
                cookie.path = default_path();
            }
            // Postman 的 expires 可能是字符串
        }
        Ok(Self {
            cookies: Mutex::new(cookies),
        })
    }

    /// 导出为 JSON（极简数组，Postman 兼容字段名）
    pub fn to_json(&self) -> String {
        let cookies = self.cookies.lock().unwrap();
        serde_json::to_string_pretty(&*cookies).unwrap_or_else(|_| "[]".to_string())
    }

    pub fn len(&self) -> usize {
        self.cookies.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 计算发给 url 的 Cookie 头值；无匹配返回 None
    pub fn cookies_for(&self, url: &str) -> Option<String> {
        let parsed = url::Url::parse(url).ok()?;
        let host = parsed.host_str()?.to_lowercase();
        let path = parsed.path();
        let is_https = parsed.scheme() == "https";
        let now = now_epoch();

        let mut cookies = self.cookies.lock().unwrap();
        // 顺手清理过期 cookie
        cookies.retain(|c| c.expires.is_none_or(|exp| exp > now));
        let pairs: Vec<String> = cookies
            .iter()
            .filter(|c| {
                if c.secure && !is_https {
                    return false;
                }
                let domain_match = if c.host_only {
                    host == c.domain
                } else {
                    host == c.domain || host.ends_with(&format!(".{}", c.domain))
                };
                domain_match && path.starts_with(&c.path)
            })
            .map(|c| format!("{}={}", c.name, c.value))
            .collect();
        if pairs.is_empty() {
            None
        } else {
            Some(pairs.join("; "))
        }
    }

    /// 解析一条 Set-Cookie 头值并入库（同名同域同路径覆盖）
    pub fn store(&self, url: &str, set_cookie: &str) {
        let Some(parsed_url) = url::Url::parse(url).ok() else {
            return;
        };
        let host = parsed_url.host_str().unwrap_or_default().to_lowercase();
        if host.is_empty() {
            return;
        }

        let mut parts = set_cookie.split(';');
        let Some(pair) = parts.next() else { return };
        let Some((name, value)) = pair.split_once('=') else { return };
        let name = name.trim().to_string();
        if name.is_empty() {
            return;
        }
        let value = value.trim().to_string();

        let mut cookie = Cookie {
            name,
            value,
            domain: host.clone(),
            path: default_path(),
            secure: false,
            expires: None,
            host_only: true,
            http_only: false,
        };
        for attr in parts {
            let attr = attr.trim();
            let (key, val) = attr
                .split_once('=')
                .map(|(k, v)| (k.trim(), v.trim()))
                .unwrap_or((attr, ""));
            match key.to_ascii_lowercase().as_str() {
                "domain" => {
                    cookie.domain = val.trim_start_matches('.').to_lowercase();
                    cookie.host_only = false;
                }
                "path" => {
                    if !val.is_empty() {
                        cookie.path = val.to_string();
                    }
                }
                "secure" => cookie.secure = true,
                "httponly" => cookie.http_only = true,
                "max-age" => {
                    if let Ok(secs) = val.parse::<i64>() {
                        cookie.expires = Some(now_epoch() + secs);
                    }
                }
                "expires" => {
                    if cookie.expires.is_none() {
                        cookie.expires = parse_http_date(val);
                    }
                }
                _ => {}
            }
        }

        let mut cookies = self.cookies.lock().unwrap();
        // Max-Age=0 / 已过期：删除而非存储
        if cookie.expires.is_some_and(|exp| exp <= now_epoch()) {
            cookies.retain(|c| {
                !(c.name == cookie.name && c.domain == cookie.domain && c.path == cookie.path)
            });
            return;
        }
        match cookies
            .iter_mut()
            .find(|c| c.name == cookie.name && c.domain == cookie.domain && c.path == cookie.path)
        {
            Some(existing) => *existing = cookie,
            None => cookies.push(cookie),
        }
    }
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 解析 HTTP-date（IMF-fixdate，如 "Wed, 21 Oct 2015 07:28:00 GMT"）。
/// 只支持标准 GMT 形态，解析失败按会话 cookie 处理。
fn parse_http_date(value: &str) -> Option<i64> {
    let value = value.trim();
    // 去掉星期前缀 "Wed, "
    let rest = value.split_once(", ").map(|(_, r)| r).unwrap_or(value);
    // 21 Oct 2015 07:28:00 GMT
    let mut parts = rest.split_whitespace();
    let day: i64 = parts.next()?.parse().ok()?;
    let month = match parts.next()? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: i64 = parts.next()?.parse().ok()?;
    let time = parts.next()?;
    let mut segs = time.split(':');
    let hour: i64 = segs.next()?.parse().ok()?;
    let min: i64 = segs.next()?.parse().ok()?;
    let sec: i64 = segs.next()?.parse().ok()?;
    Some(days_from_civil(year, month, day) * 86400 + hour * 3600 + min * 60 + sec)
}

/// Howard Hinnant 的 civil->days 算法，避免引入 chrono 依赖
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_and_match_basic() {
        let jar = CookieJar::new();
        jar.store("https://api.example.com/users", "sid=abc; Path=/");
        assert_eq!(
            jar.cookies_for("https://api.example.com/users/1").as_deref(),
            Some("sid=abc")
        );
        // hostOnly（未带 Domain 属性）：子域不匹配
        assert!(jar.cookies_for("https://sub.api.example.com/").is_none());
        // 其它域不匹配
        assert!(jar.cookies_for("https://other.com/").is_none());
    }

    #[test]
    fn domain_attr_enables_subdomain_and_secure_gates_http() {
        let jar = CookieJar::new();
        jar.store(
            "https://example.com/",
            "t=1; Domain=.example.com; Secure; Path=/api",
        );
        assert_eq!(
            jar.cookies_for("https://sub.example.com/api/x").as_deref(),
            Some("t=1")
        );
        // 路径前缀不匹配
        assert!(jar.cookies_for("https://example.com/web").is_none());
        // secure cookie 不发 http
        assert!(jar.cookies_for("http://example.com/api").is_none());
    }

    #[test]
    fn overwrite_and_delete() {
        let jar = CookieJar::new();
        jar.store("https://a.com/", "k=1; Path=/");
        jar.store("https://a.com/", "k=2; Path=/");
        assert_eq!(jar.len(), 1);
        assert_eq!(jar.cookies_for("https://a.com/").as_deref(), Some("k=2"));
        // Max-Age=0 删除
        jar.store("https://a.com/", "k=; Path=/; Max-Age=0");
        assert!(jar.is_empty());
    }

    #[test]
    fn json_roundtrip_and_postman_shape() {
        let jar = CookieJar::new();
        jar.store("https://a.com/", "k=v; Domain=a.com; HttpOnly");
        let text = jar.to_json();
        let loaded = CookieJar::load_json(&text).unwrap();
        assert_eq!(loaded.cookies_for("https://a.com/").as_deref(), Some("k=v"));

        // Postman 导出形态：{ "cookies": [...] }，domain 带前导点
        let pm = r#"{"cookies": [{"name": "s", "value": "1", "domain": ".a.com", "path": "/"}]}"#;
        let loaded = CookieJar::load_json(pm).unwrap();
        assert_eq!(
            loaded.cookies_for("https://sub.a.com/").as_deref(),
            Some("s=1")
        );
    }

    #[test]
    fn http_date_parsing() {
        let ts = parse_http_date("Wed, 21 Oct 2015 07:28:00 GMT").unwrap();
        assert_eq!(ts, 1445412480);
        assert!(parse_http_date("garbage").is_none());
    }
}
