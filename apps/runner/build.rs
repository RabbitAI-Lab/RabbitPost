//! 构建脚本：用 protox（纯 Rust，无需 protoc）编译测试用 echo.proto，
//! 再由 tonic-prost-build 生成测试服务器代码；文件描述符集落盘供 reflection 注册。

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let out_dir = std::env::var("OUT_DIR")?;
    let fds = protox::compile(["proto/echo.proto"], ["proto"])?;
    let fd_path = std::path::Path::new(&out_dir).join("echo_descriptor.bin");
    std::fs::write(&fd_path, prost::Message::encode_to_vec(&fds))?;
    tonic_prost_build::configure()
        .build_client(false)
        .file_descriptor_set_path(&fd_path)
        .compile_fds(fds)?;
    Ok(())
}
