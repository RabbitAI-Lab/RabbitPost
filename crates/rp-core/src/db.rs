//! 数据库连接执行层：MySQL / PostgreSQL / SQLite 走 sqlx（rustls，与 reqwest 一致），
//! Redis 走 redis-rs。连接按名称注册、首次使用时惰性建立（每次执行一个注册表，
//! 执行结束统一关闭）。护栏：连接超时默认 5s（可配）、单条语句超时 10s、
//! 查询最多返回 1000 行（超出截断并置 truncated）、readOnly 连接拒绝非 SELECT
//! （允许 WITH 开头的 CTE）。postgres 的 `?` 占位符在驱动层转换为 `$n`。
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, bail, Context as _};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::{Column as _, Row as _, TypeInfo as _, ValueRef as _};

use crate::model::{ConsoleLogEntry, DbOperation, ResolvedDbConnection};
use crate::vars::substitute;

/// 连接超时缺省值（DbConnectionConfig.connectTimeoutMs 可覆盖）
const DEFAULT_CONNECT_TIMEOUT_MS: u64 = 5_000;
/// 单条语句/命令超时（与服务端 db-client 一致）
const STATEMENT_TIMEOUT: Duration = Duration::from_secs(10);
/// 查询返回行数上限：超出截断并置 truncated（与服务端一致）
pub const MAX_ROWS: usize = 1_000;

/// SQL 查询结果（与服务端 DbQueryResult 形态一致）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryResult {
    pub rows: Vec<Value>,
    pub row_count: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
}

/// SQL 写入结果（与服务端 DbExecResult 形态一致）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbExecResult {
    pub affected_rows: u64,
}

enum SqlPool {
    Postgres(sqlx::PgPool),
    MySql(sqlx::MySqlPool),
    Sqlite(sqlx::SqlitePool),
}

impl Clone for SqlPool {
    fn clone(&self) -> Self {
        match self {
            SqlPool::Postgres(p) => SqlPool::Postgres(p.clone()),
            SqlPool::MySql(p) => SqlPool::MySql(p.clone()),
            SqlPool::Sqlite(p) => SqlPool::Sqlite(p.clone()),
        }
    }
}

/// 一次执行内的数据库连接注册表：按名称惰性连接，close_all 统一关闭
pub struct DbRegistry {
    connections: HashMap<String, ResolvedDbConnection>,
    sql_pools: Mutex<HashMap<String, SqlPool>>,
    redis_connections: Mutex<HashMap<String, redis::aio::MultiplexedConnection>>,
}

