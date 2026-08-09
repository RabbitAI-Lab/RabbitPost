import http from "node:http";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveRequestSettings } from "@rabbitpost/shared";
import { sendRequest } from "../src/lib/http-client";

/** 响应体按 Content-Encoding 自动解压（gzip / deflate / 裸 deflate / br） */

const PLAIN = '{"compressed":true}';

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = Buffer.from(PLAIN);
    switch (req.url) {
      case "/gzip":
        res.writeHead(200, { "content-encoding": "gzip" });
        res.end(zlib.gzipSync(body));
        return;
      case "/deflate":
        res.writeHead(200, { "content-encoding": "deflate" });
        res.end(zlib.deflateSync(body));
        return;
      case "/deflate-raw":
        res.writeHead(200, { "content-encoding": "deflate" });
        res.end(zlib.deflateRawSync(body));
        return;
      case "/br":
        res.writeHead(200, { "content-encoding": "br" });
        res.end(zlib.brotliCompressSync(body));
        return;
      default:
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function get(path: string): Promise<string> {
  const { response } = await sendRequest({
    method: "GET",
    url: new URL(`${baseUrl}${path}`),
    headers: {},
    settings: resolveRequestSettings(undefined),
  });
  return response.body.toString("utf-8");
}

describe("http-client 响应解压", () => {
  it("gzip", async () => {
    expect(await get("/gzip")).toBe(PLAIN);
  });

  it("deflate（zlib 包装）", async () => {
    expect(await get("/deflate")).toBe(PLAIN);
  });

  it("deflate（裸 deflate 回退）", async () => {
    expect(await get("/deflate-raw")).toBe(PLAIN);
  });

  it("brotli", async () => {
    expect(await get("/br")).toBe(PLAIN);
  });

  it("无 content-encoding 时原样返回", async () => {
    expect(await get("/plain")).toBe(PLAIN);
  });
});
