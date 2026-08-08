import { INestApplication, Logger } from '@nestjs/common';
import * as express from 'express';
import * as http from 'http';
import { WebSocketServer } from 'ws';
import { Server as GrpcServer } from '@grpc/grpc-js';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const multer = require('multer');

import { createWsEchoServer, WS_ECHO_PATH } from './realtime/ws-echo';
import { createGraphqlYoga, createGraphqlWsServer, GRAPHQL_PATH } from './graphql/graphql.setup';
import { mcpHandler, MCP_PATH } from './mcp/mcp-server';
import { startMqttBroker, stopMqttBroker, MqttHandle } from './mqtt/mqtt-server';
import { startGrpcServer, stopGrpcServer } from './grpc/grpc-server';

const logger = new Logger('MockServices');

export interface AttachOptions {
  /** MQTT broker 端口；传 false 不启动（默认 1883） */
  mqttPort?: number | false;
  /** gRPC 服务端口；传 false 不启动（默认 50051） */
  grpcPort?: number | false;
}

export interface MockServices {
  wsEcho: WebSocketServer;
  graphqlWs: WebSocketServer;
  mqtt?: MqttHandle;
  grpc?: GrpcServer;
  close: () => Promise<void>;
}

/**
 * 配置 HTTP 层的中间件与非 Nest 路由（multipart / GraphQL / body parsers / MCP）。
 * main.ts 与测试共用，保证行为一致。
 * 调用时机：NestFactory.create 之后、app.listen 之前。
 */
export function configureHttp(app: INestApplication): void {
  // multipart 必须最先注册
  const upload = multer({ storage: multer.memoryStorage() });
  app.use((req: any, res: any, next: any) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      upload.any()(req, res, (err: any) => {
        if (err) return next(err);
        if (req.files && req.files.length > 0) {
          const filesObj: Record<string, any> = {};
          for (const f of req.files) {
            filesObj[f.fieldname] = filesObj[f.fieldname] || [];
            filesObj[f.fieldname].push({
              name: f.originalname, size: f.size, type: f.mimetype,
            });
          }
          req._multerFiles = filesObj;
        }
        next();
      });
    } else {
      next();
    }
  });

  // GraphQL（graphql-yoga）：必须在 express.json() 之前挂载，yoga 自行读取 body
  const yoga = createGraphqlYoga();
  app.use(GRAPHQL_PATH, (req: any, res: any) => yoga(req, res));

  // ============ Body Parser ============
  app.use(express.json({ limit: '50mb' }));
  app.use(express.text({
    limit: '50mb',
    type: ['text/plain', 'text/html', 'text/xml', 'application/xml',
           'text/css', 'text/javascript', 'application/graphql'],
  }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use(express.raw({
    limit: '50mb',
    type: ['application/octet-stream', 'image/*', 'application/pdf'],
  }));

  // MCP（stateless Streamable HTTP）：放在 express.json() 之后，直接用 req.body
  app.use(MCP_PATH, (req: any, res: any) => {
    void mcpHandler(req, res);
  });
}

/**
 * 把 WS echo / GraphQL WS / MQTT / gRPC 挂到已 listen 的 HTTP server 上。
 * WebSocket 统一走 noServer + 手动 upgrade 分发（按 path 路由），
 * 不匹配的 upgrade 交给 Socket.IO（engine.io）自己处理，互不干扰。
 * MQTT / gRPC 启动失败只告警不阻断（端口可能被本机其他服务占用）。
 */
export async function attachServices(
  httpServer: http.Server,
  options: AttachOptions = {},
): Promise<MockServices> {
  const wsEcho = createWsEchoServer();
  const graphqlWs = createGraphqlWsServer();

  httpServer.on('upgrade', (req, socket, head) => {
    let pathname = '';
    try {
      pathname = new URL(req.url || '', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname === WS_ECHO_PATH) {
      wsEcho.handleUpgrade(req, socket, head, (ws) => wsEcho.emit('connection', ws, req));
    } else if (pathname === GRAPHQL_PATH) {
      graphqlWs.handleUpgrade(req, socket, head, (ws) => graphqlWs.emit('connection', ws, req));
    }
    // 其他路径（如 /socket.io）交给 engine.io 自己的 upgrade 监听器
  });

  let mqtt: MqttHandle | undefined;
  if (options.mqttPort !== false) {
    const port = options.mqttPort ?? 1883;
    try {
      mqtt = await startMqttBroker(port);
      logger.log(`MQTT broker (aedes) listening on tcp://localhost:${port}`);
    } catch (err) {
      logger.warn(`MQTT broker failed to start on ${port}: ${(err as Error).message}`);
    }
  }

  let grpc: GrpcServer | undefined;
  if (options.grpcPort !== false) {
    const port = options.grpcPort ?? 50051;
    try {
      grpc = await startGrpcServer(port);
      logger.log(`gRPC Echo server (with v1alpha reflection) listening on localhost:${port}`);
    } catch (err) {
      logger.warn(`gRPC server failed to start on ${port}: ${(err as Error).message}`);
    }
  }

  const close = async () => {
    for (const wss of [wsEcho, graphqlWs]) {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    if (mqtt) await stopMqttBroker(mqtt);
    if (grpc) await stopGrpcServer(grpc);
  };

  return { wsEcho, graphqlWs, mqtt, grpc, close };
}
