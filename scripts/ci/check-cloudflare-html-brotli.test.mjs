import assert from "node:assert/strict";
import test from "node:test";

import { assertExactBrotliResponse, parseHeaders } from "./check-cloudflare-html-brotli.mjs";

test("parses the final response header block", () => {
  const headers = parseHeaders(
    "HTTP/2 301\r\nlocation: /apply\r\n\r\nHTTP/2 200\r\nContent-Encoding: br\r\nContent-Length: 4\r\n\r\n",
  );
  assert.equal(headers.get("content-encoding"), "br");
  assert.equal(headers.get("content-length"), "4");
});

test("requires exact Brotli bytes and lengths", () => {
  const body = Buffer.from([1, 2, 3, 4]);
  const headers = new Map([
    ["content-encoding", "br"],
    ["content-length", "4"],
  ]);
  assert.doesNotThrow(() =>
    assertExactBrotliResponse({
      document: body,
      sidecar: Buffer.from(body),
      documentHeaders: headers,
      sidecarHeaders: new Map([["content-length", "4"]]),
    }),
  );
  assert.throws(
    () =>
      assertExactBrotliResponse({
        document: Buffer.from([1, 2, 3]),
        sidecar: body,
        documentHeaders: new Map([
          ["content-encoding", "br"],
          ["content-length", "3"],
        ]),
        sidecarHeaders: new Map([["content-length", "4"]]),
      }),
    /differ from the sidecar/,
  );
});
