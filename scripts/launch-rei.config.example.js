// ─── REI Launcher — config template ──────────────────────────────────────────
// Copy this file to launch-rei.config.js and edit with your own paths/models.
// launch-rei.config.js is git-ignored.

export const PROJECTS = [
    // Add your workspace paths here
    // 'C:\\dev\\MyProject',
    // '/Users/you/projects/my-app',
];

export const PROVIDER_MODELS = {
    omlx: [
        'Qwen3.8-27B-MLX-4bit',
        'Ornith-1.5-35B-A3B-MLX-4bit',
        'gemma-4-26B-A4B-it-QAT-MLX-4bit',
    ],
    // Any other OpenAI-compatible server (vLLM, SGLang, llama.cpp, LiteLLM): the wizard probes
    // /v1/models, so leaving this empty is fine — the live list is what you pick from.
    'openai-compat': [],
    ollama: [
        'llama3.2:1b',
        'llama3.2',
        'qwen2.5-coder:3b',
    ],
    groq: [
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
    ],
    openrouter: [
        'meta-llama/llama-3.3-70b-instruct:free',
        'deepseek/deepseek-r1:free',
        'openai/gpt-4o-mini',
    ],
    gemini: [
        'gemini-2.5-flash',
    ],
    huggingface: [
        'Qwen/Qwen2.5-Coder-32B-Instruct',
    ],
    lmstudio: [],
    mtplx: [],
};