impl DbRegistry {
    pub fn new(connections: &[ResolvedDbConnection]) -> Self {
        Self {
            connections: connections
                .iter()
                .map(|c| (c.name.clone(), c.clone()))
                .collect(),
            sql_pools: Mutex::new(HashMap::new()),
            redis_connections: Mutex::new(HashMap::new()),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.connections.is_empty()
    }

    fn connection(&self, name: &str) -> anyhow::Result<&ResolvedDbConnection> {
        self.connections.get(name).ok_or_else(|| {
            let mut known: Vec<&str> = self.connections.keys().map(String::as_str).collect();
            known.sort();
            anyhow!(
                "unknown database connection \"{name}\" (configured: {})",
                if known.is_empty() {
                    "none".to_string()
                } else {
                    known.join(", ")
                }
            )
        })
    }

    /// SELECT 查询：返回 { rows, rowCount, truncated? }
    pub async fn query(
        &self,
        name: &str,
        statement: &str,
        params: &[Value],
    ) -> anyhow::Result<DbQueryResult> {
        let conn = self.connection(name)?;
        if conn.config.conn_type == "redis" {
            bail!("connection `{name}` is a redis connection; use the redis command API");
        }
        if conn.config.read_only == Some(true) && !is_read_query(statement) {
            bail!("connection `{name}` is read-only: only SELECT statements are allowed");
        }
        let pool = self.sql_pool(conn).await?;
        let rows = with_statement_timeout(fetch_rows(&pool, statement, params)).await??;
        let truncated = rows.len() > MAX_ROWS;
        let rows: Vec<Value> = rows.into_iter().take(MAX_ROWS).collect();
        let row_count = rows.len();
        Ok(DbQueryResult {
            rows,
            row_count,
            truncated: truncated.then_some(true),
        })
    }

    /// 写入（INSERT/UPDATE/DELETE/DDL）：返回 { affectedRows }
    pub async fn exec(
        &self,
        name: &str,
        statement: &str,
        params: &[Value],
    ) -> anyhow::Result<DbExecResult> {
        let conn = self.connection(name)?;
        if conn.config.conn_type == "redis" {
            bail!("connection `{name}` is a redis connection; use the redis command API");
        }
        if conn.config.read_only == Some(true) {
            bail!("connection `{name}` is read-only: only SELECT statements are allowed");
        }
        let pool = self.sql_pool(conn).await?;
        let affected_rows = with_statement_timeout(execute_sql(&pool, statement, params)).await??;
        Ok(DbExecResult { affected_rows })
    }

    /// Redis 命令：reply 转成 JSON（string/number/array/null 等）
    pub async fn redis(
        &self,
        name: &str,
        command: &str,
        args: &[String],
    ) -> anyhow::Result<Value> {
        let conn = self.connection(name)?;
        if conn.config.conn_type != "redis" {
            bail!("connection `{name}` is not a redis connection");
        }
        let mut connection = self.redis_connection(conn).await?;
        let mut cmd = redis::cmd(command);
        for arg in args {
            cmd.arg(arg);
        }
        let value = with_statement_timeout(cmd.query_async::<redis::Value>(&mut connection))
            .await?
            .with_context(|| format!("redis command {command} failed"))?;
        Ok(redis_value_to_json(value))
    }

    /// 统一关闭本次执行建立的所有连接
    pub async fn close_all(&self) {
        let pools: Vec<SqlPool> = self.sql_pools.lock().unwrap().drain().map(|(_, p)| p).collect();
        for pool in pools {
            match pool {
                SqlPool::Postgres(p) => p.close().await,
                SqlPool::MySql(p) => p.close().await,
                SqlPool::Sqlite(p) => p.close().await,
            }
        }
        // MultiplexedConnection 随 drop 关闭
        self.redis_connections.lock().unwrap().clear();
    }

    async fn sql_pool(&self, conn: &ResolvedDbConnection) -> anyhow::Result<SqlPool> {
        if let Some(pool) = self.sql_pools.lock().unwrap().get(&conn.name) {
            return Ok(pool.clone());
        }
        let pool = connect_sql(conn).await?;
        self.sql_pools
            .lock()
            .unwrap()
            .insert(conn.name.clone(), pool.clone());
        Ok(pool)
    }

    async fn redis_connection(
        &self,
        conn: &ResolvedDbConnection,
    ) -> anyhow::Result<redis::aio::MultiplexedConnection> {
        if let Some(connection) = self.redis_connections.lock().unwrap().get(&conn.name) {
            return Ok(connection.clone());
        }
        let url = redis_url(conn);
        let client = redis::Client::open(url.as_str())
            .with_context(|| format!("invalid redis connection string for `{}`", conn.name))?;
        let timeout = connect_timeout(&conn.config);
        let connection = tokio::time::timeout(timeout, client.get_multiplexed_async_connection())
            .await
            .map_err(|_| connect_timeout_error(&conn.name, timeout))?
            .with_context(|| format!("failed to connect redis `{}`", conn.name))?;
        self.redis_connections
            .lock()
            .unwrap()
            .insert(conn.name.clone(), connection.clone());
        Ok(connection)
    }
}

impl Drop for DbRegistry {
    fn drop(&mut self) {
        // 连接随 Pool/Connection 的 drop 关闭；close_all 只是提前显式回收
    }
}

fn connect_timeout(config: &crate::model::DbConnectionConfig) -> Duration {
    Duration::from_millis(config.connect_timeout_ms.unwrap_or(DEFAULT_CONNECT_TIMEOUT_MS))
}

fn connect_timeout_error(name: &str, timeout: Duration) -> anyhow::Error {
    anyhow!("connection `{name}` timed out after {}ms", timeout.as_millis())
}

async fn with_statement_timeout<F, T>(future: F) -> anyhow::Result<T>
where
    F: std::future::Future<Output = T>,
{
    tokio::time::timeout(STATEMENT_TIMEOUT, future)
        .await
        .map_err(|_| anyhow!("statement timed out after {}s", STATEMENT_TIMEOUT.as_secs()))
}

// ---------------------------------------------------------------------------
// 连接串组装（离散字段 → URL；connectionString 优先）
// ---------------------------------------------------------------------------

/// postgres / mysql 的 URL 组装：离散字段经 url 转义，密码取 ResolvedDbConnection.password
fn sql_url(conn: &ResolvedDbConnection) -> anyhow::Result<String> {
    let config = &conn.config;
    if let Some(connection_string) = config
        .connection_string
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        return Ok(connection_string.to_string());
    }
    let scheme = match config.conn_type.as_str() {
        "postgres" => "postgres",
        "mysql" => "mysql",
        other => bail!("connection `{}` has unsupported type `{other}`", conn.name),
    };
    let mut url = url::Url::parse(&format!("{scheme}://localhost"))
        .with_context(|| format!("invalid url scheme for connection `{}`", conn.name))?;
    url.set_host(Some(config.host.as_deref().unwrap_or("localhost")))
        .map_err(|_| anyhow!("connection `{}` has invalid host", conn.name))?;
    if let Some(port) = config.port {
        url.set_port(Some(port))
            .map_err(|_| anyhow!("connection `{}` has invalid port", conn.name))?;
    }
    if let Some(username) = &config.username {
        url.set_username(username)
            .map_err(|_| anyhow!("connection `{}` has invalid username", conn.name))?;
    }
    if let Some(password) = &conn.password {
        url.set_password(Some(password))
            .map_err(|_| anyhow!("connection `{}` has invalid password", conn.name))?;
    }
    if let Some(database) = &config.database {
        url.set_path(database);
    }
    if config.ssl == Some(true) {
        if scheme == "postgres" {
            url.query_pairs_mut().append_pair("sslmode", "require");
        } else {
            url.query_pairs_mut().append_pair("ssl-mode", "REQUIRED");
        }
    }
    Ok(url.to_string())
}

/// sqlite 连接串：":memory:" 内存库或文件路径
fn sqlite_url(conn: &ResolvedDbConnection) -> String {
    let config = &conn.config;
    if let Some(connection_string) = config
        .connection_string
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        return connection_string.to_string();
    }
    match config.filepath.as_deref().unwrap_or(":memory:") {
        ":memory:" => "sqlite::memory:".to_string(),
        path => format!("sqlite://{path}"),
    }
}

fn redis_url(conn: &ResolvedDbConnection) -> String {
    let config = &conn.config;
    if let Some(connection_string) = config
        .connection_string
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        return connection_string.to_string();
    }
    let scheme = if config.ssl == Some(true) {
        "rediss"
    } else {
        "redis"
    };
    let mut url = url::Url::parse(&format!("{scheme}://127.0.0.1")).expect("static url");
    let _ = url.set_host(Some(config.host.as_deref().unwrap_or("127.0.0.1")));
    let _ = url.set_port(Some(config.port.unwrap_or(6379)));
    if let Some(username) = &config.username {
        let _ = url.set_username(username);
    }
    if let Some(password) = &conn.password {
        let _ = url.set_password(Some(password));
    }
    if let Some(database) = &config.database {
        url.set_path(database);
    }
    url.to_string()
}

