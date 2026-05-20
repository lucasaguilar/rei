# Hybrid AST Context Engine

## Goal

Provide **language-aware structural code understanding** for REI context generation.

Preserve the current high-quality TypeScript/JavaScript AST workflow while introducing a polyglot structural parsing fallback for other languages.

This improves:

- semantic chunking
- repository context selection
- dependency extraction
- multi-language support

without requiring immediate deep native integrations for every language.

---

## Problem

Current state:

### TypeScript / JavaScript
Strong support via ts-morph:
- AST parsing
- dependency extraction
- intelligent chunking
- project awareness

### Other languages
Weak fallback:
- plain text chunking
- heuristic context extraction
- arbitrary chunk boundaries
- poor symbol awareness

Result:

LLM receives noisy context like:

```text
chars 0-1000
chars 1001-2000
````

instead of:

```text
chunk 1 = UserService class
chunk 2 = ValidateUser()
chunk 3 = IRepository interface
```

This reduces reasoning quality.

---

## Architectural Direction

Hybrid engine:

```text
TypeScript / JavaScript   -> ts-morph
Other supported languages -> Tree-sitter
Unsupported languages     -> heuristic fallback
```

Long-term evolution:

```text
TS/JS     -> ts-morph
C#        -> Roslyn
C/C++     -> Clang
Rust      -> rust-analyzer
Python    -> Pyright/Jedi
Fallback  -> Tree-sitter
Last resort -> heuristics
```

---

# Functional Requirements

## FR-1 Language-aware parser dispatch

System must automatically select parser based on language.

Example:

```ts
AstProviderFactory.resolve(languageId)
```

Expected outputs:

```ts
TsMorphProvider
TreeSitterProvider
HeuristicProvider
```

Dispatch must happen per file.

Mixed-language repositories must be supported.

Example:

```text
frontend/app.ts
backend/api.py
firmware/driver.c
```

Expected:

* TS via ts-morph
* Python via Tree-sitter
* C via Tree-sitter

---

## FR-2 Preserve TS/JS behavior

Current TypeScript/JavaScript behavior must remain unchanged.

Requirements:

* retain ts-morph parsing
* retain current dependency extraction
* retain current chunk precision
* no regression

TS/JS remains the gold standard implementation.

---

## FR-3 Tree-sitter fallback support

Introduce Tree-sitter structural parsing for non-TS languages.

Initial target languages:

* C
* C++
* C#
* Rust
* Python

Tree-sitter provides broad syntax support quickly.

---

## FR-4 Structural AST chunk extraction

Chunk code using structural AST nodes instead of arbitrary text splitting.

Examples:

### C

Chunk types:

* function_definition
* struct_specifier
* enum_specifier
* typedef

Example:

```c
typedef struct {
   int x;
} Foo;
```

One chunk.

```c
void process(Foo* f) {
   ...
}
```

Another chunk.

---

### C#

Chunk types:

* class_declaration
* method_declaration
* interface_declaration
* namespace_declaration

Example:

```csharp
class UserService {
   public void Validate() { }
}
```

Chunks:

```text
UserService
Validate()
```

---

### Python

Chunk types:

* function_definition
* class_definition

---

Goal:

Logical code units.

Not:

```text
chars 500-1500
```

---

## FR-5 Chunk metadata normalization

All providers must emit a shared normalized schema.

Example:

```ts
interface AstChunk {
    filePath: string;
    languageId: string;
    nodeType: string;
    symbolName?: string;
    startLine: number;
    endLine: number;
    content: string;
}
```

This is critical.

It enables language-specific providers without changing agent logic.

Future providers:

* ts-morph
* Tree-sitter
* Clang
* Roslyn
* rust-analyzer

All feed same evidence format.

---

## FR-6 Lightweight dependency extraction

Extract structural dependency hints.

Examples:

### TypeScript

```ts
import { Foo } from "./foo";
```

Extract:

```text
./foo
```

---

### C

```c
#include "driver.h"
```

Extract:

```text
driver.h
```

---

### C#

```csharp
using System.Text;
```

Extract:

```text
System.Text
```

---

### Python

```python
from utils import parse
```

Extract:

```text
utils
```

---

Important:

Structural hints only.

NOT semantic resolution.

Allowed:

```text
uses System.Text
```

Not required:

```text
resolved filesystem path
```

---

## FR-7 Parser abstraction

Define common parser interface.

Example:

```ts
interface AstProvider {
    supports(languageId: string): boolean;

