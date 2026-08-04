import assert from "node:assert/strict";
import test from "node:test";

import { minifyHtml } from "./minify-html.mjs";

test("minifies generated HTML, inline CSS, and inline JavaScript", async () => {
  const source = `<!DOCTYPE html>
    <html><head><style> .card { color: red; } </style></head>
    <body><!--$--> <div class="card">hello</div> <!-- -->
      <script> const answer = 40 + 2; window.answer = answer; </script>
      <pre>  keep   this  </pre>
    </body></html>`;

  const output = await minifyHtml(source);

  assert.match(output, /<!--\$-->/);
  assert.match(output, /<!-- -->/);
  assert.match(output, /color:red/);
  assert.match(output, /window\.answer/);
  assert.match(output, /<pre>  keep   this  <\/pre>/);
  assert.ok(output.length < source.length);
});
