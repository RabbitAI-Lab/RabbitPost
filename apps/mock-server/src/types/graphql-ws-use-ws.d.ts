// graphql-ws v6 的类型走 package.json exports，tsconfig 仍是 node10 解析，
// 无法定位 'graphql-ws/use/ws' 的类型声明，这里补一个最小声明。
declare module 'graphql-ws/use/ws' {
  import type { Disposable, ServerOptions } from 'graphql-ws';
  import type { WebSocketServer } from 'ws';

  export function useServer(
    options: ServerOptions,
    websocketServer: WebSocketServer,
    keepAlive?: number,
  ): Disposable;
}
