import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "../src/jsonl";

describe("JsonlDecoder", () => {
  it("reassembles records split across UTF-8 chunks", () => {
    const decoder = new JsonlDecoder();
    const bytes = Buffer.from('{"text":"hello π"}\n{"ok":true}\r\n');
    expect(decoder.push(bytes.subarray(0, 17))).toEqual([]);
    expect(decoder.push(bytes.subarray(17))).toEqual([
      '{"text":"hello π"}',
      '{"ok":true}',
    ]);
  });

  it("does not split on Unicode line separators", () => {
    const decoder = new JsonlDecoder();
    expect(decoder.push('{"text":"a b c"}\n')).toEqual(['{"text":"a b c"}']);
  });

  it("flushes a final record without LF", () => {
    const decoder = new JsonlDecoder();
    decoder.push('{"ok":');
    decoder.push("true}");
    expect(decoder.end()).toEqual(['{"ok":true}']);
  });
});