async fn connect_sql(conn: &ResolvedDbConnection) -> anyhow::Result<SqlPool> {
    let timeout = connect_timeout(&conn.config);
    let name = &conn.name;
    match conn.config.conn_type.as_str() {
        "postgres" => {
            let url = sql_url(conn)?;
            let pool = tokio::time::timeout(
                timeout,
                sqlx::postgres::PgPoolOptions::new()
                    .max_connections(1)
                    .acquire_timeout(timeout)
                    .connect(&url),
            )
            .await
            .map_err(|_| connect_timeout_error(name, timeout))?
            .with_context(|| format!("failed to connect postgres `{name}`"))?;
            Ok(SqlPool::Postgres(pool))
        }
        "mysql" => {
            let url = sql_url(conn)?;
            let pool = tokio::time::timeout(
                timeout,
                sqlx::mysql::MySqlPoolOptions::new()
                    .max_connections(1)
                    .acquire_timeout(timeout)
                    .connect(&url),
            )
            .await
            .map_err(|_| connect_timeout_error(name, timeout))?
            .with_context(|| format!("failed to connect mysql `{name}`"))?;
            Ok(SqlPool::MySql(pool))
        }
        "sqlite" => {
            let url = sqlite_url(conn);
            let options: sqlx::sqlite::SqliteConnectOptions = url
                .parse()
                .with_context(|| format!("invalid sqlite path for `{name}`"))?;
            // 与 better-sqlite3 一致：文件不存在时创建
            let options = options.create_if_missing(true);
            // :memory: 库按连接隔离，必须单连接才能保证库内容稳定
            let pool = tokio::time::timeout(
                timeout,
                sqlx::sqlite::SqlitePoolOptions::new()
                    .max_connections(1)
                    .acquire_timeout(timeout)
                    .connect_with(options),
            )
            .await
            .map_err(|_| connect_timeout_error(name, timeout))?
            .with_context(|| format!("failed to open sqlite `{name}`"))?;
            Ok(SqlPool::Sqlite(pool))
        }
        "redis" => bail!("connection `{name}` is a redis connection; use the redis command API"),
        // 新驱动仅服务端支持，本地 runner 明确拒绝
        other @ ("sqlserver" | "oracle" | "clickhouse" | "mongodb") => bail!(
            "connection `{name}` has type `{other}` which is not supported by the local runner"
        ),
        other => bail!("connection `{name}` has unsupported type `{other}`"),
    }
}

// ---------------------------------------------------------------------------
// SQL 执行与结果转换
// ---------------------------------------------------------------------------

/// 语句首关键字（trim 后）为 SELECT / WITH 时视为只读查询
pub fn is_read_query(statement: &str) -> bool {
    let trimmed = statement.trim_start().to_ascii_uppercase();
    trimmed.starts_with("SELECT") || trimmed.starts_with("WITH")
}

/// postgres 的 `?` 占位符转 `$n`：跳过单/双引号字符串、美元引号段、行注释与块注释
pub fn convert_placeholders_pg(sql: &str) -> String {
    let chars: Vec<char> = sql.chars().collect();
    let len = chars.len();
    let mut out = String::with_capacity(sql.len());
    let mut index = 0;
    let mut n = 0usize;

    // 取从 index 开始的美元引号标签（$tag$），返回标签字符数
    let dollar_tag = |start: usize| -> Option<usize> {
        if chars[start] != '$' {
            return None;
        }
        let mut end = start + 1;
        if end < len && (chars[end].is_ascii_alphabetic() || chars[end] == '_') {
            while end < len && (chars[end].is_ascii_alphanumeric() || chars[end] == '_') {
                end += 1;
            }
        }
        if end < len && chars[end] == '$' {
            Some(end + 1 - start)
        } else {
            None
        }
    };

    while index < len {
        let c = chars[index];
        let next = chars.get(index + 1).copied();
        match c {
            // 行注释
            '-' if next == Some('-') => {
                while index < len && chars[index] != '\n' {
                    out.push(chars[index]);
                    index += 1;
                }
            }
            // 块注释
            '/' if next == Some('*') => {
                out.push('/');
                out.push('*');
                index += 2;
                while index < len && !(chars[index] == '*' && chars.get(index + 1) == Some(&'/')) {
                    out.push(chars[index]);
                    index += 1;
                }
                if index < len {
                    out.push('*');
                    out.push('/');
                    index += 2;
                }
            }
            // 单/双引号字符串（''、"" 与反斜杠转义跳过）
            '\'' | '"' => {
                let quote = c;
                out.push(c);
                index += 1;
                while index < len {
                    let ch = chars[index];
                    if ch == '\\' && index + 1 < len {
                        out.push(ch);
                        out.push(chars[index + 1]);
                        index += 2;
                        continue;
                    }
                    if ch == quote {
                        if chars.get(index + 1) == Some(&quote) {
                            out.push(ch);
                            out.push(ch);
                            index += 2;
                            continue;
                        }
                        out.push(ch);
                        index += 1;
                        break;
                    }
                    out.push(ch);
                    index += 1;
                }
            }
            // 美元引号段（含 $$...$$ 与 $tag$...$tag$）
            '$' if dollar_tag(index).is_some() => {
                let tag_len = dollar_tag(index).expect("checked above");
                let tag: String = chars[index..index + tag_len].iter().collect();
                out.push_str(&tag);
                index += tag_len;
                let rest: String = chars[index..].iter().collect();
                match rest.find(&tag) {
                    Some(close) => {
                        out.push_str(&rest[..close + tag.len()]);
                        index += close + tag.len();
                    }
                    None => {
                        // 未闭合：剩余内容原样输出（不再有占位符转换）
                        out.push_str(&rest);
                        index = len;
                    }
                }
            }
            '?' => {
                n += 1;
                out.push('$');
                out.push_str(&n.to_string());
                index += 1;
            }
            _ => {
                out.push(c);
                index += 1;
            }
        }
    }
    out
}

