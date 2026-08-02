import { Controller, Post, Body, Res, HttpStatus, Headers, Req, All, HttpCode } from '@nestjs/common';
import { Request, Response } from 'express';

@Controller('body')
export class BodyController {
  // ============ JSON Body ============
  @Post('json')
  @HttpCode(200)
  validateJson(@Body() body: any, @Res() res: Response) {
    const required = ['name', 'email'];
    const missing = required.filter((field) => !(field in body));

    if (missing.length > 0) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        valid: false,
        error: 'Missing required fields',
        missing,
        received: Object.keys(body),
      });
    }

    return res.json({
      valid: true,
      data: body,
      type: 'json',
    });
  }

  // ============ Form URL Encoded ============
  @Post('form')
  @HttpCode(200)
  validateForm(@Body() body: any, @Res() res: Response) {
    return res.json({
      valid: true,
      form: body,
      contentType: 'application/x-www-form-urlencoded',
      type: 'form',
    });
  }

  // ============ Multipart Form Data ============
  @Post('multipart')
  multipart(@Req() req: Request, @Res() res: Response) {
    // 注意：NestJS 默认不解析 multipart，需要 multer
    // 这里简化处理，返回接收到的原始信息
    const contentType = req.headers['content-type'] || '';

    if (!contentType.includes('multipart/form-data')) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'Content-Type must be multipart/form-data',
        received: contentType,
      });
    }

    return res.json({
      valid: true,
      message: 'Multipart received (simplified parsing)',
      contentType,
      type: 'multipart',
    });
  }

  // ============ GraphQL ============
  @Post('graphql')
  @HttpCode(200)
  graphql(@Body() body: any, @Res() res: Response) {
    const { query, variables, operationName } = body;

    if (!query) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        errors: [{ message: 'GraphQL query is required' }],
      });
    }

    // 简单的 GraphQL 模拟响应
    const response: any = {
      data: {
        __typename: 'Query',
      },
    };

    // 根据查询内容返回不同的模拟数据
    if (query.includes('user') || query.includes('User')) {
      response.data.user = {
        id: variables?.id || '123',
        name: 'Mock User',
        email: 'mock@example.com',
      };
    }

    if (query.includes('posts') || query.includes('Posts')) {
      response.data.posts = [
        { id: '1', title: 'First Post' },
        { id: '2', title: 'Second Post' },
      ];
    }

    if (operationName) {
      response.extensions = { operationName };
    }

    return res.json(response);
  }

  // ============ XML ============
  @Post('xml')
  @HttpCode(200)
  xml(@Req() req: Request, @Res() res: Response, @Headers('content-type') contentType: string) {
    if (!contentType?.includes('xml')) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'Content-Type must be application/xml or text/xml',
        received: contentType,
      });
    }

    // express.text() 现在正确解析 XML 为字符串
    const body = req.body;
    const xmlString = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');

    const isValid = xmlString.trim().startsWith('<');

    if (!isValid) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        valid: false,
        error: 'Invalid XML format',
      });
    }

    return res.json({
      valid: true,
      received: xmlString,
      contentType,
      type: 'xml',
    });
  }

  // ============ Plain Text ============
  @Post('text')
  @HttpCode(200)
  text(@Body() body: any, @Res() res: Response) {
    const text = body?.toString() || body;

    return res.json({
      valid: true,
      received: text,
      length: text?.length || 0,
      type: 'text',
    });
  }

  // ============ Binary ============
  @Post('binary')
  @HttpCode(200)
  binary(@Req() req: Request, @Res() res: Response) {
    const body = req.body;

    if (!Buffer.isBuffer(body)) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'Binary body expected',
        received: typeof body,
      });
    }

    return res.json({
      valid: true,
      size: body.length,
      base64Preview: body.toString('base64').substring(0, 50) + '...',
      type: 'binary',
    });
  }

  // ============ 任意 Body 类型 ============
  @All('any')
  any(@Req() req: Request, @Res() res: Response) {
    const contentType = req.headers['content-type'] || 'none';
    const body = req.body;

    let parsed: any;
    let type: string;

    if (Buffer.isBuffer(body)) {
      type = 'binary';
      parsed = { size: body.length, base64: body.toString('base64').substring(0, 100) };
    } else if (typeof body === 'object') {
      type = 'json';
      parsed = body;
    } else {
      type = 'text';
      parsed = body?.toString() || body;
    }

    return res.json({
      contentType,
      type,
      body: parsed,
    });
  }
}
