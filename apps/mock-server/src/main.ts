import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { attachServices, configureHttp } from './bootstrap';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn', 'log'],
    bodyParser: false,
  });

  app.useGlobalPipes(new ValidationPipe({
    transform: true, whitelist: true, forbidNonWhitelisted: false,
  }));

  app.enableCors({
    origin: true,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // multipart / GraphQL(yoga) / body parsers / MCP，与测试共用的配置
  configureHttp(app);

  const port = process.env.PORT || 3090;
  await app.listen(port);

  // WS echo + GraphQL WS 挂到同一 HTTP server；MQTT(1883) / gRPC(50051) 独立端口
  const mqttPort = Number(process.env.MQTT_PORT) || 1883;
  const grpcPort = Number(process.env.GRPC_PORT) || 50051;
  const services = await attachServices(app.getHttpServer(), { mqttPort, grpcPort });

  console.log(`Mock Server running on http://localhost:${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
  console.log(`WebSocket echo: ws://localhost:${port}/ws/echo`);
  console.log(`Socket.IO:      ws://localhost:${port}/socket.io (default namespace)`);
  console.log(`SSE:            http://localhost:${port}/sse/stream | /sse/finite`);
  console.log(`GraphQL:        http://localhost:${port}/graphql (POST, introspection on)`);
  console.log(`GraphQL WS sub: ws://localhost:${port}/graphql (graphql-transport-ws)`);
  console.log(`MCP:            http://localhost:${port}/mcp (POST, stateless)`);
  if (services.mqtt) console.log(`MQTT:           tcp://localhost:${mqttPort} (aedes, no auth)`);
  if (services.grpc) console.log(`gRPC:           localhost:${grpcPort} (Echo, v1alpha reflection)`);

  // 优雅关闭：先停各协议服务，再关 Nest
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down...`);
    try {
      await services.close();
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
bootstrap();