/// 绑定 JSON 参数：null/bool/number/string 原样，数组/对象序列化为 JSON 字符串
fn bind_json<'q, DB>(
    query: sqlx::query::Query<'q, DB, DB::Arguments<'q>>,
    value: &Value,
) -> sqlx::query::Query<'q, DB, DB::Arguments<'q>>
where
    DB: sqlx::Database,
    bool: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
    i64: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
    f64: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
    String: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
    Option<String>: sqlx::Encode<'q, DB> + sqlx::Type<DB>,
{
    match value {
        Value::Null => query.bind(Option::<String>::None),
        Value::Bool(b) => query.bind(*b),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                query.bind(i)
            } else if let Some(f) = n.as_f64() {
                query.bind(f)
            } else {
                query.bind(n.to_string())
            }
        }
        Value::String(s) => query.bind(s.clone()),
        other => query.bind(other.to_string()),
    }
}

async fn fetch_rows(
    pool: &SqlPool,
    statement: &str,
    params: &[Value],
) -> anyhow::Result<Vec<Value>> {
    match pool {
        SqlPool::Postgres(pool) => {
            let statement = convert_placeholders_pg(statement);
            let mut query = sqlx::query(&statement);
            for param in params {
                query = bind_json(query, param);
            }
            let rows = query
                .fetch_all(pool)
                .await
                .context("postgres query failed")?;
            rows.iter().map(pg_row_to_json).collect()
        }
        SqlPool::MySql(pool) => {
            let mut query = sqlx::query(statement);
            for param in params {
                query = bind_json(query, param);
            }
            let rows = query.fetch_all(pool).await.context("mysql query failed")?;
            rows.iter().map(mysql_row_to_json).collect()
        }
        SqlPool::Sqlite(pool) => {
            let mut query = sqlx::query(statement);
            for param in params {
                query = bind_json(query, param);
            }
            let rows = query
                .fetch_all(pool)
                .await
                .context("sqlite query failed")?;
            rows.iter().map(sqlite_row_to_json).collect()
        }
    }
}

async fn execute_sql(
    pool: &SqlPool,
    statement: &str,
    params: &[Value],
) -> anyhow::Result<u64> {
    match pool {
        SqlPool::Postgres(pool) => {
            let statement = convert_placeholders_pg(statement);
            let mut query = sqlx::query(&statement);
            for param in params {
                query = bind_json(query, param);
            }
            Ok(query
                .execute(pool)
                .await
                .context("postgres statement failed")?
                .rows_affected())
        }
        SqlPool::MySql(pool) => {
            let mut query = sqlx::query(statement);
            for param in params {
                query = bind_json(query, param);
            }
            Ok(query
                .execute(pool)
                .await
                .context("mysql statement failed")?
                .rows_affected())
        }
        SqlPool::Sqlite(pool) => {
            let mut query = sqlx::query(statement);
            for param in params {
                query = bind_json(query, param);
            }
            Ok(query
                .execute(pool)
                .await
                .context("sqlite statement failed")?
                .rows_affected())
        }
    }
}

fn number_i64(value: i64) -> Value {
    Value::Number(value.into())
}

fn number_u64(value: u64) -> Value {
    Value::Number(value.into())
}

fn number_f64(value: f64) -> Value {
    serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
}

fn bytes_to_json(bytes: &[u8]) -> Value {
    match std::str::from_utf8(bytes) {
        Ok(text) => Value::String(text.to_string()),
        Err(_) => Value::String(BASE64.encode(bytes)),
    }
}

fn chrono_timestamp(value: sqlx::types::chrono::NaiveDateTime) -> Value {
    Value::String(value.format("%Y-%m-%dT%H:%M:%S%.3f").to_string())
}

fn pg_row_to_json(row: &sqlx::postgres::PgRow) -> anyhow::Result<Value> {
    use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
    let mut obj = Map::new();
    for (i, column) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(i)?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            match raw.type_info().name() {
                "BOOL" => row.try_get::<bool, _>(i).map(Value::Bool).unwrap_or(Value::Null),
                "INT2" => row.try_get::<i16, _>(i).map(|v| number_i64(v.into())).unwrap_or(Value::Null),
                "INT4" => row.try_get::<i32, _>(i).map(|v| number_i64(v.into())).unwrap_or(Value::Null),
                "INT8" => row.try_get::<i64, _>(i).map(number_i64).unwrap_or(Value::Null),
                "OID" => row.try_get::<sqlx::postgres::types::Oid, _>(i).map(|v| number_u64(v.0.into())).unwrap_or(Value::Null),
                "FLOAT4" => row.try_get::<f32, _>(i).map(|v| number_f64(v.into())).unwrap_or(Value::Null),
                "FLOAT8" => row.try_get::<f64, _>(i).map(number_f64).unwrap_or(Value::Null),
                // 与 Node pg 驱动一致：NUMERIC 以字符串返回（不丢精度）
                "NUMERIC" => row
                    .try_get::<sqlx::types::BigDecimal, _>(i)
                    .map(|v| Value::String(v.to_string()))
                    .unwrap_or(Value::Null),
                "TIMESTAMP" => row.try_get::<NaiveDateTime, _>(i).map(chrono_timestamp).unwrap_or(Value::Null),
                "TIMESTAMPTZ" => row
                    .try_get::<DateTime<Utc>, _>(i)
                    .map(|v| Value::String(v.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()))
                    .unwrap_or(Value::Null),
                "DATE" => row
                    .try_get::<NaiveDate, _>(i)
                    .map(|v| Value::String(v.to_string()))
                    .unwrap_or(Value::Null),
                "TIME" => row
                    .try_get::<NaiveTime, _>(i)
                    .map(|v| Value::String(v.to_string()))
                    .unwrap_or(Value::Null),
                "UUID" => row
                    .try_get::<sqlx::types::Uuid, _>(i)
                    .map(|v| Value::String(v.to_string()))
                    .unwrap_or(Value::Null),
                "JSON" | "JSONB" => row.try_get::<Value, _>(i).unwrap_or(Value::Null),
                "BYTEA" => row
                    .try_get::<Vec<u8>, _>(i)
                    .map(|v| bytes_to_json(&v))
                    .unwrap_or(Value::Null),
                _ => row
                    .try_get::<String, _>(i)
                    .map(Value::String)
                    .or_else(|_| row.try_get::<Vec<u8>, _>(i).map(|v| bytes_to_json(&v)))
                    .unwrap_or(Value::Null),
            }
        };
        obj.insert(column.name().to_string(), value);
    }
    Ok(Value::Object(obj))
}

