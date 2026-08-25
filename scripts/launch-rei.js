import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { select, text, password, confirm, note, intro, isCancel, cancel } from '@clack/prompts';
import { fileURLToPath, pathToFileURL } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

let PROJECTS = [];
let PROVIDER_MODELS = {};
let PROVIDERS = [];
const CUSTOM = '[ enter custom model... ]';

// ─── Provider taxonomy & onboarding metadata ────────────────────────────────
// Cloud providers authenticate with an API key; local providers expose an
// OpenAI-compatible endpoint we can probe for models (the probe IS the validation).
const CLOUD_PROVIDERS = ['openrouter', 'gemini', 'groq', 'huggingface'];
const LOCAL_PROVIDERS = ['ollama', 'llmstudio', 'mtplx'];

// Env var that holds each cloud provider's API key (HF uses HF_TOKEN, not HF_API_KEY).
const API_KEY_VAR = {
    openrouter: 'OPENROUTER_API_KEY',
    gemini: 'GEMINI_API_KEY',
    groq: 'GROQ_API_KEY',
    huggingface: 'HF_TOKEN',
};
const API_KEY_URL = {
    openrouter: 'https://openrouter.ai/keys',
    gemini: 'https://aistudio.google.com/app/apikey',
    groq: 'https://console.groq.com/keys',
    huggingface: 'https://huggingface.co/settings/tokens',
};

// Default endpoint prefilled when configuring a local provider (host + port).
const LOCAL_DEFAULT_URL = {
    ollama: 'http://127.0.0.1:11434',
    llmstudio: 'http://127.0.0.1:1234/v1',
    mtplx: 'http://127.0.0.1:8000/v1',
};
// Concrete "how to get it running" hint shown when a local server can't be reached.
const LOCAL_HINT = {
    ollama: 'Ollama: install from https://ollama.com, then `ollama serve` and `ollama pull <model>`.',
    llmstudio: 'LM Studio: open the app → Developer tab → Start Server (default http://localhost:1234).',
    mtplx: 'MTPLX: start the server (e.g. :8000) — set the URL + API key when prompted above.',
};

// Curated last-resort model lists — used ONLY when the live server/list is unreachable.
// Kept minimal (they age fast); [custom] always lets the user type anything else.
const KNOWN_MODELS = {
    ollama: ['qwen3.8:27b-mlx', 'qwen3.6:35b-a3b-coding-nvfp4', 'llama3.2'],
    llmstudio: ['ornith-1.5-35b-a3b-mlx', 'qwen/qwen3.6-27b', 'qwen/qwen3-vl-4b'],
    mtplx: ['mtplx-qwen38-27b-optimized-speed'],
    openrouter: ['qwen/qwen3.6-plus', 'deepseek/deepseek-r1', 'openai/gpt-4o-mini', 'auto'],
    gemini: ['gemini-2.5-flash', 'gemini-2.5-pro'],
    groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant'],
    huggingface: ['Qwen/Qwen2.5-Coder-32B-Instruct'],
};

// A value is a "placeholder" (as-if-unset) if empty or matches the .env.example stubs
// the bash wrapper already filters (your_..._here / placeholder).
const isPlaceholder = (v) => !v || /_here$|^your_|placeholder/i.test(String(v).trim());

/** User's own curated list (launch-rei.config.js) if non-empty, else the built-in KNOWN_MODELS. */
function knownFallback(provider) {
    const own = PROVIDER_MODELS[provider];
    if (Array.isArray(own) && own.length > 0) return own;
    return KNOWN_MODELS[provider] ?? [];
}

/** Accepts "host:port", "http://host:port", with or without a trailing /v1. Normalizes to a
 *  scheme-qualified base WITHOUT a trailing /v1 (callers append /v1/models). */
