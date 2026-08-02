import { Module } from '@nestjs/common';
import { EchoController } from './controllers/echo.controller';
import { AuthController } from './controllers/auth.controller';
import { BodyController } from './controllers/body.controller';
import { StatusController } from './controllers/status.controller';
import { AdvancedController } from './controllers/advanced.controller';
import { HealthController } from './controllers/health.controller';
import { PostmanEchoController } from './controllers/postman-echo.controller';

@Module({
  controllers: [
    HealthController,
    EchoController,
    AuthController,
    BodyController,
    StatusController,
    AdvancedController,
    PostmanEchoController, // Postman Echo 兼容路径
  ],
})
export class AppModule {}