fn mysql_row_to_json(row: &sqlx::mysql::MySqlRow) -> anyhow::Result<Value> {
    use sqlx::types::chrono::{NaiveDate, NaiveDateTime, NaiveTime};
    let mut obj = Map::new();
    for (i, column) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(i)?;
        let type_name = raw.type_info().name().to_uppercase();
        let value = if raw.is_null() {
            Value::Null
        } else if type_name.contains("UNSIGNED") {
            row.try_get::<u64, _>(i).map(number_u64).unwrap_or(Value::Null)
        } else {
            match type_name.as_str() {
                "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "BIGINT" => {
                    row.try_get::<i64, _>(i).map(number_i64).unwrap_or(Value::Null)
                }
                "FLOAT" => row.try_get::<f32, _>(i).map(|v| number_f64(v.into())).unwrap_or(Value::Null),
                "DOUBLE" => row.try_get::<f64, _>(i).map(number_f64).unwrap_or(Value::Null),
                // 与 Node mysql2 一致：DECIMAL 以字符串返回（不丢精度）
                "DECIMAL" => row
                    .try_get::<sqlx::types::BigDecimal, _>(i)
                    .map(|v| Value::String(v.to_string()))
                    .unwrap_or(Value::Null),
                "JSON" => row.try_get::<Value, _>(i).unwrap_or(Value::Null),
                "DATETIME" | "TIMESTAMP" => row
                    .try_get::<NaiveDateTime, _>(i)
                    .map(chrono_timestamp)
                    .unwrap_or(Value::Null),
                "DATE" => row
                    .try_get::<NaiveDate, _>(i)
                    .map(|v| Value::String(v.to_string()))
                    .unwrap_or(Value::Null),
                "TIME" => row
                    .try_get::<NaiveTime, _>(i)
                    .map(|v| Value::String(v.to_string()))
                    .unwrap_or(Value::Null),
                "BLOB" | "TINYBLOB" | "MEDIUMBLOB" | "LONGBLOB" | "BINARY" | "VARBINARY" | "BIT" => row
                    .try_get::<Vec<u8>, _>(i)
                    .map(|v| bytes_to_json(&v))
                    .unwrap_or(Value::Null),
                _ => row
                    .try_get::<String, _>(i)
                    .map(Value::String)
                    .or_else(|_| row.try_get::<Vec<u8>, _>(i).map(|v| bytes_to_json(&v)))
                    .unwrap_or(Value::Null),
            }
        };
        obj.insert(column.name().to_string(), value);
    }
    Ok(Value::Object(obj))
}

fn sqlite_row_to_json(row: &sqlx::sqlite::SqliteRow) -> anyhow::Result<Value> {
    let mut obj = Map::new();
    for (i, column) in row.columns().iter().enumerate() {
        let raw = row.try_get_raw(i)?;
        let value = if raw.is_null() {
            Value::Null
        } else {
            match raw.type_info().name() {
                "INTEGER" | "INT4" => row.try_get::<i64, _>(i).map(number_i64).unwrap_or(Value::Null),
                "REAL" => row.try_get::<f64, _>(i).map(number_f64).unwrap_or(Value::Null),
                "BOOLEAN" => row.try_get::<bool, _>(i).map(Value::Bool).unwrap_or(Value::Null),
                "BLOB" => row
                    .try_get::<Vec<u8>, _>(i)
                    .map(|v| bytes_to_json(&v))
                    .unwrap_or(Value::Null),
                _ => row
                    .try_get::<String, _>(i)
                    .map(Value::String)
                    .or_else(|_| row.try_get::<i64, _>(i).map(number_i64))
                    .or_else(|_| row.try_get::<f64, _>(i).map(number_f64))
                    .unwrap_or(Value::Null),
            }
        };
        obj.insert(column.name().to_string(), value);
    }
    Ok(Value::Object(obj))
}

// ---------------------------------------------------------------------------
// Redis 值转换
// ---------------------------------------------------------------------------

fn redis_value_to_json(value: redis::Value) -> Value {
    match value {
        redis::Value::Nil => Value::Null,
        redis::Value::Int(n) => number_i64(n),
        redis::Value::BulkString(bytes) => bytes_to_json(&bytes),
        redis::Value::SimpleString(s) => Value::String(s),
        redis::Value::Okay => Value::String("OK".to_string()),
        redis::Value::Array(items) | redis::Value::Set(items) => {
            Value::Array(items.into_iter().map(redis_value_to_json).collect())
        }
        redis::Value::Push { data, .. } => {
            Value::Array(data.into_iter().map(redis_value_to_json).collect())
        }
        redis::Value::Map(pairs) => {
            let mut obj = Map::new();
            for (key, value) in pairs {
                let key = match redis_value_to_json(key) {
                    Value::String(s) => s,
                    other => other.to_string(),
                };
                obj.insert(key, redis_value_to_json(value));
            }
            Value::Object(obj)
        }
        redis::Value::Attribute { data, .. } => redis_value_to_json(*data),
        redis::Value::Double(f) => number_f64(f),
        redis::Value::Boolean(b) => Value::Bool(b),
        redis::Value::VerbatimString { text, .. } => Value::String(text),
        redis::Value::BigNumber(n) => Value::String(n.to_string()),
        other => Value::String(format!("{other:?}")),
    }
}

// ---------------------------------------------------------------------------
// 声明式数据库操作（pre/post 处理器）
// ---------------------------------------------------------------------------

/// 执行一组声明式数据库操作：结果与错误都写入 console（不中断请求），提取写回变量表。
/// 日志格式与服务端 executor.ts 一致（[db:pre] <conn> query ok, rowCount=N …）
pub async fn run_operations(
    registry: Option<&DbRegistry>,
    ops: &[DbOperation],
    phase: &str,
    variables: &mut HashMap<String, String>,
    console: &mut Vec<ConsoleLogEntry>,
) {
    for op in ops {
        match run_operation(registry, op, variables).await {
            Ok(summary) => console.push(ConsoleLogEntry {
                level: "log".to_string(),
                args: vec![format!("[db:{phase}] {} {summary}", op.connection)],
            }),
            Err(e) => console.push(ConsoleLogEntry {
                level: "error".to_string(),
                args: vec![format!("[db:{phase}] {} {e:#}", op.connection)],
            }),
        }
    }
}

