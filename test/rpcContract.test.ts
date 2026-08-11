import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "../src/jsonl";
import { detectCapabilities } from "../src/runtime/piCapabilities";

describe("recorded Pi RPC contract", () => {
  it("decodes representative response, stream, tool, UI, and settled events", () => {
    const fixture = readFileSync(join(process.cwd(), "test", "fixtures", "rpc-session.jsonl"));
    const decoder = new JsonlDecoder();
    const records: Array<Record<string, unknown>> = [];
    for (let offset = 0; offset < fixture.length; offset += 17) {
      for (const line of decoder.push(fixture.subarray(offset, offset + 17))) {
        records.push(JSON.parse(line) as Record<string, unknown>);
      }
    }
    for (const line of decoder.end()) records.push(JSON.parse(line) as Record<string, unknown>);

    expect(records.map((record) => record.type)).toEqual([
      "response",
      "agent_start",
      "message_update",
      "message_update",
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
      "extension_ui_request",
      "message_end",
      "agent_settled",
    ]);
    expect(records[0]).toMatchObject({ success: true, data: { sessionId: "fixture-session" } });
  });

  it("detects capabilities from a recorded Pi help contract", () => {
    const help = readFileSync(join(process.cwd(), "test", "fixtures", "pi-help.txt"), "utf8");
    expect(detectCapabilities(help)).toEqual({ rpc: true, session: true, approve: true, extensions: true });
    expect(detectCapabilities("pi --mode text only").rpc).toBe(false);
  });
});
