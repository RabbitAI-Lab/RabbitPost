import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { Socket } from 'socket.io';

/**
 * Socket.IO 服务（socket.io v4，默认 /socket.io 路径、默认 namespace）。
 * 由 Nest 默认 IoAdapter（@nestjs/platform-socket.io）挂到同一 HTTP server。
 *
 * 行为：
 * - 连接建立后 emit `welcome` 事件，payload { msg: 'hi' }
 * - 对客户端发来的任意事件 `X`，回发 `echo:X`，args 原样返回
 * - 若客户端带 ack 回调，额外 ack 'ack-ok'
 */
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class SocketIoGateway implements OnGatewayConnection {
  handleConnection(client: Socket) {
    client.emit('welcome', { msg: 'hi' });

    client.onAny((event: string, ...args: any[]) => {
      let ack: ((...ackArgs: any[]) => void) | undefined;
      if (args.length > 0 && typeof args[args.length - 1] === 'function') {
        ack = args.pop();
      }
      client.emit(`echo:${event}`, ...args);
      if (ack) {
        ack('ack-ok');
      }
    });
  }
}
