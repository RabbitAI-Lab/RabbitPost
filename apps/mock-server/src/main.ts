import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, NestMiddleware } from '@nestjs/common';
import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import * as express from 'express';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const multer = require('multer');

// multer 中间件类
class MultipartMiddleware implements NestMiddleware {
  private upload = multer({ storage: multer.memoryStorage() });

  use(req: any, res: any, next: any) {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      this.upload.any()(req, res, (err: any) => {
        if (err) return next(err);
        if (req.files && req.files.length > 0) {
          const filesObj: Record<string, any> = {};
          for (const f of req.files) {
            filesObj[f.fieldname] = filesObj[f.fieldname] || [];
            filesObj[f.fieldname].push({
              name: f.originalname, size: f.size, type: f.mimetype,
            });
          }
          req._multerFiles = filesObj;
        }
        next();
      });
    } else {
      next();
    }
  }
}

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

  // ============ Body Parser ============
  // multipart 必须最先注册
  const upload = multer({ storage: multer.memoryStorage() });
  app.use((req: any, res: any, next: any) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('multipart/form-data')) {
      upload.any()(req, res, (err: any) => {
        if (err) return next(err);
        if (req.files && req.files.length > 0) {
          const filesObj: Record<string, any> = {};
          for (const f of req.files) {
            filesObj[f.fieldname] = filesObj[f.fieldname] || [];
            filesObj[f.fieldname].push({
              name: f.originalname, size: f.size, type: f.mimetype,
            });
          }
          req._multerFiles = filesObj;
        }
        next();
      });
    } else {
      next();
    }
  });

  app.use(express.json({ limit: '50mb' }));
  app.use(express.text({
    limit: '50mb',
    type: ['text/plain', 'text/html', 'text/xml', 'application/xml',
           'text/css', 'text/javascript', 'application/graphql'],
  }));
  app.use(express.urlencoded({ extended: true, limit: '50mb' }));
  app.use(express.raw({
    limit: '50mb',
    type: ['application/octet-stream', 'image/*', 'application/pdf'],
  }));

  const port = process.env.PORT || 3090;
  await app.listen(port);
  console.log(`Mock Server running on http://localhost:${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
}
bootstrap();