async fn run_operation(
    registry: Option<&DbRegistry>,
    op: &DbOperation,
    variables: &mut HashMap<String, String>,
) -> anyhow::Result<String> {
    let registry = registry.ok_or_else(|| anyhow!("no database connections configured"))?;
    let statement = substitute(&op.statement, variables);
    let params: Vec<Value> = op
        .params
        .as_deref()
        .unwrap_or(&[])
        .iter()
        .map(|p| Value::String(substitute(p, variables)))
        .collect();
    match op.kind.as_str() {
        "sql" => {
            if is_read_query(&statement) {
                let result = registry.query(&op.connection, &statement, &params).await?;
                apply_sql_extractions(op.extract.as_deref().unwrap_or(&[]), &result.rows, variables);
                Ok(format!(
                    "query ok, rowCount={}{}",
                    result.row_count,
                    if result.truncated == Some(true) { " (truncated)" } else { "" }
                ))
            } else {
                let result = registry.exec(&op.connection, &statement, &params).await?;
                Ok(format!("exec ok, affectedRows={}", result.affected_rows))
            }
        }
        "redis" => {
            let mut parts = statement.split_whitespace();
            let command = parts
                .next()
                .ok_or_else(|| anyhow!("empty redis statement"))?;
            let args: Vec<String> = parts.map(str::to_string).collect();
            let value = registry.redis(&op.connection, command, &args).await?;
            apply_redis_extractions(op.extract.as_deref().unwrap_or(&[]), &value, variables);
            Ok(format!("{} ok", command.to_uppercase()))
        }
        // mongo 命令仅服务端支持，本地 runner 明确拒绝
        "mongo" => Err(anyhow!(
            "db operation kind `mongo` is not supported by the local runner"
        )),
        other => Err(anyhow!("unknown db operation kind `{other}`")),
    }
}

/// 标量转字符串（对齐服务端 extractDbValue：数字/布尔走 String(v)，
/// 对象/数组对应 JS 的 "[object Object]"）
fn scalar_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => String::new(),
        Value::Array(_) | Value::Object(_) => "[object Object]".to_string(),
    }
}

fn apply_sql_extractions(
    extractions: &[crate::model::DbExtraction],
    rows: &[Value],
    variables: &mut HashMap<String, String>,
) {
    for extraction in extractions {
        if extraction.variable.is_empty() {
            continue;
        }
        // 与服务端一致：rows/row 恒写（空结果分别得 "[]" / "null"）；
        // row.<col> 行或列缺失/为 null 时写空串
        let value = if extraction.source == "rows" {
            Value::Array(rows.to_vec()).to_string()
        } else if extraction.source == "row" {
            rows.first().cloned().unwrap_or(Value::Null).to_string()
        } else if let Some(column) = extraction.source.strip_prefix("row.") {
            rows.first()
                .and_then(|row| row.get(column))
                .map(scalar_string)
                .unwrap_or_default()
        } else {
            continue; // "value" 仅对 redis 有效
        };
        variables.insert(extraction.variable.clone(), value);
    }
}

