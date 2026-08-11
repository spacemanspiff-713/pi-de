import { StringDecoder } from "node:string_decoder";

/** Strict LF-delimited decoder matching Pi's RPC framing contract. */
export class JsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  push(chunk: Buffer | string): string[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    return this.drain(false);
  }

  end(): string[] {
    this.buffer += this.decoder.end();
    return this.drain(true);
  }

  private drain(flush: boolean): string[] {
    const records: string[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length > 0) records.push(line);
    }

    if (flush && this.buffer.length > 0) {
      const line = this.buffer.endsWith("\r") ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = "";
      if (line.length > 0) records.push(line);
    }
    return records;
  }
}
