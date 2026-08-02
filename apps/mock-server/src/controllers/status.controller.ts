import { Controller, All, Req, Res, HttpStatus, Get } from '@nestjs/common';
import { Request, Response } from 'express';

@Controller('status')
export class StatusController {
  private readonly validCodes = [
    200, 201, 202, 204, 206,
    301, 302, 304, 307, 308,
    400, 401, 403, 404, 405, 408, 409, 410, 418, 422, 429,
    500, 501, 502, 503, 504,
  ];

  @All(':code')
  status(@Req() req: Request, @Res() res: Response) {
    const code = parseInt(req.params.code, 10);

    if (!this.validCodes.includes(code)) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: `Invalid status code: ${code}`,
        validCodes: this.validCodes,
      });
    }

    // 对于 204 No Content，不返回 body
    if (code === 204) {
      return res.status(204).send();
    }

    // 对于 304 Not Modified，不返回 body
    if (code === 304) {
      return res.status(304).send();
    }

    // 对于重定向，设置 Location header
    if ([301, 302, 307, 308].includes(code)) {
      res.set('Location', '/status/200');
    }

    // 对于 401，设置 WWW-Authenticate
    if (code === 401) {
      res.set('WWW-Authenticate', 'Bearer realm="mock"');
    }

    // 对于 429，设置 Retry-After
    if (code === 429) {
      res.set('Retry-After', '60');
    }

    res.status(code).json({
      status: code,
      message: this.getStatusMessage(code),
      timestamp: new Date().toISOString(),
    });
  }

  @Get()
  list() {
    return {
      validCodes: this.validCodes,
      examples: this.validCodes.map((code) => ({
        code,
        url: `/status/${code}`,
        message: this.getStatusMessage(code),
      })),
    };
  }

  private getStatusMessage(code: number): string {
    const messages: Record<number, string> = {
      200: 'OK',
      201: 'Created',
      202: 'Accepted',
      204: 'No Content',
      206: 'Partial Content',
      301: 'Moved Permanently',
      302: 'Found',
      304: 'Not Modified',
      307: 'Temporary Redirect',
      308: 'Permanent Redirect',
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      405: 'Method Not Allowed',
      408: 'Request Timeout',
      409: 'Conflict',
      410: 'Gone',
      418: "I'm a teapot",
      422: 'Unprocessable Entity',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      501: 'Not Implemented',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
      504: 'Gateway Timeout',
    };
    return messages[code] || 'Unknown';
  }
}
