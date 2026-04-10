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

- To create a new file, emit one <create> block per file:

  <create file="src/relative/path/to/newfile.ts">
  full file contents
  </create>

- Only use <create> blocks for files that do not exist yet.
- Do not use <edit> for new files; always use <create>.
- You may emit <create> and <edit> blocks in the same response if needed.
- The system will ignore <create> blocks for files that already exist.

- Never mix <request_files> and <edit> blocks in the same response.
- If you need more context, emit only <request_files> and nothing else.
- If you are ready to propose edits, emit <edit> blocks followed by a brief plain-text explanation.
- Use workspace-relative paths in all file= attributes and <request_files> lists.
- The <search> block must be verbatim text from the file. Do not paraphrase or reconstruct it.
- Do not output unified diffs (--- / +++ lines). Only use <edit> S&R blocks.
