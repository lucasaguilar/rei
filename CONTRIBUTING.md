# Contributing to REI

First off, thank you for considering contributing to REI! 

REI is built with a specific philosophy: to be an extremely strict, compiler-aware, privacy-first AI agent. We believe in providing real architectural context (AST and Caller Graphs) rather than just feeding raw files to an LLM.

## Where we need help the most

Currently, REI is heavily optimized for the **TypeScript / JavaScript ecosystem** (using `ts-morph` and `tsc`). 

**The biggest priority for the community right now is adding `Tree-sitter` integration.**
We want REI to be universally capable across multiple languages (Python, Go, Rust, Java, etc.) with the same level of AST-driven strictness. If you have experience with Tree-sitter bindings for Node.js, your PRs are highly welcomed!

## How to Contribute

1. **Fork the repository**
2. **Create a new branch** (`git checkout -b feature/amazing-feature`)
3. **Run the tests** before committing to make sure nothing is broken (`npm run check` and `npm run test`)
4. **Commit your changes** with descriptive commit messages.
5. **Push to the branch** (`git push origin feature/amazing-feature`)
6. **Open a Pull Request** against the `master` branch.

## Setting up your local environment

```bash
# Install dependencies
npm install

# Run the TypeScript checker
npm run check

# Run tests
npm run test
```

## Pull Request Guidelines

- Ensure your code adheres to the existing architectural philosophy (No guessing, rely on static analysis where possible).
- Please include tests if you are adding new context selectors, regex rules, or AST parsers.
- Update the `README.md` if your PR introduces a change in user-facing CLI behavior.

Thank you for helping make REI the most robust CLI coding agent available!