function normalizeEndpoint(input) {
    let url = String(input || '').trim();
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    return url.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

/** The BASE_URL form each provider's runtime client expects to be STORED (env var).
 *  ollama stores the ROOT (its client appends `/v1` itself); llmstudio/mtplx clients append
 *  `/chat/completions` directly to the base, so their BASE_URL must END in `/v1`. `normalized` is a
 *  scheme-qualified base WITHOUT `/v1` (as produced by normalizeEndpoint). */
function providerBaseUrl(provider, normalized) {
    return provider === 'ollama' ? normalized : `${normalized}/v1`;
}

/** Probes an OpenAI-compatible /v1/models endpoint. Returns { models, reachable, status }.
 *  `reachable:false` distinguishes "server down / bad URL" from "auth failed" (status 401/403). */
/** model id (lowercased) → context length the server reported during the probe, when it exposes one.
 *  Populated by probeModels and read by defaultTuning, so a fresh config starts with the REAL window
 *  instead of a guess. Module-level because the wizard is one short-lived run. */
const PROBED_CONTEXT = new Map();

/** Fallback window when the server doesn't publish one. 32768 was too tight: REI sends the agent's
 *  context untrimmed, and a cramped window is what broke tool-calling before (it looked like a bad
 *  quantization until the window turned out to be the cause). Every local model REI targets today
 *  handles 64k. It must NOT exceed what the server actually loaded — the note at Step 7 says so. */
const DEFAULT_LOCAL_CONTEXT = 65536;

async function probeModels(baseUrl, apiKey) {
    const base = normalizeEndpoint(baseUrl);
    if (!base) return { models: [], reachable: false, status: 0 };
    try {
        const res = await fetch(`${base}/v1/models`, {
            headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
            signal: AbortSignal.timeout(4000),
        });
        if (!res.ok) return { models: [], reachable: true, status: res.status };
        const data = await res.json();
        const models = (data.data || []).map(m => {
            // Some servers (MTPLX, vLLM) publish the loaded context length here; LM Studio and
            // Ollama do not. When it's there it beats any guess — it's what's ACTUALLY loaded.
            const ctx = Number(m.context_length ?? m.max_context_length ?? m.max_model_len);
            if (m.id && Number.isFinite(ctx) && ctx > 0) {
                PROBED_CONTEXT.set(String(m.id).trim().toLowerCase(), ctx);
            }
            return m.id;
        }).filter(Boolean);
        return { models, reachable: true, status: 200 };
    } catch {
        return { models: [], reachable: false, status: 0 };
    }
}

/** Upserts KEY=value into dotenv-style text. Replaces an existing ACTIVE line (all occurrences, so
 *  stale duplicates can't linger) or appends. Idempotent: re-running with the same values is a no-op.
 *  Uses a replacement FUNCTION so a `$` in the value is never interpreted as a regex backreference
 *  (critical — API keys / tokens can contain `$`). Commented `# KEY=` lines are left untouched. */
function upsertEnvLine(content, key, value) {
    const line = `${key}=${value}`;
    if (!new RegExp(`^${key}=.*$`, 'm').test(content)) {
        return `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`;
    }
    // Replace the first active occurrence in place; drop any later duplicates so no stale value lingers.
    let done = false;
    return content.replace(new RegExp(`^${key}=.*(\\r?\\n|$)`, 'mg'), (_m, nl) => {
        if (done) return '';
        done = true;
        return line + (nl || '\n');
    });
}

/** Applies every envVars entry to dotenv text (skips undefined). Non-destructive: any line the
 *  wizard didn't set — other vars, comments, blank lines — is preserved exactly. */
function applyEnvVars(content, envVars) {
    let out = content;
    for (const [key, value] of Object.entries(envVars)) {
        if (value === undefined) continue;
        out = upsertEnvLine(out, key, value);
    }
    return out;
}

/** Writes/updates a single key in the GLOBAL ~/.rei/.env (secrets + machine-level endpoints
 *  live here so they're reused across every workspace; the wrapper loads it before the repo .env). */
function writeGlobalEnv(key, value) {
    const dir = path.join(os.homedir(), '.rei');
    const file = path.join(dir, '.env');
    try {
        fs.mkdirSync(dir, { recursive: true });
        const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        fs.writeFileSync(file, upsertEnvLine(content, key, value).trimEnd() + '\n', 'utf8');
        return true;
    } catch (err) {
        console.error(`⚠️  Could not save ${key} to ~/.rei/.env:`, err.message);
        return false;
    }
}

/**
 * Persists an env var to ALL the places that matter, so a wizard change actually takes effect:
 *   1. process.env      — live for this run (probes, preflight, the spawned session).
 *   2. envVars          — written to the PROJECT .env at Step 7. THIS is the file that WINS
 *                         (load-env.ts loads the workspace .env with override:true), so without
 *                         it a new endpoint/key is silently shadowed by the project's old value.
 *   3. ~/.rei/.env      — global fallback reused by fresh workspaces that have no project value.
 */
function persistEnv(envVars, key, value) {
    process.env[key] = value;
    if (envVars) envVars[key] = value;
    writeGlobalEnv(key, value);
}

async function loadConfiguration() {
    const configPath = path.join(__dirname, 'launch-rei.config.js');
    if (!fs.existsSync(configPath)) {
        const examplePath = path.join(__dirname, 'launch-rei.config.example.js');
        if (fs.existsSync(examplePath)) {
            try {
                fs.copyFileSync(examplePath, configPath);
            } catch (err) {}
        } else {
            try {
                fs.writeFileSync(configPath, `
export const PROJECTS = [];
export const PROVIDER_MODELS = {
    ollama: ['llama3.2', 'qwen2.5-coder:14b'],
    openrouter: ['qwen/qwen3.6-plus', 'deepseek/deepseek-r1:free'],
    gemini: ['gemini-2.5-flash']
};
                `);
            } catch (err) {}
        }
    }

    try {
        const config = await import('./launch-rei.config.js');
        PROJECTS = config.PROJECTS || [];
        PROVIDER_MODELS = config.PROVIDER_MODELS || {};
    } catch (err) {
        PROJECTS = [];
        PROVIDER_MODELS = {
            ollama: ['llama3.2', 'qwen2.5-coder:14b'],
            openrouter: ['qwen/qwen3.6-plus'],
            gemini: ['gemini-2.5-flash'],
            llmstudio: [],
            mtplx: []
        };
    }

    const cwd = process.cwd();
    if (!PROJECTS.includes(cwd)) {
        PROJECTS.unshift(cwd);
    }

    const envWorkspace = process.env.REI_WORKSPACE_PATH;
    if (envWorkspace && !PROJECTS.includes(envWorkspace)) {
        PROJECTS.unshift(envWorkspace);
    }

    PROVIDERS = Object.keys(PROVIDER_MODELS);
}

const OLLAMA_PERF_VARS = [
    'OLLAMA_FLASH_ATTENTION',
    'OLLAMA_KV_CACHE_TYPE',
    'OLLAMA_KEEP_ALIVE',
    'OLLAMA_NUM_THREADS',
    // Unified budget (replaces OLLAMA_NUM_CTX / OLLAMA_NUM_PREDICT in the summary).
    'REI_CONTEXT_WINDOW',
    'REI_MAX_OUTPUT_TOKENS',
];

// ─── Persisted last-selection ─────────────────────────────────────────────────

const CONFIG_FILE = path.join(ROOT, '.rei', 'last-config.json');

function loadLast() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function saveLast(data) {
    try {
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
    } catch {
        // Non-fatal
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Builds a display summary of Ollama performance env vars.
 * Shows which are set (from system env or wizard) and which aren't.
 */
function buildOllamaSummary(envVars) {
    return OLLAMA_PERF_VARS.map(key => {
        const wizardVal = envVars[key];
        const sysVal    = process.env[key];
        if (wizardVal) {
            const note = sysVal && sysVal !== wizardVal ? `  (sys: ${sysVal})` : '';
            return `✓  ${key.padEnd(24)} ${wizardVal}${note}`;
        }
        if (sysVal) return `✓  ${key.padEnd(24)} ${sysVal}`;
        return         `✗  ${key.padEnd(24)} not set`;
    }).join('\n');
}

function getEnvPrefix(provider) {
    if (provider === 'llmstudio') return 'LLM_STUDIO';
    if (provider === 'huggingface') return 'HF';
    if (provider === 'mtplx') return 'MTPLX';
    return provider.toUpperCase();
}

/** Decorates a provider option so the user sees, at a glance, what each choice needs. */
function providerLabel(p) {
    if (CLOUD_PROVIDERS.includes(p)) {
        const hasKey = !isPlaceholder(process.env[API_KEY_VAR[p]]);
        return `${p}  ${hasKey ? '✓ key set' : '☁ cloud · needs API key'}`;
    }
    if (LOCAL_PROVIDERS.includes(p)) return `${p}  ⌂ local server`;
    return p;
}

async function pickProvider(message, initialValue) {
    const provider = await select({
        message,
        options: PROVIDERS.map(p => ({ value: p, label: providerLabel(p) })),
        initialValue,
    });
    if (isCancel(provider)) { cancel('Cancelled'); process.exit(0); }
    return provider;
}

/**
 * LOCAL endpoint-first setup: ask URL + API key, probe /v1/models, and treat a successful
 * listing AS the validation. Persists <PREFIX>_BASE_URL + key to the global ~/.rei/.env so every
 * workspace reuses this machine's backend. Returns { models } (live if reached, else []).
 * Retries on connection/auth failure; the caller falls back to known models + custom.
 */
async function configureLocalEndpoint(provider, envVars) {
    const prefix = getEnvPrefix(provider);
    let url = process.env[`${prefix}_BASE_URL`] || LOCAL_DEFAULT_URL[provider] || '';
    let key = process.env[`${prefix}_API_KEY`] || '';

    while (true) {
        const urlIn = await text({
            message: `${provider} endpoint (host:port or full URL):`,
            initialValue: url,
            validate: v => v.trim().length === 0 ? 'Endpoint cannot be empty' : undefined,
        });
        if (isCancel(urlIn)) { cancel('Cancelled'); process.exit(0); }
        url = normalizeEndpoint(urlIn);

        const keyIn = await password({ message: `${provider} API key (blank if the server needs none):` });
        if (isCancel(keyIn)) { cancel('Cancelled'); process.exit(0); }
        key = (keyIn || '').trim();

        const r = await probeModels(url, key);
        // Store in the form the runtime client expects (with /v1 for mtplx/llmstudio), NOT the
        // probe form. Storing the bare host caused the provider to POST to /chat/completions → 404.
        const storedUrl = providerBaseUrl(provider, url);
        if (r.reachable && r.status === 200 && r.models.length > 0) {
            note(`✓ Connected — ${r.models.length} model(s) found at ${url}`, `${provider} ready`);
            // Write to the PROJECT .env (wins) + global (reused). Without the project write the
            // new endpoint is shadowed by the project's existing value → wizard change has no effect.
            persistEnv(envVars, `${prefix}_BASE_URL`, storedUrl);
            if (key) persistEnv(envVars, `${prefix}_API_KEY`, key);
            return { models: r.models };
        }

        const reason = !r.reachable
            ? `Could not reach ${url} (server down, wrong host/port, or timeout).`
            : r.status === 401 || r.status === 403
                ? `Auth failed (HTTP ${r.status}) — the API key looks wrong.`
                : `Server responded (HTTP ${r.status}) but listed no models.`;
        const retry = await confirm({ message: `${reason}\nRetry with a different URL/key?`, initialValue: true });
        if (isCancel(retry)) { cancel('Cancelled'); process.exit(0); }
        if (!retry) {
            note(LOCAL_HINT[provider] ?? '', 'Tip');
            // Still save what was entered (project + global) so a later manual fix has a starting point.
            if (url) persistEnv(envVars, `${prefix}_BASE_URL`, storedUrl);
            if (key) persistEnv(envVars, `${prefix}_API_KEY`, key);
            return { models: [] };
        }
    }
}

/** CLOUD: ensure the provider's API key exists (prompt masked, save to project .env + global). */
async function ensureCloudApiKey(provider, envVars) {
    if (!CLOUD_PROVIDERS.includes(provider)) return;
    const keyVar = API_KEY_VAR[provider];
    if (!isPlaceholder(process.env[keyVar])) return; // already have a real key
    const entered = await password({ message: `${keyVar} for ${provider} (get one at ${API_KEY_URL[provider]}):` });
    if (isCancel(entered)) { cancel('Cancelled'); process.exit(0); }
    const val = (entered || '').trim();
    if (!val) {
        note(`⚠️  No key entered — ${provider} calls will fail until you set ${keyVar}`, 'Missing API key');
        return;
    }
    persistEnv(envVars, keyVar, val);
    note(`Saved ${keyVar} to this project's .env (+ ~/.rei/.env for other workspaces).`, 'API key saved');
}

/**
 * Model picker. For local providers pass `preFetched` (the live list from configureLocalEndpoint)
 * to avoid re-probing. Falls back to curated known models + a free-text custom entry.
 */
async function pickModel(provider, message, initialModel, preFetched) {
    const live = Array.isArray(preFetched) ? preFetched : [];
    const baseList = live.length ? live : knownFallback(provider);
    if (!live.length && LOCAL_PROVIDERS.includes(provider)) {
        note(`Showing known models — you can also type one.\n${LOCAL_HINT[provider] ?? ''}`, `${provider} (not connected)`);
    }
    const choices = [...baseList, CUSTOM];
    const choice = await select({
        message,
        options: choices.map(m => ({ value: m, label: m })),
        initialValue: choices.includes(initialModel) ? initialModel : choices[0],
    });
    if (isCancel(choice)) { cancel('Cancelled'); process.exit(0); }
    if (choice !== CUSTOM) return choice;

    const custom = await text({
        message: 'Enter model name:',
        validate: v => v.trim().length === 0 ? 'Model name cannot be empty' : undefined,
    });
    if (isCancel(custom)) { cancel('Cancelled'); process.exit(0); }
    return custom.trim();
}

/** Family-aware default sampling for a local model — a sane starting point the user can calibrate. */
function defaultTuning(modelId) {
    const n = modelId.trim().toLowerCase();
    // Anti-loop ON by default. Decoding with every penalty at zero is the #1 cause of repetition
    // loops on local models — the same reason resolveAgentSampling() defaults to 0.3/0.3 instead of
    // greedy (src/config/model-runtime.ts). Writing 0.0 here would OVERRIDE that global protection
    // back off, because a per-model value always wins. No repetition_penalty on top: stacking the
    // multiplicative penalty with presence/frequency tends to degrade the output.
    const base = {
        id: modelId,
        contextWindow: PROBED_CONTEXT.get(n) || DEFAULT_LOCAL_CONTEXT,
        maxTokens: 16384,
        temperature: 0.6, topP: 0.9, topK: 40,
        presencePenalty: 0.3, frequencyPenalty: 0.3, minP: 0.02,
    };
    // Qwen publishes its own sampling recipe (temp 0.6 / topP 0.95 / topK 20) and recommends a
    // presence_penalty between 0 and 2 when a quantized build falls into endless repetitions.
    if (n.includes('qwen'))    return { ...base, temperature: 0.6, topP: 0.95, topK: 20, presencePenalty: 1.0 };
    if (n.includes('deepseek'))return { ...base, temperature: 0.6, topP: 0.95, topK: 40 };
    if (n.includes('gemma'))   return { ...base, temperature: 0.7, topP: 0.95, topK: 64 };
    return base;
}

/** Mirror of `normalize()` in src/config/model-tuning.ts — lowercase, drop the org prefix
 *  ("orcarouter/…") and a trailing "-thinking". This script is plain JS that ships standalone
 *  (~/.rei/scripts), so it cannot import the TS source; parity is pinned by a test instead
 *  (src/config/wizard-matching-parity.test.ts). Change one side and that test fails. */
function normalizeModelId(modelId) {
    return String(modelId || '').toLowerCase().replace(/^.*\//, '').replace(/-thinking$/, '');
}

/** Same predicate `matchModel()` uses at runtime: exact full id first, then normalized. The two
 *  MUST agree — when the wizard's check was stricter (exact only), selecting a model the server
 *  reports with an org prefix ("orcarouter/qwen3.8-27b-mlx@4bit") did not recognize a hand-tuned
 *  entry stored under the short id, so it appended a DUPLICATE with default sampling. That duplicate
 *  then won at runtime (matchModel tries the exact id first), silently reverting the user's tuning. */
function isModelTuned(models, model) {
    const target = String(model || '').trim().toLowerCase();
    if (models.some(m => String(m.id || '').trim().toLowerCase() === target)) return true;
    const norm = normalizeModelId(target);
    if (!norm) return false;
    return models.some(m => {
        const id = normalizeModelId(m.id);
        return id.length > 0 && id === norm;
    });
}

/**
 * Pure merge: returns { cfg, added } where cfg has a default-tuning block for each (provider, model)
 * pair not already tuned. Preserves every existing entry AND every other top-level key (mcpServers, …)
 * — nothing is dropped or reordered destructively. Idempotent: re-running with already-tuned models
 * yields added === 0 and a structurally-equal cfg.
 */
function mergeReiConfig(cfg, pairs) {
    const next = { ...cfg, providers: { ...(cfg.providers || {}) } };
    let added = 0;
    for (const { provider, model } of pairs) {
        const existing = next.providers[provider] || {};
        const models = Array.isArray(existing.models) ? existing.models.slice() : [];
        if (!isModelTuned(models, model)) { models.push(defaultTuning(model)); added++; }
        next.providers[provider] = { ...existing, models };
    }
    return { cfg: next, added };
}

/**
 * Ensures rei.config.json (in the workspace) has a tuning block for each selected LOCAL model.
 * Non-destructive (see mergeReiConfig). Only rewrites the file when something was actually added,
 * so a re-run over an already-configured repo leaves it byte-for-byte untouched.
 */
function ensureReiConfig(projectPath, localModels) {
    const pairs = localModels.filter(m => m && m.model && LOCAL_PROVIDERS.includes(m.provider));
    if (pairs.length === 0) return;

    const file = path.join(projectPath, 'rei.config.json');
    let cfg = {};
    if (fs.existsSync(file)) {
        try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch { note('rei.config.json exists but is not valid JSON — leaving it untouched.', 'Skipped tuning'); return; }
    }
    const { cfg: merged, added } = mergeReiConfig(cfg, pairs);
    if (added > 0) {
        try {
            fs.writeFileSync(file, JSON.stringify(merged, null, 2) + '\n', 'utf8');
            note(
                `Added default tuning for ${added} local model(s) → ${file}\n` +
                `Context defaults to what the server reported, else ${DEFAULT_LOCAL_CONTEXT}. Make sure your\n` +
                `model is LOADED with at least that window, or lower contextWindow there.`,
                'rei.config.json',
            );
        } catch (err) {
            console.error('⚠️  Could not write rei.config.json:', err.message);
        }
    }
}

/**
 * Fast startup gate (invoked as `launch-rei.js --preflight`). Decides whether the ALREADY-resolved
 * env (global ~/.rei/.env + repo .env) can actually run here — the file's mere existence is not
 * enough. Checks provider + model + (cloud: API key | local: server reachable). If only a cloud key
 * is missing it prompts for JUST that key (saved to ~/.rei/.env) and passes. Returns { ok, reason }.
 * ok → wrapper launches chat/server; not ok → wrapper drops into the full wizard.
 */
async function runPreflight() {
    const provider = process.env.MODEL_PROVIDER;
    if (!provider) return { ok: false, reason: 'no MODEL_PROVIDER set' };
    if (provider === 'mock') return { ok: true };
    if (!CLOUD_PROVIDERS.includes(provider) && !LOCAL_PROVIDERS.includes(provider)) {
        return { ok: false, reason: `unknown MODEL_PROVIDER "${provider}"` };
    }

    const prefix = getEnvPrefix(provider);
    const model = process.env[`${prefix}_MODEL`] || process.env[`${prefix}_MODEL_AGENT`];
    if (!model) return { ok: false, reason: `no ${prefix}_MODEL set for provider "${provider}"` };

    // Cloud: the only hard requirement is a real API key. Prompt for just that if missing.
    if (CLOUD_PROVIDERS.includes(provider)) {
        const keyVar = API_KEY_VAR[provider];
        if (isPlaceholder(process.env[keyVar])) {
            note(`${provider} needs an API key to run.`, 'One more thing');
            await ensureCloudApiKey(provider);
        }
        return isPlaceholder(process.env[keyVar])
            ? { ok: false, reason: `missing ${keyVar}` }
            : { ok: true };
    }

    // Local: probe the endpoint (the reachability check the user asked for).
    if (provider === 'ollama' && !process.env.OLLAMA_BASE_URL) {
        const r = await probeModels(LOCAL_DEFAULT_URL.ollama, undefined);
        if (r.reachable) return { ok: true };
        try { execSync('ollama list', { timeout: 3000, stdio: 'ignore' }); return { ok: true }; }
        catch { return { ok: false, reason: 'Ollama server not reachable (start it with `ollama serve`)' }; }
    }
    const baseUrl = process.env[`${prefix}_BASE_URL`] || LOCAL_DEFAULT_URL[provider];
    const r = await probeModels(baseUrl, process.env[`${prefix}_API_KEY`]);
    if (r.reachable && r.status === 200) return { ok: true };
    return {
        ok: false,
        reason: r.reachable
            ? `${provider} server at ${baseUrl} returned HTTP ${r.status}`
            : `cannot reach ${provider} server at ${baseUrl}`,
    };
}

/** Runs the credential/endpoint setup for a provider; returns its live model list ([] for cloud).
 *  Writes the resolved endpoint/key into `envVars` (→ project .env) so the wizard's choice wins. */
async function prepareProvider(provider, envVars) {
    if (CLOUD_PROVIDERS.includes(provider)) { await ensureCloudApiKey(provider, envVars); return { models: [] }; }
    if (LOCAL_PROVIDERS.includes(provider)) return configureLocalEndpoint(provider, envVars);
    return { models: [] }; // mock / unknown — nothing to set up
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const last = loadLast();
    const initialWorkspace = process.cwd();

    intro('REI Launcher');

    note(
        'REI needs one model provider:\n' +
        '  ☁ Cloud (openrouter/gemini/groq/huggingface) — asks for an API key, works instantly.\n' +
        '  ⌂ Local (ollama/llmstudio/mtplx) — free & private; you give the endpoint and we list its models.',
        'Choose your path',
    );

    // ── Step 1: workspace ──────────────────────────────────────────────────
    let project;
    while (true) {
        const selected = await select({
            message: 'Workspace:',
            options: PROJECTS.map(p => ({ value: p, label: p })),
            initialValue: initialWorkspace,
        });
        if (isCancel(selected)) { cancel('Cancelled'); process.exit(0); }

        const resolved = path.isAbsolute(selected) ? selected : path.resolve(ROOT, selected);
        if (fs.existsSync(resolved)) { project = selected; break; }
        console.log(`\n❌ Path does not exist: ${resolved}\nPlease select a valid workspace.\n`);
    }

    const projectPath = path.isAbsolute(project) ? project : path.resolve(ROOT, project);

    // ── Step 2: launch mode ────────────────────────────────────────────────
    const launchMode = await select({
        message: 'Launch mode:',
        options: [
            { value: 'cli',    label: 'Terminal CLI  (rei chat)' },
            { value: 'server', label: 'Server         (HTTP + IDE integration)' },
        ],
        initialValue: last.launchMode ?? 'cli',
    });
    if (isCancel(launchMode)) { cancel('Cancelled'); process.exit(0); }

    // Server mode binds its own HTTP port (separate from the model endpoint). Ask for it here so
    // the setup is complete for server launches too; harmless/unused for the CLI.
    let serverPort;
    if (launchMode === 'server') {
        const portIn = await text({
            message: 'REI_SERVER_PORT (HTTP port for the REI server):',
            initialValue: process.env.REI_SERVER_PORT || last.serverPort || '3000',
            validate: v => (/^\d+$/.test(v.trim()) && +v > 0 && +v < 65536) ? undefined : 'Enter a port between 1 and 65535',
        });
        if (isCancel(portIn)) { cancel('Cancelled'); process.exit(0); }
        serverPort = portIn.trim();
    }

    // ── Step 3: provider setup ─────────────────────────────────────────────
    const providerSetup = await select({
        message: 'Provider setup:',
        options: [
            { value: 'single', label: 'Single provider  (all modes use the same provider)' },
            { value: 'multi',  label: 'Multi-provider   (separate model for agent mode)' },
        ],
        initialValue: last.providerSetup ?? 'single',
    });
    if (isCancel(providerSetup)) { cancel('Cancelled'); process.exit(0); }

    // ── Step 4: model selection ────────────────────────────────────────────
    const envVars = {};
    const config = { project, launchMode, providerSetup };
    // (provider, model) pairs chosen — used to seed rei.config.json tuning for local models.
    const selectedModels = [];

    if (providerSetup === 'single') {
        const provider = await pickProvider('Provider:', last.provider);
        // Cloud → prompt API key; local → prompt endpoint + key and probe for models.
        const { models: liveModels } = await prepareProvider(provider, envVars);
        const model = await pickModel(provider, 'Model:', last.provider === provider ? last.model : undefined, liveModels);
        selectedModels.push({ provider, model });

        Object.assign(config, { provider, model });
        envVars.MODEL_PROVIDER = provider;
        const prefix = getEnvPrefix(provider);
        envVars[`${prefix}_MODEL`] = model;
        // Explicitly clear AGENT_MODEL_PROVIDER to prevent .env bleed-through in single provider mode
        envVars.AGENT_MODEL_PROVIDER = '';

        // Uniform across providers: <PREFIX>_MODEL (set above) covers ask + planning AND
        // agent (agent falls back to it). Optionally pick a different/heavier agent model
        // on the same provider — written to <PREFIX>_MODEL_AGENT.
        const perMode = await confirm({
            message: 'Use a different model for agent mode (vs ask/planning)?',
            initialValue: last.singlePerMode ?? false,
        });
        if (isCancel(perMode)) { cancel('Cancelled'); process.exit(0); }

        if (perMode) {
            note('ask + planning use the model selected above.\nagent will use this second model.', 'Per-mode models');
            // Same provider → endpoint already configured; reuse the live list (no re-probe).
            const agentModel = await pickModel(provider, 'Model for agent:', last.singleAgentModel ?? model, liveModels);
            envVars[`${prefix}_MODEL_AGENT`] = agentModel;
            selectedModels.push({ provider, model: agentModel });
            Object.assign(config, { singlePerMode: true, singleAgentModel: agentModel });
        } else {
            // No dedicated agent model: write the SAME model (never an empty string — an
            // empty <PREFIX>_MODEL_AGENT would be sent as a blank model name → 400). This
            // also overwrites any stale value already in the .env.
            envVars[`${prefix}_MODEL_AGENT`] = model;
            Object.assign(config, { singlePerMode: false });
        }

    } else {
        // Multi-provider: ask/planning provider + agent provider
        note('Step 1 of 2: provider for ask and planning modes.', 'Multi-provider setup');
        const askProvider = await pickProvider('Provider (ask + planning):', last.askProvider);
        const { models: askLive } = await prepareProvider(askProvider, envVars);
        const askModel = await pickModel(askProvider, 'Model (ask + planning):', last.askProvider === askProvider ? last.askModel : undefined, askLive);
        selectedModels.push({ provider: askProvider, model: askModel });

        note('Step 2 of 2: provider for agent mode.', 'Multi-provider setup');
        const agentProvider = await pickProvider('Provider (agent):', last.agentProvider);
        // Reuse the ask probe if it's the same provider; otherwise set the agent provider up too.
        const { models: agentLive } = agentProvider === askProvider ? { models: askLive } : await prepareProvider(agentProvider, envVars);
        const agentModel = await pickModel(agentProvider, 'Model (agent):', last.agentProvider === agentProvider ? last.agentModel : undefined, agentLive);
        selectedModels.push({ provider: agentProvider, model: agentModel });

        Object.assign(config, { askProvider, askModel, agentProvider, agentModel });
        envVars.MODEL_PROVIDER = askProvider;

        const askPrefix = getEnvPrefix(askProvider);
        const agentPrefix = getEnvPrefix(agentProvider);

        // ask/planning → <askPrefix>_MODEL; agent → <agentPrefix>_MODEL_AGENT. Uniform
        // across providers, so ask/planning never inherit the agent model.
        envVars[`${askPrefix}_MODEL`]              = askModel;
        envVars.AGENT_MODEL_PROVIDER               = agentProvider;
        envVars[`${agentPrefix}_MODEL_AGENT`]      = agentModel;
    }

    // ── Step 5: Context & token budget (unified) ───────────────────────────
    // Writes the provider-agnostic REI_* names that src/config/model-runtime.ts
    // resolves. These take precedence over OLLAMA_NUM_CTX / LLM_STUDIO_MAX_TOKENS,
    // so the wizard must use them — otherwise a value it writes gets shadowed and
    // silently ignored. Prompted only for local providers (cloud models have large
    // fixed windows and rarely need REI's budget overrides).
    const usesOllama = envVars.MODEL_PROVIDER === 'ollama' || envVars.AGENT_MODEL_PROVIDER === 'ollama';
    const LOCAL_PROVIDERS = ['ollama', 'llmstudio', 'mtplx'];
    const usesLocal =
        LOCAL_PROVIDERS.includes(envVars.MODEL_PROVIDER) ||
        LOCAL_PROVIDERS.includes(envVars.AGENT_MODEL_PROVIDER);

    if (usesLocal) {
        // Context window (REI's history-trimming assumption). Single prompt; '0' = no trimming.
        // (Output cap isn't asked here — the per-model maxTokens in rei.config.json already covers it.)
        if (process.env.REI_CONTEXT_WINDOW !== undefined) {
            // Already set — carry through so the wizard never overwrites a deliberate choice.
            envVars.REI_CONTEXT_WINDOW = process.env.REI_CONTEXT_WINDOW;
        } else {
            const ctxValue = await select({
                message: 'REI_CONTEXT_WINDOW (history-trimming budget; 0 = model manages its own):',
                options: ['61440', '32768', '16384', '8192', '0'].map(v => ({ value: v, label: v === '0' ? '0 (no trimming)' : v })),
                initialValue: last.ctxWindow ?? '61440',   // proposed: 60 × 1024
            });
            if (isCancel(ctxValue)) { cancel('Cancelled'); process.exit(0); }
            envVars.REI_CONTEXT_WINDOW = ctxValue;
            Object.assign(config, { ctxWindow: ctxValue });
        }

        // On-demand file context: ask/planning are always light; the real toggle is AGENT.
        // Recommended ON for local/small windows (tools discover code instead of proactive dumps).
        if (process.env.REI_ON_DEMAND_FILE_CONTEXT_AGENT !== undefined) {
            envVars.REI_ON_DEMAND_FILE_CONTEXT_ASK = process.env.REI_ON_DEMAND_FILE_CONTEXT_ASK ?? '1';
            envVars.REI_ON_DEMAND_FILE_CONTEXT_PLANNING = process.env.REI_ON_DEMAND_FILE_CONTEXT_PLANNING ?? '1';
            envVars.REI_ON_DEMAND_FILE_CONTEXT_AGENT = process.env.REI_ON_DEMAND_FILE_CONTEXT_AGENT;
        } else {
            const onDemandAll = await confirm({
                message: 'On-demand file context for ALL modes incl. agent? (recommended for local/small windows)',
                initialValue: last.onDemandAll ?? true,
            });
            if (isCancel(onDemandAll)) { cancel('Cancelled'); process.exit(0); }
            envVars.REI_ON_DEMAND_FILE_CONTEXT_ASK = '1';
            envVars.REI_ON_DEMAND_FILE_CONTEXT_PLANNING = '1';
            envVars.REI_ON_DEMAND_FILE_CONTEXT_AGENT = onDemandAll ? '1' : '0';
            Object.assign(config, { onDemandAll });
        }

        // Reasoning effort per mode — local models think by default, so ask/planning over-think
        // (slow) unless capped. This is the OpenAI-standard knob LM Studio honors ("none" disables
        // thinking). One prompt selects a profile; unsupported backends ignore the param.
        const REASON_MODES = ['ASK', 'PLANNING', 'AGENT'];
        const reasoningAlreadySet = REASON_MODES.some(m => process.env[`REI_REASONING_EFFORT_${m}`] !== undefined);
        if (reasoningAlreadySet) {
            for (const m of REASON_MODES) {
                const v = process.env[`REI_REASONING_EFFORT_${m}`];
                if (v !== undefined) envVars[`REI_REASONING_EFFORT_${m}`] = v;
            }
        } else {
            const profile = await select({
                message: 'Reasoning effort (thinking) per mode:',
                options: [
                    { value: 'balanced', label: 'Balanced — ask/planning fast (none), agent reasons (medium)' },
                    { value: 'minimal',  label: 'Minimal — none everywhere (fastest, least deliberate)' },
                    { value: 'full',     label: 'Full — let the model decide (thinks in all modes)' },
                ],
                initialValue: last.reasoningProfile ?? 'balanced',
            });
            if (isCancel(profile)) { cancel('Cancelled'); process.exit(0); }
            // 'full' = leave unset so the request omits the field (model's own default).
            const effort = profile === 'balanced'
                ? { ASK: 'none', PLANNING: 'none', AGENT: 'medium' }
                : profile === 'minimal'
                    ? { ASK: 'none', PLANNING: 'none', AGENT: 'none' }
                    : null;
            if (effort) for (const [m, v] of Object.entries(effort)) envVars[`REI_REASONING_EFFORT_${m}`] = v;
            Object.assign(config, { reasoningProfile: profile });
        }
    }

    // ── Step 5b: agent behavior & telemetry (all providers) ────────────────
    // REI_MAX_TURNS — propose a higher cap than the built-in default (12 is too low for real
    // agent work). Carried through if already set in the env.
    if (process.env.REI_MAX_TURNS !== undefined) {
        envVars.REI_MAX_TURNS = process.env.REI_MAX_TURNS;
    } else {
        const turns = await text({
            message: 'REI_MAX_TURNS (agent tool-loop iterations per turn):',
            initialValue: last.maxTurns ?? '50',
            validate: v => (/^\d+$/.test(v.trim()) && +v > 0) ? undefined : 'Enter a positive integer',
        });
        if (isCancel(turns)) { cancel('Cancelled'); process.exit(0); }
        envVars.REI_MAX_TURNS = turns.trim();
        Object.assign(config, { maxTurns: turns.trim() });
    }

    // Telemetry (Laminar/LMNR) — proposed OFF unless you run a collector.
    if (process.env.REI_TELEMETRY_DISABLED !== undefined) {
        envVars.REI_TELEMETRY_DISABLED = process.env.REI_TELEMETRY_DISABLED;
    } else {
        const disableTel = await confirm({
            message: 'Disable telemetry (Laminar/LMNR)? (recommended unless you run a collector)',
            initialValue: last.telemetryDisabled ?? true,
        });
        if (isCancel(disableTel)) { cancel('Cancelled'); process.exit(0); }
        envVars.REI_TELEMETRY_DISABLED = disableTel ? 'true' : 'false';
        Object.assign(config, { telemetryDisabled: disableTel });
    }

    // ── Step 6: server env ─────────────────────────────────────────────────
    // Always set workspace path vars — used by server; harmless for CLI.
    envVars.REI_WORKSPACE_PATH  = projectPath;
    envVars.ALLOWED_WORKSPACES  = projectPath;
    if (serverPort) {
        envVars.REI_SERVER_PORT = serverPort;
        Object.assign(config, { serverPort });
    }

    // Seed rei.config.json with default tuning for any LOCAL model chosen (non-destructive).
    ensureReiConfig(projectPath, selectedModels);

    // ── Step 7: save + launch ──────────────────────────────────────────────
    saveLast(config);

    // Persist environment variables to the project's .env file
    try {
        const envFilePath = path.join(projectPath, '.env');
        let envContent = '';
        if (fs.existsSync(envFilePath)) {
            envContent = fs.readFileSync(envFilePath, 'utf8');
        } else {
            // If .env doesn't exist, load the fully-commented .env.example as a base template
            const exampleEnvPath = path.join(ROOT, '.env.example');
            if (fs.existsSync(exampleEnvPath)) {
                envContent = fs.readFileSync(exampleEnvPath, 'utf8');
            }
        }

        envContent = applyEnvVars(envContent, envVars);
        fs.writeFileSync(envFilePath, envContent.trim() + '\n', 'utf8');
        console.log(`📝 Persisted complete configuration template to: ${envFilePath}`);
    } catch (err) {
        console.error('⚠️ Could not save configuration to .env:', err.message);
    }

    // Show Ollama env summary so the user knows what's active before launch
    if (usesOllama) {
        note(buildOllamaSummary(envVars), 'Ollama environment');
    }

    const isServer    = launchMode === 'server';
    const modeLabel   = isServer ? 'server' : 'cli';
    const providerLabel = envVars.AGENT_MODEL_PROVIDER
        ? `${envVars.MODEL_PROVIDER} (ask/plan) + ${envVars.AGENT_MODEL_PROVIDER} (agent)`
        : envVars.MODEL_PROVIDER;

    console.log(`\nLaunching REI [${modeLabel}] [${providerLabel}] → ${project}\n`);

    const projectArg = projectPath.includes(' ') ? `"${projectPath}"` : projectPath;
    // Launch the COMPILED build (dist), not tsx/src: faster startup (no per-launch
    // TypeScript transpilation) and consistent with the plain `rei` command. Requires
    // `npm run build` (the installer does this). Devs editing source can switch back to
    // `npm run dev -- ...` / `npm run server:dev`.
    const cmd = isServer
        ? 'node dist/server.js'
        : `node dist/main.js --workspace ${projectArg} chat`;

    const child = spawn(cmd, {
        cwd: ROOT,
        env: { ...process.env, ...envVars },
        stdio: 'inherit',
        shell: true,
    });

    child.on('error', err => { console.error(`Failed to launch REI: ${err.message}`); process.exit(1); });
    child.on('close', code => { if (code !== 0) console.log(`REI exited with code ${code}`); });
}

async function start() {
    // Preflight mode: called by the `rei` wrapper to decide chat/server vs wizard. Exits WITHOUT
    // running the interactive wizard. May prompt for a single missing cloud API key.
    if (process.argv.includes('--preflight')) {
        const { ok, reason } = await runPreflight();
        if (!ok) console.error(`⚠️  REI not configured to run here: ${reason}`);
        process.exit(ok ? 0 : 1);
    }
    await loadConfiguration();
    await main();
}

// Pure, side-effect-free helpers exported for unit tests (idempotency / non-destructive merges).
export { upsertEnvLine, applyEnvVars, mergeReiConfig, normalizeEndpoint, defaultTuning };

// Only auto-run when executed directly (as the wrapper does), not when imported by a test.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    start();
}