/**
 * db 基础设施纯单元测试：
 * - lib/crypto.ts：AES-256-GCM 加解密 round-trip / 错误密钥 / 格式错误 / 缺失 DB_SECRET_KEY
 * - lib/db-client.ts：`?` → `$n` 占位符转换（跳过字符串字面量、??、dollar-quoted）
 * - lib/executor.ts extractDbValue：声明式 db 操作的提取语义（rows/row/row.col/value）
 */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../src/lib/crypto";
import { questionToDollarPlaceholders } from "../src/lib/db-client";
import { extractDbValue } from "../src/lib/executor";

const TEST_KEY = crypto.randomBytes(32).toString("base64");

beforeEach(() => {
  process.env.DB_SECRET_KEY = TEST_KEY;
});

afterEach(() => {
  process.env.DB_SECRET_KEY = TEST_KEY;
});

describe("crypto: AES-256-GCM encrypt/decrypt", () => {
  it("round-trip 还原明文，密文带 v1 前缀", () => {
    const enc = encryptSecret("p@ssw0rd 秘密");
    expect(enc.startsWith("v1:")).toBe(true);
    expect(decryptSecret(enc)).toBe("p@ssw0rd 秘密");
  });

  it("相同明文每次产出不同密文（随机 IV）", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("错误密钥解密失败", () => {
    const enc = encryptSecret("secret");
    process.env.DB_SECRET_KEY = crypto.randomBytes(32).toString("base64");
    expect(() => decryptSecret(enc)).toThrow(/decrypt/);
  });

  it("格式错误抛错", () => {
    expect(() => decryptSecret("not-a-payload")).toThrow(/format/);
    expect(() => decryptSecret("v2:aa:bb:cc")).toThrow(/format/);
  });

  it("DB_SECRET_KEY 缺失或长度非法时报错清晰", () => {
    delete process.env.DB_SECRET_KEY;
    expect(() => encryptSecret("x")).toThrow(/DB_SECRET_KEY is not set/);
    process.env.DB_SECRET_KEY = Buffer.from("short").toString("base64");
    expect(() => encryptSecret("x")).toThrow(/32-byte/);
  });
});

describe("questionToDollarPlaceholders", () => {
  it("基本转换：? → $1..$n", () => {
    expect(questionToDollarPlaceholders("SELECT * FROM t WHERE a = ? AND b = ?")).toBe(
      "SELECT * FROM t WHERE a = $1 AND b = $2",
    );
  });

  it("单引号字符串内的 ? 不转换", () => {
    expect(questionToDollarPlaceholders("SELECT '?' AS q, x FROM t WHERE y = ?")).toBe(
      "SELECT '?' AS q, x FROM t WHERE y = $1",
    );
  });

  it("单引号转义 '' 后仍能正确找到字符串边界", () => {
    expect(questionToDollarPlaceholders("SELECT 'it''s ?' WHERE a = ?")).toBe(
      "SELECT 'it''s ?' WHERE a = $1",
    );
  });

  it("双引号标识符内的 ? 不转换", () => {
    expect(questionToDollarPlaceholders('SELECT "col?" FROM t WHERE a = ?')).toBe(
      'SELECT "col?" FROM t WHERE a = $1',
    );
  });

  it("dollar-quoted 段内的 ? 不转换", () => {
    expect(questionToDollarPlaceholders("SELECT $$a?b$$, $tag$x?$tag$ WHERE y = ?")).toBe(
      "SELECT $$a?b$$, $tag$x?$tag$ WHERE y = $1",
    );
  });

  it("??（标识符占位符）不转换，其后的 ? 正常编号", () => {
    expect(questionToDollarPlaceholders("SELECT * FROM ?? WHERE id = ?")).toBe(
      "SELECT * FROM ?? WHERE id = $1",
    );
  });
});

describe("extractDbValue", () => {
  const queryResult = {
    rows: [
      { id: 1, name: "alice", vip: false },
      { id: 2, name: "bob", vip: true },
    ],
    rowCount: 2,
  };

  it("rows → 全部行 JSON 字符串", () => {
    expect(extractDbValue("rows", queryResult)).toBe(JSON.stringify(queryResult.rows));
  });

  it("row → 首行 JSON 字符串", () => {
    expect(extractDbValue("row", queryResult)).toBe(JSON.stringify(queryResult.rows[0]));
  });

  it("row.<col> → 标量字符串（数字/布尔转字符串，null → 空串）", () => {
    expect(extractDbValue("row.id", queryResult)).toBe("1");
    expect(extractDbValue("row.name", queryResult)).toBe("alice");
    expect(extractDbValue("row.vip", queryResult)).toBe("false");
    expect(extractDbValue("row.missing", queryResult)).toBe("");
  });

  it("空结果集：row → null，row.col → 空串", () => {
    const empty = { rows: [], rowCount: 0 };
    expect(extractDbValue("row", empty)).toBe("null");
    expect(extractDbValue("row.id", empty)).toBe("");
    expect(extractDbValue("rows", empty)).toBe("[]");
  });

  it("value → redis 返回值（字符串原样，其他 JSON 序列化）", () => {
    expect(extractDbValue("value", undefined, "PONG")).toBe("PONG");
    expect(extractDbValue("value", undefined, 42)).toBe("42");
    expect(extractDbValue("value", undefined, ["a", "b"])).toBe('["a","b"]');
    expect(extractDbValue("value", undefined, null)).toBe("");
  });
});
