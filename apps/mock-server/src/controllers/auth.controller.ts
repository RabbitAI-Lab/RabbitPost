import { Controller, Get, Post, Req, Res, Headers, Query, Body, HttpStatus, All } from '@nestjs/common';
import { Request, Response } from 'express';

@Controller('auth')
export class AuthController {
  // ============ Basic Auth ============
  @Get('basic/:username/:password')
  basicAuth(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('authorization') auth: string,
  ) {
    const { username, password } = req.params;
    const expected = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

    if (auth !== expected) {
      return res.status(HttpStatus.UNAUTHORIZED).json({
        authenticated: false,
        error: 'Invalid credentials',
        expected,
        received: auth,
      });
    }

    return res.json({
      authenticated: true,
      user: username,
      type: 'basic',
    });
  }

  // ============ Bearer Token ============
  @Get('bearer/:token?')
  bearerAuth(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('authorization') auth: string,
  ) {
    const expectedToken = req.params.token;

    if (!auth?.startsWith('Bearer ')) {
      return res.status(HttpStatus.UNAUTHORIZED).json({
        authenticated: false,
        error: 'Missing Bearer token',
        hint: 'Use Authorization: Bearer <token>',
      });
    }

    const token = auth.slice(7);
    if (expectedToken && token !== expectedToken) {
      return res.status(HttpStatus.UNAUTHORIZED).json({
        authenticated: false,
        error: 'Invalid token',
        expected: expectedToken,
        received: token,
      });
    }

    return res.json({
      authenticated: true,
      token,
      type: 'bearer',
    });
  }

  // ============ API Key ============
  @Get('api-key')
  apiKeyAuth(
    @Req() req: Request,
    @Res() res: Response,
    @Query('api_key') queryKey: string,
    @Headers('x-api-key') headerKey: string,
  ) {
    const key = queryKey || headerKey;
    const location = queryKey ? 'query' : 'header';

    if (!key) {
      return res.status(HttpStatus.UNAUTHORIZED).json({
        authenticated: false,
        error: 'API key required',
        hint: 'Use ?api_key=<key> or X-API-Key: <key>',
      });
    }

    return res.json({
      authenticated: true,
      apiKey: key,
      location,
      type: 'api-key',
    });
  }

  // ============ Digest Auth (模拟) ============
  @Get('digest/:username/:password')
  digestAuth(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('authorization') auth: string,
  ) {
    const { username } = req.params;

    if (!auth?.startsWith('Digest ')) {
      // 返回 401 并携带 WWW-Authenticate 头
      res.set(
        'WWW-Authenticate',
        `Digest realm="mock", qop="auth", nonce="${Date.now()}", opaque="${Buffer.from(username).toString('base64')}"`,
      );
      return res.status(HttpStatus.UNAUTHORIZED).json({
        authenticated: false,
        error: 'Digest authentication required',
      });
    }

    // 简化验证：只要提供了 Digest 头就通过
    return res.json({
      authenticated: true,
      user: username,
      type: 'digest',
      note: 'Simplified validation - full digest not implemented',
    });
  }

  // ============ OAuth2 模拟 ============
  @Get('oauth2/authorize')
  oauth2Authorize(@Req() req: Request, @Res() res: Response, @Query() query: any) {
    const { client_id, redirect_uri, state, response_type } = query;

    if (!client_id || !redirect_uri) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'invalid_request',
        error_description: 'client_id and redirect_uri are required',
      });
    }

    if (response_type !== 'code') {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'unsupported_response_type',
        error_description: 'Only code is supported',
      });
    }

    // 模拟授权码
    const code = `mock_auth_code_${Date.now()}`;
    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set('code', code);
    if (state) redirectUrl.searchParams.set('state', state);

    res.redirect(redirectUrl.toString());
  }

  @All('oauth2/token')
  oauth2Token(@Req() req: Request, @Res() res: Response, @Body() body: any) {
    const { grant_type, code, client_id, client_secret } = body;

    if (grant_type !== 'authorization_code') {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'unsupported_grant_type',
      });
    }

    if (!code || !client_id) {
      return res.status(HttpStatus.BAD_REQUEST).json({
        error: 'invalid_request',
      });
    }

    // 模拟令牌响应
    res.json({
      access_token: `mock_access_token_${Date.now()}`,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: `mock_refresh_token_${Date.now()}`,
      scope: 'read write',
    });
  }
}
