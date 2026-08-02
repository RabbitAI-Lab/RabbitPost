import { Controller, Get, Req, Res, HttpStatus, Query, Headers, All, Post } from '@nestjs/common';
import { Request, Response } from 'express';

@Controller('advanced')
export class AdvancedController {
  // ============ 延迟响应 ============
  @Get('delay/:seconds')
  async delay(@Req() req: Request, @Res() res: Response) {
    const seconds = Math.min(parseFloat(req.params.seconds) || 0, 30); // 最大30秒
    const start = Date.now();

    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

    res.json({
      delayed: seconds,
      actualDelay: (Date.now() - start) / 1000,
      timestamp: new Date().toISOString(),
    });
  }

  // ============ 重定向链 ============
  @Get('redirect/:count')
  redirect(@Req() req: Request, @Res() res: Response) {
    const count = parseInt(req.params.count, 10);

    if (isNaN(count) || count < 0) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'count must be a positive integer',
      });
    }

    if (count === 0) {
      return res.json({
        redirected: true,
        final: true,
        message: 'Redirect chain completed',
      });
    }

    // 继续重定向
    res.redirect(`/advanced/redirect/${count - 1}`);
  }

  // ============ Cookie 处理 ============
  @Get('cookies')
  cookies(@Req() req: Request, @Res() res: Response) {
    const cookieHeader = req.headers.cookie || '';
    const cookies: Record<string, string> = {};

    cookieHeader.split(';').forEach((cookie) => {
      const [name, ...rest] = cookie.trim().split('=');
      if (name) {
        cookies[name] = rest.join('=');
      }
    });

    res.json({
      received: cookies,
      raw: cookieHeader,
      count: Object.keys(cookies).length,
    });
  }

  @Get('set-cookie')
  setCookie(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    const { name, value, ...options } = query;

    if (!name || value === undefined) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'name and value are required',
        example: '/advanced/set-cookie?name=session&value=abc123&Path=/&HttpOnly',
      });
    }

    // 构建 Set-Cookie 头
    let cookieString = `${name}=${value}`;

    // 添加选项
    const optionMap: Record<string, string> = {
      path: 'Path',
      domain: 'Domain',
      maxAge: 'Max-Age',
      expires: 'Expires',
      secure: 'Secure',
      httpOnly: 'HttpOnly',
      sameSite: 'SameSite',
    };

    for (const [key, headerName] of Object.entries(optionMap)) {
      if (query[key] !== undefined) {
        if (key === 'secure' || key === 'httpOnly') {
          cookieString += `; ${headerName}`;
        } else {
          cookieString += `; ${headerName}=${query[key]}`;
        }
      }
    }

    res.set('Set-Cookie', cookieString);
    res.json({
      set: true,
      name,
      value,
      options,
      header: cookieString,
    });
  }

  // ============ 大响应体 ============
  @Get('large/:size')
  large(@Req() req: Request, @Res() res: Response) {
    const size = parseInt(req.params.size, 10) || 1024;
    const maxSize = 50 * 1024 * 1024; // 50MB max
    const actualSize = Math.min(size, maxSize);

    const body = 'x'.repeat(actualSize);
    res.set('Content-Type', 'text/plain');
    res.set('X-Actual-Size', actualSize.toString());
    res.send(body);
  }

  // ============ 二进制响应 ============
  @Get('binary')
  binary(@Req() req: Request, @Res() res: Response) {
    // PNG magic bytes + minimal IHDR
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1x1 pixel
      0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
      0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
      0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
      0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
      0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
      0x42, 0x60, 0x82,
    ]);

    res.set('Content-Type', 'image/png');
    res.set('Content-Length', png.length.toString());
    res.send(png);
  }

  // ============ 响应头测试 ============
  @Get('headers')
  headers(@Req() req: Request, @Res() res: Response) {
    // 返回所有请求头
    const requestHeaders: Record<string, string | string[]> = {};

    for (const [key, value] of Object.entries(req.headers)) {
      requestHeaders[key] = value;
    }

    res.json({
      headers: requestHeaders,
      method: req.method,
      url: req.url,
      httpVersion: req.httpVersion,
    });
  }

  // ============ 自定义响应头 ============
  @All('response-headers')
  responseHeaders(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    // 将查询参数设置为响应头
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === 'string') {
        res.set(key, value);
      }
    }

    res.json({
      message: 'Response headers set from query parameters',
      headers: query,
    });
  }

  // ============ 缓存测试 ============
  @Get('cache/:seconds')
  cache(@Req() req: Request, @Res() res: Response) {
    const seconds = parseInt(req.params.seconds, 10) || 60;

    res.set('Cache-Control', `public, max-age=${seconds}`);
    res.set('Expires', new Date(Date.now() + seconds * 1000).toUTCString());
    res.set('ETag', `"mock-etag-${seconds}"`);
    res.set('Last-Modified', new Date().toUTCString());

    res.json({
      cached: true,
      maxAge: seconds,
      etag: `mock-etag-${seconds}`,
    });
  }

  // ============ 条件请求 ============
  @Get('conditional')
  conditional(@Req() req: Request, @Res() res: Response, @Headers() headers: any) {
    const ifNoneMatch = headers['if-none-match'];
    const ifModifiedSince = headers['if-modified-since'];
    const etag = '"mock-etag-v1"';
    const lastModified = new Date('2024-01-01').toUTCString();

    // 检查 If-None-Match
    if (ifNoneMatch === etag) {
      return res.status(304).send();
    }

    // 检查 If-Modified-Since
    if (ifModifiedSince && new Date(ifModifiedSince) >= new Date(lastModified)) {
      return res.status(304).send();
    }

    res.set('ETag', etag);
    res.set('Last-Modified', lastModified);
    res.json({
      modified: true,
      etag,
      lastModified,
    });
  }

  // ============ 流式响应 ============
  @Get('stream/:chunks')
  async stream(@Req() req: Request, @Res() res: Response) {
    const chunks = parseInt(req.params.chunks, 10) || 5;
    const delay = parseInt(req.query.delay as string, 10) || 100;

    res.set('Content-Type', 'text/plain');
    res.set('Transfer-Encoding', 'chunked');

    for (let i = 1; i <= chunks; i++) {
      res.write(`Chunk ${i}/${chunks}\n`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    res.end();
  }

  // ============ SSE (Server-Sent Events) ============
  @Get('sse')
  sse(@Req() req: Request, @Res() res: Response) {
    const count = parseInt(req.query.count as string, 10) || 5;
    const interval = parseInt(req.query.interval as string, 10) || 1000;

    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache');
    res.set('Connection', 'keep-alive');

    let sent = 0;
    const timer = setInterval(() => {
      sent++;
      res.write(`id: ${sent}\n`);
      res.write(`event: message\n`);
      res.write(`data: {"count": ${sent}, "total": ${count}}\n\n`);

      if (sent >= count) {
        clearInterval(timer);
        res.end();
      }
    }, interval);

    // 客户端断开连接时清理
    req.on('close', () => {
      clearInterval(timer);
    });
  }

  // ============ WebSocket 升级模拟 ============
  @Get('websocket')
  websocket(@Req() req: Request, @Res() res: Response) {
    // 实际 WebSocket 需要额外库，这里返回升级信息
    res.status(426).json({
      error: 'Upgrade Required',
      message: 'WebSocket upgrade required',
      upgrade: 'websocket',
      connection: 'Upgrade',
      note: 'This is a mock endpoint. Use a real WebSocket library for actual WebSocket support.',
    });
  }
}
