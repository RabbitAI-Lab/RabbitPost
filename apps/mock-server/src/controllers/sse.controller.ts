import { Controller, Get, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

@Controller('sse')
export class SseController {
  /**
   * GET /sse/stream
   * 每 1s 一条，交替默认 message 事件与自定义 `event: tick`，
   * 带自增 id，共 30 条；之后保持连接不关闭，由客户端自行断开。
   */
  @Get('stream')
  stream(@Req() req: Request, @Res() res: Response) {
    res.writeHead(200, SSE_HEADERS);
    res.write(': connected to mock sse stream\n\n');

    let id = 0;
    const timer = setInterval(() => {
      id += 1;
      if (id > 30) {
        // 30 条发完后保持连接，不再发送
        clearInterval(timer);
        return;
      }
      if (id % 2 === 1) {
        res.write(`id: ${id}\ndata: message ${id}\n\n`);
      } else {
        res.write(`id: ${id}\nevent: tick\ndata: tick ${id}\n\n`);
      }
    }, 1000);

    req.on('close', () => clearInterval(timer));
  }

  /**
   * GET /sse/finite
   * 立即发 3 条（含一条多行 data、一条自定义 event）后正常结束响应。
   */
  @Get('finite')
  finite(@Res() res: Response) {
    res.writeHead(200, SSE_HEADERS);
    res.write('id: 1\ndata: hello\n\n');
    res.write('id: 2\ndata: multi line 1\ndata: multi line 2\n\n');
    res.write('id: 3\nevent: done\ndata: finished\n\n');
    res.end();
  }
}