    extractChunks(file: SourceFile): AstChunk[];

    extractDependencies(file: SourceFile): DependencyHint[];

    extractSkeleton(file: SourceFile): string;
}
```

This prevents parser-specific coupling.

---

## FR-8 Graceful fallback

If parsing fails:

fallback automatically.

Failure cases:

* unsupported language
* parser crash
* malformed source
* missing grammar
* timeout

System must never block agent execution.

Fallback:

```text
heuristic/plain text chunking
```

---

# Non-functional Requirements

## NFR-1 Performance

Targets:

Small repo:

```text
< 2 sec
```

Medium repo:

```text
< 10 sec
```

Lazy grammar loading preferred.

---

## NFR-2 Reliability

Parser failures must not crash:

* agent mode
* indexing
* context generation

---

## NFR-3 Cross-platform

Must support:

* Windows
* Linux
* macOS

---

## NFR-4 Memory

Grammar loading must not grow unbounded.

Load parsers lazily (only load when needed strategy).

---

## NFR-5 Zero TS Regression

Highest priority.

Current TS precision must remain untouched.

## NFR-6: Zero-friction Parser Distribution

The polyglot AST parsing solution must not require contributors to install native build toolchains or platform-specific compiler dependencies.

Requirements:
- must work with standard `npm install`
- must be cross-platform (Windows/Linux/macOS)
- must minimize environment-specific setup failures
- must support scalable multi-language parser distribution

Rationale:
The Hybrid AST Context Engine is a context enrichment feature, not a compiler-grade semantic engine. Contributor experience and portability are prioritized over maximum parsing performance. [web-tree-sitter](https://www.npmjs.com/package/web-tree-sitter) is preferred over native tree-sitter because:
- no native build tools required
- easier contributor setup (npm install just works)
- better cross-platform consistency
- simpler polyglot support

---

# Technical Reality / Risks

## Tree-sitter is syntactic, not semantic

Tree-sitter understands structure:

Example:

```c
foo();
```

It sees:

```text
call_expression
identifier=foo
```

But does NOT know:

* what foo is
* where it is defined
* if it is a macro
* if it is a function pointer

---

## Preprocessor limitations

Tree-sitter parses directives:

```c
#ifdef DEBUG
foo();
#endif
```

It sees:

```text
preproc_ifdef
call_expression
```

But cannot evaluate:

* DEBUG defined?
* active branch?
* macro expansion?

Clang can.

Tree-sitter cannot.

---

## C macro ambiguity

Example:

```c
#define CALL(x) x()
CALL(foo)
```

Tree-sitter sees syntax.

Clang sees real semantics.

---

# Success Criteria

Feature is successful if:

* non-TS repos stop relying on plain text chunking
* mixed-language repos work
* AST chunks improve context quality
* parser failures degrade gracefully
* TS behavior remains unchanged

---

# Architectural Positioning

This feature provides:

> broad structural understanding

NOT:

> semantic truth

Tree-sitter = structural fallback

Native tooling = future semantic authority

---

# Relation to Future Architecture

This feature is the first step toward language-specific context providers.

Future:

```ts
AstChunk
DependencyHint
Reference
Diagnostic
```

shared evidence contracts.

Example:

C provider:

* Tree-sitter chunks
* Clang references
* include dependencies

C# provider:

* Tree-sitter initially
* Roslyn later

Python:

* Tree-sitter chunks
* Pyright dependencies

This allows incremental polyglot support without full IDE-level implementations.
