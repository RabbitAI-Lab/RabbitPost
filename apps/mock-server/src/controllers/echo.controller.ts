import {
  Controller,
  All,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Options,
  Head,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Controller()
export class EchoController {
  @All('echo')
  echo(@Req() req: Request, @Res() res: Response) {
    res.status(HttpStatus.OK).json(this.buildPostmanEcho(req));
  }

  @Get('get')
  get(@Req() req: Request) {
    return this.buildPostmanEcho(req);
  }

  @Post('post')
  @HttpCode(200)
  post(@Req() req: Request) {
    return this.buildPostmanEcho(req);
  }

  @Put('put')
  @HttpCode(200)
  put(@Req() req: Request) {
    return this.buildPostmanEcho(req);
  }

  @Patch('patch')
  @HttpCode(200)
  patch(@Req() req: Request) {
    return this.buildPostmanEcho(req);
  }

  @Delete('delete')
  @HttpCode(200)
  delete(@Req() req: Request) {
    return this.buildPostmanEcho(req);
  }

  @Head('head')
  head(@Req() req: Request, @Res() res: Response) {
    res.set({ 'X-Echo-Method': req.method });
    res.status(HttpStatus.OK).send();
  }

  @Options('options')
  options(@Req() req: Request, @Res() res: Response) {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,HEAD,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    res.status(HttpStatus.OK).send();
  }

  // ============ Postman Echo 格式 ============
  private buildPostmanEcho(req: Request) {
    const contentType = (req.headers['content-type'] || '').toLowerCase();

    const echo: any = {
      args: req.query,
      data: '',
      files: {},
      form: {},
      headers: this.filterHeaders(req.headers),
      json: null,
      url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
    };

    // 根据 Content-Type 填充 body 字段
    if (contentType.includes('application/json')) {
      // JSON body
      if (req.body && typeof req.body === 'object') {
        echo.json = req.body;
        echo.data = JSON.stringify(req.body);
      } else if (typeof req.body === 'string') {
        try {
          echo.json = JSON.parse(req.body);
          echo.data = req.body;
        } catch {
          echo.data = req.body;
        }
      }
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      // URL-encoded form data
      if (req.body && typeof req.body === 'object') {
        echo.form = req.body;
        echo.json = req.body;
      }
    } else if (contentType.includes('multipart/form-data')) {
      // multipart/form-data: multer 已解析字段到 req.body
      const body = req.body || {};
      const form: Record<string, string> = {};
      for (const [key, value] of Object.entries(body)) {
        form[key] = String(value);
      }
      echo.form = form;
      echo.json = form;
      echo.files = (req as any)._multerFiles || {};
    } else if (
      contentType.includes('text/plain') ||
      contentType.includes('text/html') ||
      contentType.includes('text/xml') ||
      contentType.includes('application/xml')
    ) {
      // Raw text: data 存原始文本
      const text = typeof req.body === 'string' ? req.body : '';
      echo.data = text;
    } else if (Buffer.isBuffer(req.body)) {
      echo.data = req.body.toString('utf8');
    } else if (typeof req.body === 'string') {
      echo.data = req.body;
    } else if (req.body && typeof req.body === 'object') {
      echo.json = req.body;
      echo.data = JSON.stringify(req.body);
    }

    return echo;
  }

  private filterHeaders(headers: any) {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        result[key] = value;
      } else if (Array.isArray(value)) {
        result[key] = value.join(', ');
      }
    }
    return result;
  }
}
