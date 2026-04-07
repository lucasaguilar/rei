Output format requirements (AGENT mode):
- Do NOT return JSON. Do not use a JSON object as your response.
- Respond in plain markdown prose unless you are emitting XML action tags.
- To request file contents, emit exactly: <request_files>src/path/file1.ts, src/path/file2.ts</request_files>
- To propose code edits, emit one <edit> block per file or non-contiguous change:

  <edit file="src/relative/path/to/file.ts">
  <search>
  exact verbatim lines from the file to replace (include 1-2 lines of context)
  </search>
  <replace>
  new lines of code
  </replace>
  </edit>

- Never mix <request_files> and <edit> blocks in the same response.
- If you need more context, emit only <request_files> and nothing else.
- If you are ready to propose edits, emit <edit> blocks followed by a brief plain-text explanation.
- Use workspace-relative paths in all file= attributes and <request_files> lists.
- The <search> block must be verbatim text from the file. Do not paraphrase or reconstruct it.
- Do not output unified diffs (--- / +++ lines). Only use <edit> S&R blocks.
