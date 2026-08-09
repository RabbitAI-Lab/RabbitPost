//! RabbitPost 核心库：Runner 与 CLI 共用的领域模型、{{var}} 替换、
//! QuickJS 脚本沙箱（rp.* API）、HTTP 执行引擎与服务端 API 客户端。
pub mod cookies;
pub mod db;
pub mod exec;
pub mod http;
pub mod model;
pub mod runner_api;
pub mod script;
pub mod vars;
