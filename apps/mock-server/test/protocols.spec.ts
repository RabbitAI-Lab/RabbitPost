import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as http from 'http';
import request from 'supertest';
import WebSocket from 'ws';
import { io as ioClient, Socket } from 'socket.io-client';
import { createClient as createGqlWsClient } from 'graphql-ws';
import { AppModule } from '../src/app.module';
import { attachServices, configureHttp, MockServices } from '../src/bootstrap';
import { WS_ECHO_GREETING } from '../src/realtime/ws-echo';

/**
 * 协议服务测试：SSE / GraphQL(query/mutation/introspection/subscription) /
 * WS echo / Socket.IO / MCP。MQTT 与 gRPC 固定端口，不在单测中绑定，
 * 手工验证步骤见 README。
 */
describe('Protocol services (spec)', () => {
  let app: INestApplication;
  let server: http.Server;
  let services: MockServices;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false, logger: false });
    configureHttp(app);
    await app.init();

    server = app.getHttpServer();
    services = await attachServices(server, { mqttPort: false, grpcPort: false });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as any).port}`;
  });

  afterAll(async () => {
    await services.close();
    await app.close();
  });

  // ============ SSE ============
  describe('SSE', () => {
    it('GET /sse/finite 立即发 3 条后结束', async () => {
      const res = await request(server).get('/sse/finite').expect(200);
      expect(res.headers['content-type']).toContain('text/event-stream');
      const events = res.text.split('\n\n').filter(Boolean);
      expect(events).toHaveLength(3);
      expect(events[0]).toContain('id: 1');
      expect(events[0]).toContain('data: hello');
      // 多行 data
      expect(events[1]).toContain('data: multi line 1');
      expect(events[1]).toContain('data: multi line 2');
      // 自定义 event
      expect(events[2]).toContain('event: done');
      expect(events[2]).toContain('data: finished');
    });

    it('GET /sse/stream 每秒一条，交替 message/tick，带自增 id', async () => {
      // 用 supertest 自定义 parser 读流：收到 3 条事件后结束响应
      const res = await request(server)
        .get('/sse/stream')
        .parse((incoming, cb) => {
          let buf = '';
          incoming.on('data', (chunk) => {
            buf += chunk.toString();
            const count = (buf.match(/\n\n/g) || []).length;
            if (count >= 4) {
              // 1 条注释行 + 3 条事件
              (incoming as any).destroy();
              cb(null, buf);
            }
          });
          incoming.on('end', () => cb(null, buf));
          incoming.on('error', () => cb(null, buf));
        })
        .expect(200);

      expect(res.headers['content-type']).toContain('text/event-stream');
      const frames = (res.body as string).split('\n\n').filter(Boolean);
      expect(frames[0]).toContain(': connected');
      expect(frames[1]).toBe('id: 1\ndata: message 1');
      expect(frames[2]).toBe('id: 2\nevent: tick\ndata: tick 2');
      expect(frames[3]).toBe('id: 3\ndata: message 3');
    });
  });

  // ============ GraphQL ============
  describe('GraphQL', () => {
    const gql = (body: any) =>
      request(server)
        .post('/graphql')
        .set('Content-Type', 'application/json')
        .send(body);

    it('Query.hello', async () => {
      const res = await gql({ query: '{ hello(name: "RabbitPost") }' }).expect(200);
      expect(res.body.data.hello).toBe('Hello, RabbitPost!');
    });

    it('Query.hello 默认 world', async () => {
      const res = await gql({ query: '{ hello }' }).expect(200);
      expect(res.body.data.hello).toBe('Hello, world!');
    });

    it('Query.user 假数据', async () => {
      const res = await gql({
        query: 'query($id: ID!) { user(id: $id) { id name email } }',
        variables: { id: '1' },
      }).expect(200);
      expect(res.body.data.user).toEqual({
        id: '1',
        name: 'Alice',
        email: 'alice@example.com',
      });
    });

    it('Mutation.echo', async () => {
      const res = await gql({
        query: 'mutation($text: String!) { echo(text: $text) }',
        variables: { text: 'ping' },
      }).expect(200);
      expect(res.body.data.echo).toBe('ping');
    });

    it('introspection 开启', async () => {
      const res = await gql({
        query:
          '{ __schema { queryType { name } mutationType { name } subscriptionType { name } } }',
      }).expect(200);
      expect(res.body.data.__schema.queryType.name).toBe('Query');
      expect(res.body.data.__schema.mutationType.name).toBe('Mutation');
      expect(res.body.data.__schema.subscriptionType.name).toBe('Subscription');
    });

    it('Subscription.tick 通过 graphql-transport-ws 每秒自增', async () => {
      const wsUrl = baseUrl.replace('http://', 'ws://') + '/graphql';
      const client = createGqlWsClient({ url: wsUrl, webSocketImpl: WebSocket });

      const first = await new Promise<number>((resolve, reject) => {
        const dispose = client.subscribe(
          { query: 'subscription { tick }' },
          {
            next: (payload) => {
              dispose();
              resolve(payload.data?.tick as number);
            },
            error: reject,
            complete: () => reject(new Error('completed too early')),
          },
        );
      });

      expect(first).toBe(1);
      await client.dispose();
    });
  });

  // ============ WebSocket echo ============
  describe('WebSocket echo', () => {
    it('greeting + 文本 echo + 二进制 echo', async () => {
      const wsUrl = baseUrl.replace('http://', 'ws://') + '/ws/echo';
      const ws = new WebSocket(wsUrl);

      // 'open' 后 greeting 可能同步到达，先挂好消息队列再 await
      const queue: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
      const waiters: Array<(m: { data: WebSocket.RawData; isBinary: boolean }) => void> = [];
      ws.on('message', (data, isBinary) => {
        const m = { data, isBinary };
        const waiter = waiters.shift();
        if (waiter) waiter(m);
        else queue.push(m);
      });
      const nextMessage = () =>
        queue.length
          ? Promise.resolve(queue.shift())
          : new Promise<{ data: WebSocket.RawData; isBinary: boolean }>((resolve) =>
              waiters.push(resolve),
            );

      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });

      // greeting
      const greeting = await nextMessage();
      expect(greeting.isBinary).toBe(false);
      expect(greeting.data.toString()).toBe(WS_ECHO_GREETING);
      expect(JSON.parse(greeting.data.toString())).toEqual({
        type: 'welcome',
        message: 'connected to mock ws echo',
      });

      // 文本 echo
      ws.send('hello ws');
      const textEcho = await nextMessage();
      expect(textEcho.isBinary).toBe(false);
      expect(textEcho.data.toString()).toBe('hello ws');

      // 二进制 echo
      const payload = Buffer.from([0x01, 0x02, 0x03, 0xff]);
      ws.send(payload);
      const binEcho = await nextMessage();
      expect(binEcho.isBinary).toBe(true);
      expect(Buffer.from(binEcho.data as Buffer).equals(payload)).toBe(true);

      ws.close();
    });
  });

  // ============ Socket.IO ============
  describe('Socket.IO', () => {
    let socket: Socket;

    afterEach(() => {
      if (socket?.connected) socket.disconnect();
    });

    it('welcome 事件 + echo:X + ack', async () => {
      socket = ioClient(baseUrl, { transports: ['websocket'] });

      const welcome = await new Promise<any>((resolve) =>
        socket.on('welcome', resolve),
      );
      expect(welcome).toEqual({ msg: 'hi' });

      const echoPromise = new Promise<any[]>((resolve) =>
        socket.on('echo:ping', (...args) => resolve(args)),
      );
      const ack = await new Promise<any>((resolve) =>
        socket.emit('ping', 1, 'two', resolve),
      );
      expect(ack).toBe('ack-ok');
      expect(await echoPromise).toEqual([1, 'two']);
    });
  });

  // ============ MCP ============
  describe('MCP', () => {
    it('POST /mcp initialize 返回 serverInfo', async () => {
      const res = await request(server)
        .post('/mcp')
        .set('Content-Type', 'application/json')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'jest', version: '0.0.0' },
          },
        })
        .expect(200);

      // Streamable HTTP 可能以 SSE 帧返回，也可能直接 JSON
      let payload: any = res.body;
      if (!payload?.result && typeof res.text === 'string') {
        const dataLine = res.text
          .split('\n')
          .find((l) => l.startsWith('data:'));
        payload = JSON.parse(dataLine.slice(5).trim());
      }
      expect(payload.result.serverInfo.name).toBe('rabbitpost-mock-mcp');
      expect(payload.result.protocolVersion).toBeDefined();
    });

    it('GET /mcp 返回 405（stateless 仅 POST）', async () => {
      await request(server).get('/mcp').expect(405);
    });
  });
});
