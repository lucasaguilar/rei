# Semantic RAG Architecture

REI leverages a 100% local, privacy-first Retrieval-Augmented Generation (RAG) system to build a deep, semantic context of your codebase. This avoids relying solely on basic keyword matching and ensures that the agent understands the structural and semantic relationships within your project.

## 1. Local Embeddings (`@xenova/transformers`)

Instead of sending your proprietary code to external APIs (like OpenAI or Cohere) for embedding generation, REI does it locally.
- Uses `@xenova/transformers` to run the highly optimized `Xenova/all-MiniLM-L6-v2` ONNX model directly in Node.js.
- Generates 384-dimensional floating-point vectors for code nodes.
- Execution happens completely offline, in-memory, keeping your IP safe behind your firewall.

## 2. Advanced Chunking Strategies

Slicing raw code by arbitrary character counts often breaks functions or classes in half, leading to fragmented context and poor retrieval. REI solves this by using a dual-chunking strategy:

### A. AST Chunking (`ts-morph`)
For TypeScript and JavaScript files, REI uses `ts-morph` to parse the Abstract Syntax Tree (AST).
- Extracts intact, whole logical nodes: **Functions**, **Classes**, **Interfaces**, and **Variable Statements**.
- Each semantic node becomes an independent vector. This ensures that when you search for a specific behavior, the exact, complete function block is retrieved and injected into the prompt.

### B. Structural Chunking (Repo Skeleton Map)
REI parses the `.rei/logs/repo-skeleton-map.txt` file to understand the overall repository architecture.
- Extracts file summaries and, crucially, **Imports/Dependencies** for every file.
- This creates "structural chunks" that map how files connect to one another across the workspace.

## 3. Isolated Vector Store

Vectors and metadata are stored in a highly optimized, flat-file JSON database located at `.rei/rag-index.json`.
- Designed for rapid I/O and isolated entirely within your workspace directory.
- Runs lightning-fast cosine similarity searches.
- For typical repositories (< 10,000 nodes), this in-memory V8 array iteration is immensely fast and avoids the overhead of running a separate vector database process.

## 4. Multi-Level Relevance Retrieval

When you ask a question or request an edit, REI retrieves context using a multi-step algorithm:

1. **Semantic Similarity (Cosine Distance)**: The user's query is converted to a vector and compared against all AST and Structural chunks in the index.
2. **Adjacency Boost**: If a file scores highly (e.g., > 0.8 cosine similarity), REI automatically boosts the scores of its *dependencies* (its imports) by `+0.15`. This ensures that technically related files are pulled into context even if they don't explicitly contain the keywords from the user's prompt.
3. **Hierarchical Injection**: 
   - **Top Results** (Score > 0.85): Injected completely.
   - **Secondary Results** (Score > 0.60): Injected as structural skeletons (File path + Imports only) to provide architectural hints to the model without blowing up the context window limit.
