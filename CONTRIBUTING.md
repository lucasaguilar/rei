# Contributing to REI

Thank you for considering it.

REI's bet is one sentence: **trust nothing the model says — verify every edit against ground
truth.** Contributions are held to the same rule. A change is done when the compiler and the tests
say so, not when it looks right.

## Where help counts most

These are gaps the project already knows it has:

- **A language REI can verify.** Detection plus a real check command is about twenty lines in
  `src/workspace/project-type.ts` and a test —
  [the recipe](docs/DEVELOPER-GUIDE.md#recipe-add-a-language-rei-can-verify). The one rule: the
  command must be able to fail. An unrecognised project gets no check, never a fake pass.
- **Structured errors beyond TypeScript and C#.** Those two have parsers that turn compiler output
  into file, line and the files an error refers to. Every other language hands the model the raw
  output. A parser for Rust, Go or Python makes the fix loop much sharper.
- **Monorepos.** The project type is detected at the workspace root. Routing the check from the
  edited file up to its nearest project marker would verify what was actually touched.
- **Model providers.** A new backend is a class, two registrations and its docs —
  [the recipe](docs/DEVELOPER-GUIDE.md#recipe-add-a-model-provider).
- **REI Desktop on Windows and Linux** (`desktop/`, experimental). It has only been run on macOS,
  and the hidden title bar needs window controls on the other two.

Anything else is welcome too. For something large, open an issue first so the design can be agreed
before the code is written.

## Setup

Node 20 or later.

```bash
npm install
npm run build        # some tests run the compiled entrypoint — without dist/ they fail
npx tsc --noEmit     # the same typecheck CI runs; must be clean
npx vitest run       # must be green
```

`npm run dev` runs REI from source.

## The rules

They live in [AGENTS.md](AGENTS.md), which REI itself reads as its working rules in this repo. In
short:

- **Regression test first, and watch it fail.** A test that passes against the unfixed code proves
  nothing.
- **Source files stay under 400 lines.** `src/meta/file-size.test.ts` enforces it — split the
  module instead of extending the allowlist.
- **ESM.** Relative imports carry the `.js` extension, even from a `.ts` file.
- **English** in code, comments and anything the user sees.
- **Comments say why**, not what: the bug a line prevents, the constraint it satisfies.
- **Never claim more than was checked.** In code, in reports, in docs.

## Pull requests

1. Fork, and branch from `main` (`feat/…`, `fix/…`, `docs/…`).
2. **Atomic commits**, one logical change each, every one compiling and green. Messages follow
   `type(scope): subject`, a blank line, then prose explaining *why*.
3. Open the PR against `main`. Say what changed, how you verified it, and what you did **not**
   verify.
4. If user-facing behaviour changes, update `README.md` or the doc under `docs/` that describes it.

## Where to start reading

- [Developer guide](docs/DEVELOPER-GUIDE.md) — recipes for a slash command, a tool, a provider,
  a language: the exact files, in order, and how to verify.
- [REI internals](docs/rei-internals.md) — modes, the validation pipeline, prompt assembly, the
  token budget.

## Also

- Security issues: **not** in a public issue — see [SECURITY.md](SECURITY.md).
- Conduct: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