fn apply_redis_extractions(
    extractions: &[crate::model::DbExtraction],
    value: &Value,
    variables: &mut HashMap<String, String>,
) {
    for extraction in extractions {
        if extraction.variable.is_empty() {
            continue;
        }
        // redis 用 value=命令返回值：字符串原样，其余 JSON 序列化，null 写空串
        if extraction.source == "value" {
            let extracted = match value {
                Value::Null => String::new(),
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            variables.insert(extraction.variable.clone(), extracted);
        }
    }
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::DbConnectionConfig;
    use serde_json::json;

    fn conn(name: &str, conn_type: &str) -> ResolvedDbConnection {
        ResolvedDbConnection {
            name: name.to_string(),
            config: DbConnectionConfig {
                conn_type: conn_type.to_string(),
                ..Default::default()
            },
            password: None,
        }
    }

    fn sqlite_memory(name: &str) -> ResolvedDbConnection {
        let mut c = conn(name, "sqlite");
        c.config.filepath = Some(":memory:".to_string());
        c
    }

    #[test]
    fn converts_pg_placeholders_outside_quoted_segments() {
        assert_eq!(
            convert_placeholders_pg("SELECT * FROM users WHERE id = ? AND name = ?"),
            "SELECT * FROM users WHERE id = $1 AND name = $2"
        );
        // 单引号、双引号内的 ? 不转换
        assert_eq!(
            convert_placeholders_pg(r#"SELECT '?' AS a, "?" AS b WHERE c = ?"#),
            r#"SELECT '?' AS a, "?" AS b WHERE c = $1"#
        );
        // '' 转义不结束字符串
        assert_eq!(
            convert_placeholders_pg("SELECT 'it''s ?' WHERE x = ?"),
            "SELECT 'it''s ?' WHERE x = $1"
        );
        // 美元引号段（函数体）内的 ? 不转换
        assert_eq!(
            convert_placeholders_pg(
                "CREATE FUNCTION f() RETURNS void AS $$ BEGIN RAISE NOTICE '?'; END $$ LANGUAGE plpgsql; SELECT ?"
            ),
            "CREATE FUNCTION f() RETURNS void AS $$ BEGIN RAISE NOTICE '?'; END $$ LANGUAGE plpgsql; SELECT $1"
        );
        assert_eq!(
            convert_placeholders_pg("SELECT $tag$a ? b$tag$, ?"),
            "SELECT $tag$a ? b$tag$, $1"
        );
        // 注释内的 ? 不转换
        assert_eq!(
            convert_placeholders_pg("SELECT ? -- comment ?\n/* block ? */ WHERE x = ?"),
            "SELECT $1 -- comment ?\n/* block ? */ WHERE x = $2"
        );
    }

    #[test]
    fn read_query_detection() {
        assert!(is_read_query("SELECT 1"));
        assert!(is_read_query("  select 1"));
        assert!(is_read_query("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(!is_read_query("UPDATE t SET a = 1"));
        assert!(!is_read_query("INSERT INTO t VALUES (1)"));
    }

    #[tokio::test]
    async fn sqlite_query_and_exec_roundtrip() {
        let registry = DbRegistry::new(&[sqlite_memory("测试库")]);
        let exec = registry
            .exec("测试库", "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, score REAL)", &[])
            .await
            .unwrap();
        assert_eq!(exec.affected_rows, 0);
        let exec = registry
            .exec("测试库", "INSERT INTO users (name, score) VALUES (?, ?)", &[json!("小明"), json!(9.5)])
            .await
            .unwrap();
        assert_eq!(exec.affected_rows, 1);
        registry
            .exec("测试库", "INSERT INTO users (name, score) VALUES (?, ?)", &[json!("小红"), Value::Null])
            .await
            .unwrap();
        let result = registry
            .query("测试库", "SELECT id, name, score FROM users WHERE id = ?", &[json!(1)])
            .await
            .unwrap();
        assert_eq!(result.row_count, 1);
        assert_eq!(result.rows[0], json!({"id": 1, "name": "小明", "score": 9.5}));
        // null 值往返
        let result = registry
            .query("测试库", "SELECT score FROM users WHERE id = 2", &[])
            .await
            .unwrap();
        assert_eq!(result.rows[0], json!({"score": null}));
        registry.close_all().await;
    }

    #[tokio::test]
    async fn sqlite_file_database_persists() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("rp-core-test-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let mut c = conn("filedb", "sqlite");
        c.config.filepath = Some(path.to_string_lossy().to_string());
        {
            let registry = DbRegistry::new(std::slice::from_ref(&c));
            registry
                .exec("filedb", "CREATE TABLE t (v TEXT)", &[])
                .await
                .unwrap();
            registry
                .exec("filedb", "INSERT INTO t VALUES (?)", &[json!("hello")])
                .await
                .unwrap();
            registry.close_all().await;
        }
        // 重新打开（新注册表 = 新连接池），数据仍在
        let registry = DbRegistry::new(&[c]);
        let result = registry.query("filedb", "SELECT v FROM t", &[]).await.unwrap();
        assert_eq!(result.rows, vec![json!({"v": "hello"})]);
        registry.close_all().await;
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn readonly_connection_rejects_writes() {
        let mut c = sqlite_memory("ro");
        c.config.read_only = Some(true);
        let registry = DbRegistry::new(&[c]);
        let err = registry
            .exec("ro", "CREATE TABLE t (v TEXT)", &[])
            .await
            .unwrap_err();
        assert!(err.to_string().contains("read-only"), "{err}");
        let err = registry
            .query("ro", "INSERT INTO t VALUES (1)", &[])
            .await
            .unwrap_err();
        assert!(err.to_string().contains("read-only"), "{err}");
        // WITH 开头的 CTE 查询放行
        let result = registry
            .query("ro", "WITH x AS (SELECT 1 AS v) SELECT * FROM x", &[])
            .await
            .unwrap();
        assert_eq!(result.rows, vec![json!({"v": 1})]);
        registry.close_all().await;
    }

    #[tokio::test]
    async fn query_truncates_at_max_rows() {
        let registry = DbRegistry::new(&[sqlite_memory("big")]);
        registry
            .exec("big", "CREATE TABLE nums (n INTEGER)", &[])
            .await
            .unwrap();
        // 递归 CTE 生成 MAX_ROWS + 5 行，绕过逐行 INSERT
        let result = registry
            .query(
                "big",
                &format!(
                    "WITH RECURSIVE cnt(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM cnt WHERE n < {}) SELECT n FROM cnt",
                    MAX_ROWS + 5
                ),
                &[],
            )
            .await
            .unwrap();
        assert_eq!(result.row_count, MAX_ROWS);
        assert_eq!(result.truncated, Some(true));
        assert_eq!(result.rows.len(), MAX_ROWS);
        // 未截断时不带 truncated 字段
        let result = registry.query("big", "SELECT 1 AS n", &[]).await.unwrap();
        assert_eq!(result.truncated, None);
        registry.close_all().await;
    }

    #[tokio::test]
    async fn unknown_connection_error_lists_available() {
        let registry = DbRegistry::new(&[sqlite_memory("a"), sqlite_memory("b")]);
        let err = registry.query("nope", "SELECT 1", &[]).await.unwrap_err();
        let message = err.to_string();
        assert!(message.contains("unknown database connection \"nope\""), "{message}");
        assert!(message.contains("a") && message.contains("b"), "{message}");
    }

    #[tokio::test]
    async fn declarative_sql_operations_extract_into_variables() {
        let registry = DbRegistry::new(&[sqlite_memory("db")]);
        registry
            .exec("db", "CREATE TABLE users (id INTEGER, name TEXT)", &[])
            .await
            .unwrap();
        registry
            .exec("db", "INSERT INTO users VALUES (7, 'alice')", &[])
            .await
            .unwrap();

        let mut variables = HashMap::from([("uid".to_string(), "7".to_string())]);
        let mut console = Vec::new();
        let ops = vec![DbOperation {
            id: "op1".to_string(),
            connection: "db".to_string(),
            kind: "sql".to_string(),
            statement: "SELECT id, name FROM users WHERE id = {{uid}}".to_string(),
            params: None,
            extract: Some(vec![
                crate::model::DbExtraction { variable: "allRows".to_string(), source: "rows".to_string() },
                crate::model::DbExtraction { variable: "firstRow".to_string(), source: "row".to_string() },
                crate::model::DbExtraction { variable: "userName".to_string(), source: "row.name".to_string() },
                crate::model::DbExtraction { variable: "userId".to_string(), source: "row.id".to_string() },
            ]),
        }];
        run_operations(Some(&registry), &ops, "pre", &mut variables, &mut console).await;
        assert!(console.iter().all(|c| c.level == "log"), "{console:?}");
        assert_eq!(variables["allRows"], r#"[{"id":7,"name":"alice"}]"#);
        assert_eq!(variables["firstRow"], r#"{"id":7,"name":"alice"}"#);
        assert_eq!(variables["userName"], "alice");
        assert_eq!(variables["userId"], "7");

        // 写操作（非 SELECT 走 exec）
        let ops = vec![DbOperation {
            id: "op2".to_string(),
            connection: "db".to_string(),
            kind: "sql".to_string(),
            statement: "UPDATE users SET name = ? WHERE id = ?".to_string(),
            params: Some(vec!["bob".to_string(), "{{uid}}".to_string()]),
            extract: None,
        }];
        run_operations(Some(&registry), &ops, "post", &mut variables, &mut console).await;
        let result = registry.query("db", "SELECT name FROM users", &[]).await.unwrap();
        assert_eq!(result.rows, vec![json!({"name": "bob"})]);
        registry.close_all().await;
    }

    #[tokio::test]
    async fn operation_failure_logs_console_error_without_aborting() {
        let mut variables = HashMap::new();
        let mut console = Vec::new();
        let ops = vec![
            DbOperation {
                id: "bad".to_string(),
                connection: "missing".to_string(),
                kind: "sql".to_string(),
                statement: "SELECT 1".to_string(),
                params: None,
                extract: None,
            },
            DbOperation {
                id: "good".to_string(),
                connection: "db".to_string(),
                kind: "sql".to_string(),
                statement: "SELECT 1 AS v".to_string(),
                params: None,
                extract: Some(vec![crate::model::DbExtraction {
                    variable: "v".to_string(),
                    source: "row.v".to_string(),
                }]),
            },
        ];
        let registry = DbRegistry::new(&[sqlite_memory("db")]);
        run_operations(Some(&registry), &ops, "pre", &mut variables, &mut console).await;
        assert_eq!(console[0].level, "error");
        assert!(console[0].args[0].contains("missing"), "{:?}", console[0]);
        assert_eq!(console[1].level, "log");
        // 后续操作照常执行
        assert_eq!(variables["v"], "1");

        // 完全没有配置连接时
        let mut console = Vec::new();
        run_operations(None, &ops[..1], "pre", &mut variables, &mut console).await;
        assert_eq!(console[0].level, "error");
        assert!(console[0].args[0].contains("no database connections"), "{:?}", console[0]);
        registry.close_all().await;
    }

    // ---------------------------------------------------------------------------
    // env 门控的集成测试：设置 RP_TEST_MYSQL_URL / RP_TEST_POSTGRES_URL / RP_TEST_REDIS_URL 后运行
    // ---------------------------------------------------------------------------

    #[tokio::test]
    async fn mysql_integration() {
        let Ok(url) = std::env::var("RP_TEST_MYSQL_URL") else {
            eprintln!("skipped: RP_TEST_MYSQL_URL not set");
            return;
        };
        let mut c = conn("my", "mysql");
        c.config.connection_string = Some(url);
        let registry = DbRegistry::new(&[c]);
        registry.exec("my", "CREATE TEMPORARY TABLE rp_t (id INT, name VARCHAR(32), amount DECIMAL(10,2))", &[]).await.unwrap();
        registry.exec("my", "INSERT INTO rp_t VALUES (?, ?, ?)", &[json!(1), json!("a"), json!("12.50")]).await.unwrap();
        let result = registry.query("my", "SELECT * FROM rp_t WHERE id = ?", &[json!(1)]).await.unwrap();
        assert_eq!(result.rows[0]["id"], json!(1));
        assert_eq!(result.rows[0]["name"], json!("a"));
        assert_eq!(result.rows[0]["amount"], json!("12.50"));
        registry.close_all().await;
    }

    #[tokio::test]
    async fn postgres_integration() {
        let Ok(url) = std::env::var("RP_TEST_POSTGRES_URL") else {
            eprintln!("skipped: RP_TEST_POSTGRES_URL not set");
            return;
        };
        let mut c = conn("pg", "postgres");
        c.config.connection_string = Some(url);
        let registry = DbRegistry::new(&[c]);
        registry.exec("pg", "CREATE TEMPORARY TABLE rp_t (id INT, name TEXT, amount NUMERIC(10,2))", &[]).await.unwrap();
        registry.exec("pg", "INSERT INTO rp_t VALUES (?, ?, ?)", &[json!(1), json!("a"), json!("12.50")]).await.unwrap();
        // `?` 占位符转换为 $n
        let result = registry.query("pg", "SELECT * FROM rp_t WHERE id = ? AND name = ?", &[json!(1), json!("a")]).await.unwrap();
        assert_eq!(result.rows[0]["id"], json!(1));
        assert_eq!(result.rows[0]["name"], json!("a"));
        assert_eq!(result.rows[0]["amount"], json!("12.50"));
        registry.close_all().await;
    }

    #[tokio::test]
    async fn redis_integration() {
        let Ok(url) = std::env::var("RP_TEST_REDIS_URL") else {
            eprintln!("skipped: RP_TEST_REDIS_URL not set");
            return;
        };
        let mut c = conn("cache", "redis");
        c.config.connection_string = Some(url);
        let registry = DbRegistry::new(&[c]);
        let reply = registry.redis("cache", "SET", &["rp:test".to_string(), "42".to_string()]).await.unwrap();
        assert_eq!(reply, json!("OK"));
        let reply = registry.redis("cache", "GET", &["rp:test".to_string()]).await.unwrap();
        assert_eq!(reply, json!("42"));
        registry.redis("cache", "DEL", &["rp:test".to_string()]).await.unwrap();
        let reply = registry.redis("cache", "GET", &["rp:test".to_string()]).await.unwrap();
        assert_eq!(reply, Value::Null);
        registry.close_all().await;
    }
}
