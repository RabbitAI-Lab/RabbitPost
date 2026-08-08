import { WebSocketServer, WebSocket } from 'ws';

export const WS_ECHO_PATH = '/ws/echo';

export const WS_ECHO_GREETING = JSON.stringify({
  type: 'welcome',
  message: 'connected to mock ws echo',
});

/**
 * 原生 WebSocket echo 服务（ws 库，noServer 模式）。
 * 必须走 noServer + 手动 upgrade 分发：直接挂 http server 的 ws.Server
 * 会销毁 path 不匹配的 upgrade 连接，影响同端口的 Socket.IO。
 *
 * 行为：
 * - 连接建立后发送 greeting 文本帧
 * - 文本帧原样 echo 回文本帧
 * - 二进制帧原样 echo 回二进制帧
 */
export function createWsEchoServer(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (socket: WebSocket) => {
    socket.send(WS_ECHO_GREETING);

    socket.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        socket.send(data, { binary: true });
      } else {
        socket.send(data.toString('utf8'));
      }
    });
  });

  return wss;
}
