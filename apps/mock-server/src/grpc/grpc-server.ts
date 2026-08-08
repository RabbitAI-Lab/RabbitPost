import * as fs from 'fs';
import * as path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ReflectionService } from '@grpc/reflection';

// 源码布局 src/grpc -> ../../proto；构建产物 dist/src/grpc -> ../../../proto
function resolveProtoPath(): string {
  const candidates = [
    path.join(__dirname, '..', '..', 'proto', 'echo.proto'),
    path.join(__dirname, '..', '..', '..', 'proto', 'echo.proto'),
    path.join(process.cwd(), 'proto', 'echo.proto'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`echo.proto not found, tried: ${candidates.join(', ')}`);
}
const PROTO_PATH = resolveProtoPath();

/**
 * gRPC Echo 服务（proto 复用 apps/runner/proto/echo.proto），
 * 带 v1alpha server reflection，无需认证。
 */
export async function startGrpcServer(port = 50051): Promise<grpc.Server> {
  const packageDefinition = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(packageDefinition) as any;
  const echoService = proto.rabbitpost.test.echo.Echo;

  const server = new grpc.Server();
  server.addService(echoService.service, {
    unary(call: grpc.ServerUnaryCall<any, any>, callback: grpc.sendUnaryData<any>) {
      callback(null, {
        text: `echo: ${call.request.text}`,
        seq: call.request.count,
      });
    },

    serverStream(call: grpc.ServerWritableStream<any, any>) {
      const text = call.request.text;
      const count = call.request.count || 3;
      for (let i = 1; i <= count; i++) {
        call.write({ text: `echo: ${text} #${i}`, seq: i });
      }
      call.end();
    },

    clientStream(
      call: grpc.ServerReadableStream<any, any>,
      callback: grpc.sendUnaryData<any>,
    ) {
      const texts: string[] = [];
      call.on('data', (req: any) => texts.push(req.text));
      call.on('end', () => {
        callback(null, { text: `echo: ${texts.join(',')}`, seq: texts.length });
      });
    },

    bidi(call: grpc.ServerDuplexStream<any, any>) {
      let seq = 0;
      call.on('data', (req: any) => {
        seq += 1;
        call.write({ text: `echo: ${req.text}`, seq });
      });
      call.on('end', () => call.end());
    },
  });

  // v1alpha reflection
  new ReflectionService(packageDefinition).addToServer(server);

  await new Promise<void>((resolve, reject) => {
    server.bindAsync(
      `0.0.0.0:${port}`,
      grpc.ServerCredentials.createInsecure(),
      (err) => (err ? reject(err) : resolve()),
    );
  });

  return server;
}

export function stopGrpcServer(server: grpc.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.tryShutdown((err) => (err ? reject(err) : resolve()));
  });
}
