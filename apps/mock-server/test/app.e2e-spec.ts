import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('MockServer (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // ============ Health Check ============
  describe('Health', () => {
    it('/health (GET)', () => {
      return request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect((res) => {
          expect(res.body.status).toBe('ok');
          expect(res.body.timestamp).toBeDefined();
        });
    });
  });

  // ============ Echo Controller ============
  describe('Echo', () => {
    it('/echo (GET) should echo request', () => {
      return request(app.getHttpServer())
        .get('/echo?param1=value1&param2=value2')
        .set('X-Custom-Header', 'test-value')
        .expect(200)
        .expect((res) => {
          expect(res.body.method).toBe('GET');
          expect(res.body.query.param1).toBe('value1');
          expect(res.body.query.param2).toBe('value2');
          expect(res.body.headers['x-custom-header']).toBe('test-value');
        });
    });

    it('/echo (POST) should echo JSON body', () => {
      const body = { name: 'test', value: 123 };
      return request(app.getHttpServer())
        .post('/echo')
        .send(body)
        .expect(200)
        .expect((res) => {
          expect(res.body.method).toBe('POST');
          expect(res.body.body).toEqual(body);
        });
    });

    it('/get (GET)', () => {
      return request(app.getHttpServer())
        .get('/get')
        .expect(200)
        .expect((res) => {
          expect(res.body.method).toBe('GET');
        });
    });

    it('/post (POST)', () => {
      return request(app.getHttpServer())
        .post('/post')
        .send({ test: true })
        .expect(200)
        .expect((res) => {
          expect(res.body.method).toBe('POST');
        });
    });

    it('/put (PUT)', () => {
      return request(app.getHttpServer())
        .put('/put')
        .send({ test: true })
        .expect(200)
        .expect((res) => {
          expect(res.body.method).toBe('PUT');
        });
    });

    it('/patch (PATCH)', () => {
      return request(app.getHttpServer())
        .patch('/patch')
        .send({ test: true })
        .expect(200)
        .expect((res) => {
          expect(res.body.method).toBe('PATCH');
        });
    });

    it('/delete (DELETE)', () => {
      return request(app.getHttpServer())
        .delete('/delete')
        .expect(200)
        .expect((res) => {
          expect(res.body.method).toBe('DELETE');
        });
    });

    it('/head (HEAD)', () => {
      return request(app.getHttpServer())
        .head('/head')
        .expect(200)
        .expect((res) => {
          expect(res.headers['x-echo-method']).toBe('HEAD');
          expect(res.text).toBeUndefined(); // HEAD 无 body
        });
    });

    it('/options (OPTIONS)', () => {
      return request(app.getHttpServer())
        .options('/options')
        .expect(200)
        .expect((res) => {
          expect(res.headers['access-control-allow-methods']).toContain('GET');
          expect(res.headers['x-echo-method']).toBe('OPTIONS');
        });
    });
  });

  // ============ Auth Controller ============
  describe('Auth', () => {
    it('/auth/basic/:user/:pass (GET) - success', () => {
      const credentials = Buffer.from('testuser:testpass').toString('base64');
      return request(app.getHttpServer())
        .get('/auth/basic/testuser/testpass')
        .set('Authorization', `Basic ${credentials}`)
        .expect(200)
        .expect((res) => {
          expect(res.body.authenticated).toBe(true);
          expect(res.body.user).toBe('testuser');
        });
    });

    it('/auth/basic/:user/:pass (GET) - failure', () => {
      return request(app.getHttpServer())
        .get('/auth/basic/testuser/testpass')
        .set('Authorization', 'Basic invalid')
        .expect(401)
        .expect((res) => {
          expect(res.body.authenticated).toBe(false);
        });
    });

    it('/auth/bearer (GET) - success', () => {
      return request(app.getHttpServer())
        .get('/auth/bearer')
        .set('Authorization', 'Bearer my-token')
        .expect(200)
        .expect((res) => {
          expect(res.body.authenticated).toBe(true);
          expect(res.body.token).toBe('my-token');
        });
    });

    it('/auth/bearer/:token (GET) - success', () => {
      return request(app.getHttpServer())
        .get('/auth/bearer/expected-token')
        .set('Authorization', 'Bearer expected-token')
        .expect(200)
        .expect((res) => {
          expect(res.body.authenticated).toBe(true);
        });
    });

    it('/auth/bearer/:token (GET) - wrong token', () => {
      return request(app.getHttpServer())
        .get('/auth/bearer/expected-token')
        .set('Authorization', 'Bearer wrong-token')
        .expect(401);
    });

    it('/auth/api-key (GET) - query param', () => {
      return request(app.getHttpServer())
        .get('/auth/api-key?api_key=query-key-123')
        .expect(200)
        .expect((res) => {
          expect(res.body.authenticated).toBe(true);
          expect(res.body.location).toBe('query');
        });
    });

    it('/auth/api-key (GET) - header', () => {
      return request(app.getHttpServer())
        .get('/auth/api-key')
        .set('X-API-Key', 'header-key-456')
        .expect(200)
        .expect((res) => {
          expect(res.body.authenticated).toBe(true);
          expect(res.body.location).toBe('header');
        });
    });

    it('/auth/api-key (GET) - missing', () => {
      return request(app.getHttpServer())
        .get('/auth/api-key')
        .expect(401);
    });
  });

  // ============ Body Controller ============
  describe('Body', () => {
    it('/body/json (POST) - valid', () => {
      return request(app.getHttpServer())
        .post('/body/json')
        .send({ name: 'John', email: 'john@example.com' })
        .expect(200)
        .expect((res) => {
          expect(res.body.valid).toBe(true);
        });
    });

    it('/body/json (POST) - missing fields', () => {
      return request(app.getHttpServer())
        .post('/body/json')
        .send({ name: 'John' })
        .expect(400)
        .expect((res) => {
          expect(res.body.valid).toBe(false);
          expect(res.body.missing).toContain('email');
        });
    });

    it('/body/form (POST)', () => {
      return request(app.getHttpServer())
        .post('/body/form')
        .send('username=testuser&password=testpass')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .expect(200)
        .expect((res) => {
          expect(res.body.valid).toBe(true);
          expect(res.body.form.username).toBe('testuser');
        });
    });

    it('/body/graphql (POST)', () => {
      return request(app.getHttpServer())
        .post('/body/graphql')
        .send({
          query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
          variables: { id: '123' },
        })
        .expect(200)
        .expect((res) => {
          expect(res.body.data.user).toBeDefined();
          expect(res.body.data.user.name).toBe('Mock User');
        });
    });

    it('/body/xml (POST)', async () => {
      const res = await request(app.getHttpServer())
        .post('/body/xml')
        .send('<root><item>value</item></root>')
        .set('Content-Type', 'text/xml');
      
      console.log('XML Response:', res.status, res.body);
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
    });

    it('/body/text (POST)', () => {
      return request(app.getHttpServer())
        .post('/body/text')
        .send('plain text content')
        .set('Content-Type', 'text/plain')
        .expect(200)
        .expect((res) => {
          expect(res.body.valid).toBe(true);
          expect(res.body.length).toBe(15); // 'plain text content'.length
        });
    });
  });

  // ============ Status Controller ============
  describe('Status', () => {
    it('/status/200 (GET)', () => {
      return request(app.getHttpServer())
        .get('/status/200')
        .expect(200);
    });

    it('/status/201 (GET)', () => {
      return request(app.getHttpServer())
        .get('/status/201')
        .expect(201);
    });

    it('/status/204 (GET)', () => {
      return request(app.getHttpServer())
        .get('/status/204')
        .expect(204)
        .expect((res) => {
          expect(res.text).toBe('');
        });
    });

    it('/status/404 (GET)', () => {
      return request(app.getHttpServer())
        .get('/status/404')
        .expect(404);
    });

    it('/status/500 (GET)', () => {
      return request(app.getHttpServer())
        .get('/status/500')
        .expect(500);
    });

    it('/status/invalid (GET)', () => {
      return request(app.getHttpServer())
        .get('/status/999')
        .expect(400);
    });
  });

  // ============ Advanced Controller ============
  describe('Advanced', () => {
    it('/advanced/delay/:seconds (GET)', async () => {
      const start = Date.now();
      await request(app.getHttpServer())
        .get('/advanced/delay/0.1')
        .expect(200)
        .expect((res) => {
          expect(res.body.delayed).toBe(0.1);
        });
      const duration = Date.now() - start;
      expect(duration).toBeGreaterThanOrEqual(100);
    });

    it('/advanced/redirect/:count (GET)', () => {
      return request(app.getHttpServer())
        .get('/advanced/redirect/2')
        .expect(302)
        .expect('Location', '/advanced/redirect/1');
    });

    it('/advanced/cookies (GET)', () => {
      return request(app.getHttpServer())
        .get('/advanced/cookies')
        .set('Cookie', 'session=abc123; theme=dark')
        .expect(200)
        .expect((res) => {
          expect(res.body.received.session).toBe('abc123');
          expect(res.body.received.theme).toBe('dark');
        });
    });

    it('/advanced/set-cookie (GET)', () => {
      return request(app.getHttpServer())
        .get('/advanced/set-cookie?name=test&value=123&Path=/')
        .expect(200)
        .expect((res) => {
          expect(res.headers['set-cookie']).toBeDefined();
          expect(res.body.set).toBe(true);
        });
    });

    it('/advanced/large/:size (GET)', () => {
      return request(app.getHttpServer())
        .get('/advanced/large/1024')
        .expect(200)
        .expect((res) => {
          expect(res.text.length).toBe(1024);
        });
    });

    it('/advanced/binary (GET)', () => {
      return request(app.getHttpServer())
        .get('/advanced/binary')
        .expect(200)
        .expect('Content-Type', 'image/png')
        .expect((res) => {
          expect(res.body.length).toBeGreaterThan(0);
        });
    });

    it('/advanced/headers (GET)', () => {
      return request(app.getHttpServer())
        .get('/advanced/headers')
        .set('X-Test-Header', 'test-value')
        .expect(200)
        .expect((res) => {
          expect(res.body.headers['x-test-header']).toBe('test-value');
        });
    });

    it('/advanced/response-headers (GET)', () => {
      return request(app.getHttpServer())
        .get('/advanced/response-headers?X-Custom=value1&X-Another=value2')
        .expect(200)
        .expect((res) => {
          expect(res.headers['x-custom']).toBe('value1');
          expect(res.headers['x-another']).toBe('value2');
        });
    });

    it('/advanced/cache/:seconds (GET)', () => {
      return request(app.getHttpServer())
        .get('/advanced/cache/60')
        .expect(200)
        .expect((res) => {
          expect(res.headers['cache-control']).toContain('max-age=60');
          expect(res.headers['etag']).toBeDefined();
        });
    });

    it('/advanced/conditional (GET) - with etag', () => {
      return request(app.getHttpServer())
        .get('/advanced/conditional')
        .set('If-None-Match', '"mock-etag-v1"')
        .expect(304);
    });
  });
});
