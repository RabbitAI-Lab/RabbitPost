// cargo test 用的 socket.io v4 echo 服务器。
// 依赖 apps/runner/tests/node/node_modules 里的 socket.io；
// ESM 解析按脚本路径而非 cwd 查找 node_modules，故用 NODE_FIXTURES_DIR 显式定位。
// 就绪后向 stdout 打印一行 "PORT <n>"。
import { createServer } from "node:http";
import { createRequire } from "node:module";

const require = createRequire(`${process.env.NODE_FIXTURES_DIR}/package.json`);
const { Server } = await import(require.resolve("socket.io"));

const httpServer = createServer();
const io = new Server(httpServer);

io.on("connection", (socket) => {
  socket.emit("welcome", "hi");
  socket.on("echo", (arg, cb) => {
    socket.emit("echoed", arg);
    if (typeof cb === "function") cb(`ack:${JSON.stringify(arg)}`);
  });
});

httpServer.listen(0, "127.0.0.1", () => {
  console.log(`PORT ${httpServer.address().port}`);
});
