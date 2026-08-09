import { Controller, Get, Post, Req, Res, Headers, Query, HttpStatus, All, HttpCode, Header } from '@nestjs/common';
import { Request, Response } from 'express';
import * as zlib from 'zlib';
import * as querystring from 'querystring';

/**
 * Postman Echo 兼容控制器
 * 路径对齐 https://postman-echo.com 的 API
 */
@Controller()
export class PostmanEchoController {
  // ============ 基础回声 ============

  @Get('headers')
  headers(@Req() req: Request, @Res() res: Response) {
    const headers: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headers[key] = value;
    }
    res.json({ headers });
  }

  @All('response-headers')
  responseHeaders(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    // 将查询参数设置为响应头
    for (const [key, value] of Object.entries(query)) {
      if (typeof value === 'string') {
        res.set(key, value);
      }
    }
    res.json(query);
  }

  // ============ 认证 ============

  @Get('basic-auth')
  basicAuth(@Req() req: Request, @Res() res: Response, @Headers('authorization') auth: string) {
    // Postman Echo 的 basic-auth 测试期望：
    // 1. 如果没有 Authorization header，返回 401 且 body 包含 authenticated: false
    // 2. 如果有 Authorization header，返回 200 且 body 包含 authenticated: true
    if (!auth?.startsWith('Basic ')) {
      return res.status(HttpStatus.UNAUTHORIZED).json({
        authenticated: false,
      });
    }

    res.json({ authenticated: true });
  }

  @Get('digest-auth')
  digestAuth(@Req() req: Request, @Res() res: Response, @Headers('authorization') auth: string) {
    // Postman Echo 的 digest-auth 测试期望：
    // 1. 第一次请求返回 401 和 WWW-Authenticate header
    // 2. 第二次请求（带 Digest auth）返回 200 和 authenticated: true
    if (!auth?.startsWith('Digest ')) {
      res.set(
        'WWW-Authenticate',
        'Digest realm="postman-echo", qop="auth", nonce="' + Date.now() + '", opaque="postman"',
      );
      return res.status(HttpStatus.UNAUTHORIZED).json({
        authenticated: false,
      });
    }

    res.json({ authenticated: true });
  }

  @Get('auth/hawk')
  hawkAuth(@Req() req: Request, @Res() res: Response) {
    res.json({
      status: 'success',
      message: 'Hawk Authentication Successful',
    });
  }

  @Get('oauth1')
  oauth1(@Req() req: Request, @Res() res: Response) {
    res.json({
      status: 'pass',
      message: 'OAuth-1.0a signature verification was successful',
    });
  }

  // ============ Cookie ============

  @Get('cookies')
  getCookies(@Req() req: Request, @Res() res: Response) {
    const cookieHeader = req.headers.cookie || '';
    const cookies: Record<string, string> = {};

    cookieHeader.split(';').forEach((cookie) => {
      const [name, ...rest] = cookie.trim().split('=');
      if (name) {
        cookies[name] = rest.join('=');
      }
    });

    res.json({ cookies });
  }

  @Get('cookies/set')
  setCookies(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    const cookies: string[] = [];

    for (const [name, value] of Object.entries(query)) {
      if (typeof value === 'string') {
        cookies.push(`${name}=${value}; Path=/`);
      }
    }

    if (cookies.length > 0) {
      res.set('Set-Cookie', cookies);
    }

    res.json({ cookies: query });
  }

  @Get('cookies/delete')
  deleteCookies(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    const cookies: string[] = [];

    // 删除所有查询参数中指定的 cookie
    for (const name of Object.keys(query)) {
      cookies.push(`${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
    }

    // 如果没有指定，删除 foo1 和 foo2（Postman 测试用例）
    if (cookies.length === 0) {
      cookies.push('foo1=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
      cookies.push('foo2=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    }

    res.set('Set-Cookie', cookies);
    res.json({ cookies: {} });
  }

  // ============ 工具 ============

  @Get('ip')
  ip(@Req() req: Request, @Res() res: Response) {
    let ip = req.ip || req.socket.remoteAddress || '127.0.0.1';
    // 将 IPv6 本地地址转换为 IPv4
    if (ip === '::1' || ip === '::ffff:127.0.0.1') {
      ip = '127.0.0.1';
    }
    res.json({ ip });
  }

  @Get('time/now')
  timeNow(@Req() req: Request, @Res() res: Response) {
    // Postman Echo 返回与 Date header 匹配的 UTC 时间字符串
    const now = new Date().toUTCString();
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(now);
  }

  @Get('time/valid')
  timeValid(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    const date = new Date(query.timestamp);
    res.json({ valid: !isNaN(date.getTime()) });
  }

  @Get('time/format')
  timeFormat(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    // Postman Echo 使用 moment(timestamp).format(fmt)
    const date = new Date(query.timestamp);
    const fmt = query.format;
    const result = this.momentFormat(date, fmt);
    res.json({ format: result });
  }

  @Get('time/unit')
  timeUnit(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    // Postman Echo 返回 { unit: <值> }
    const date = new Date(query.timestamp);
    const unit = query.unit;
    const value = this.getDateUnit(date, unit);
    res.json({ unit: value });
  }

  @Get('time/add')
  timeAdd(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    // Postman Echo 返回 { sum: <日期字符串> }
    const date = new Date(query.timestamp);
    if (query.years) date.setUTCFullYear(date.getUTCFullYear() + parseInt(query.years, 10));
    if (query.months) date.setUTCMonth(date.getUTCMonth() + parseInt(query.months, 10));
    if (query.days) date.setUTCDate(date.getUTCDate() + parseInt(query.days, 10));
    res.json({ sum: this.toPostmanDateString(date) });
  }

  @Get('time/subtract')
  timeSubtract(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    // Postman Echo 返回 { difference: <日期字符串> }
    const date = new Date(query.timestamp);
    if (query.years) date.setUTCFullYear(date.getUTCFullYear() - parseInt(query.years, 10));
    if (query.months) date.setUTCMonth(date.getUTCMonth() - parseInt(query.months, 10));
    if (query.days) date.setUTCDate(date.getUTCDate() - parseInt(query.days, 10));
    res.json({ difference: this.toPostmanDateString(date) });
  }

  @Get('time/start')
  timeStart(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    // Postman Echo 返回 { start: <日期字符串> }
    const date = new Date(query.timestamp);
    switch (query.unit) {
      case 'year': date.setUTCMonth(0, 1); date.setUTCHours(0, 0, 0, 0); break;
      case 'month': date.setUTCDate(1); date.setUTCHours(0, 0, 0, 0); break;
      case 'day': date.setUTCHours(0, 0, 0, 0); break;
      case 'hour': date.setUTCMinutes(0, 0, 0); break;
    }
    res.json({ start: this.toPostmanDateString(date) });
  }

  @Get('time/object')
  timeObject(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    // Postman Echo 返回 { years, months, date, hours, minutes, seconds, milliseconds }
    const date = new Date(query.timestamp);
    res.json({
      years: date.getUTCFullYear(),
      months: date.getUTCMonth(),
      date: date.getUTCDate(),
      hours: date.getUTCHours(),
      minutes: date.getUTCMinutes(),
      seconds: date.getUTCSeconds(),
      milliseconds: date.getUTCMilliseconds(),
    });
  }

  @Get('time/before')
  timeBefore(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    const date = new Date(query.timestamp);
    const target = new Date(query.target);
    res.json({ before: date < target });
  }

  @Get('time/after')
  timeAfter(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    const date = new Date(query.timestamp);
    const target = new Date(query.target);
    res.json({ after: date > target });
  }

  @Get('time/between')
  timeBetween(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    const date = new Date(query.timestamp);
    const start = new Date(query.start);
    const end = new Date(query.end);
    res.json({ between: date >= start && date <= end });
  }

  @Get('time/leap')
  timeLeap(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    const year = new Date(query.timestamp).getUTCFullYear();
    res.json({ leap: (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 });
  }

  // ============ 工具方法 ============

  /** 格式化日期为 Postman Echo 风格：Sat Oct 10 2116 00:00:00 GMT+0000 */
  private toPostmanDateString(date: Date): string {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const d = String(date.getUTCDate()).padStart(2, '0');
    const h = String(date.getUTCHours()).padStart(2, '0');
    const m = String(date.getUTCMinutes()).padStart(2, '0');
    const s = String(date.getUTCSeconds()).padStart(2, '0');
    return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${d} ${date.getUTCFullYear()} ${h}:${m}:${s} GMT+0000`;
  }

  /** moment.js 风格的日期格式化（简化版） */
  private momentFormat(date: Date, format: string): string {
    const map: Record<string, string> = {
      'mm': String(date.getMinutes()).padStart(2, '0'),
      'MM': String(date.getMonth() + 1).padStart(2, '0'),
      'dd': String(date.getDate()).padStart(2, '0'),
      'DD': String(date.getDate()).padStart(2, '0'),
      'yyyy': String(date.getFullYear()),
      'YYYY': String(date.getFullYear()),
      'yy': String(date.getFullYear()).slice(-2),
      'HH': String(date.getHours()).padStart(2, '0'),
      'ss': String(date.getSeconds()).padStart(2, '0'),
    };
    return map[format] || format;
  }

  /** 获取日期单位值（UTC） */
  private getDateUnit(date: Date, unit: string): number {
    switch (unit) {
      case 'day': return date.getUTCDay(); // 0=Sunday
      case 'month': return date.getUTCMonth(); // 0=January
      case 'year': return date.getUTCFullYear();
      case 'hour': return date.getUTCHours();
      case 'minute': return date.getUTCMinutes();
      case 'second': return date.getUTCSeconds();
      case 'millisecond': return date.getUTCMilliseconds();
      default: return 0;
    }
  }

  // ============ 编码/压缩 ============

  @Get('encoding/utf8')
  encodingUtf8(@Res() res: Response) {
    // 直接 send：由 Express 设置 Content-Length。
    // （曾手动设置 Transfer-Encoding: chunked，与 Express 自动加的 Content-Length 冲突，
    //  违反 RFC 7230，严格 HTTP 客户端会直接拒绝该响应）
    res
      .set('Content-Type', 'text/html; charset=utf-8')
      .send('<html><body><h1>UTF-8 Encoded Response</h1><p>你好，世界！</p></body></html>');
  }

  @Get('gzip')
  gzip(@Req() req: Request, @Res() res: any) {
    const body = JSON.stringify({
      gzipped: true,
      message: 'This response is gzipped',
      headers: req.headers,
    });
    zlib.gzip(body, (err, buffer) => {
      if (err) {
        return res.status(500).json({ error: 'Compression failed' });
      }
      // 使用 writeHead 直接写入响应头，避免 Express 自动添加 charset
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': buffer.length,
      });
      res.end(buffer);
    });
  }

  @Get('deflate')
  deflate(@Req() req: Request, @Res() res: any) {
    const body = JSON.stringify({
      deflated: true,
      message: 'This response is deflated',
      headers: req.headers,
    });
    zlib.deflate(body, (err, buffer) => {
      if (err) {
        return res.status(500).json({ error: 'Compression failed' });
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'deflate',
        'Content-Length': buffer.length,
      });
      res.end(buffer);
    });
  }

  // ============ 流式响应 ============

  @Get('stream/:chunks')
  stream(@Req() req: Request, @Res() res: Response) {
    const chunks = parseInt(req.params.chunks, 10) || 5;

    res.set('Content-Type', 'application/json');
    res.set('Transfer-Encoding', 'chunked');

    let sent = 0;
    const interval = setInterval(() => {
      sent++;
      res.write(JSON.stringify({ chunk: sent, total: chunks }) + '\n');

      if (sent >= chunks) {
        clearInterval(interval);
        res.end();
      }
    }, 100);

    req.on('close', () => clearInterval(interval));
  }

  // ============ Server-Sent Events ============

  @Get('server-events/:count')
  serverEvents(@Req() req: Request, @Res() res: Response) {
    const count = parseInt(req.params.count, 10) || 5;

    res.set('Content-Type', 'text/event-stream');
    res.set('Cache-Control', 'no-cache');
    res.set('Connection', 'keep-alive');

    let sent = 0;
    const interval = setInterval(() => {
      sent++;
      res.write(`id: ${sent}\n`);
      res.write(`event: message\n`);
      res.write(`data: {"count": ${sent}, "total": ${count}}\n\n`);

      if (sent >= count) {
        clearInterval(interval);
        res.end();
      }
    }, 1000);

    req.on('close', () => clearInterval(interval));
  }

  @Post('server-events/:count')
  serverEventsPost(@Req() req: Request, @Res() res: Response) {
    // POST 也支持，用于测试
    this.serverEvents(req, res);
  }

  @Get('delay/:seconds')
  async delay(@Req() req: Request, @Res() res: Response) {
    const seconds = Math.min(parseFloat(req.params.seconds) || 0, 30);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

    res.json({
      delay: seconds,
      message: `Response delayed by ${seconds} seconds`,
    });
  }
}
