import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { select, text, confirm, note, intro, isCancel, cancel } from '@clack/prompts';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env'), quiet: true });

let PROJECTS = [];
let PROVIDER_MODELS = {};
let PROVIDERS = [];
const CUSTOM = '[ enter custom model... ]';

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
            gemini: ['gemini-2.5-flash']
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
 * Returns installed Ollama models from `ollama list`.
 * Falls back to PROVIDER_MODELS.ollama if the command fails or returns nothing.
 */
function getOllamaModels() {
    try {
        const output = execSync('ollama list', { encoding: 'utf8', timeout: 5000 });
        const models = output.trim().split('\n')
            .slice(1)                              // skip header row
            .map(line => line.trim().split(/\s+/)[0])
            .filter(name => name && name.length > 0);
        return models.length > 0 ? models : (PROVIDER_MODELS.ollama ?? []);
    } catch {
        return PROVIDER_MODELS.ollama ?? [];       // fallback: ollama not running or not in PATH
    }
}

/**
 * Returns available models from a running LLM Studio instance.
 * Falls back to PROVIDER_MODELS.llmstudio if the request fails.
 */
async function getLlmStudioModels() {
    try {
        const baseUrl = process.env.LLM_STUDIO_BASE_URL || 'http://localhost:1234';
        const res = await fetch(`${baseUrl}/v1/models`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const models = (data.data || []).map(m => m.id).filter(Boolean);
        return models.length > 0 ? models : (PROVIDER_MODELS.llmstudio ?? []);
    } catch {
        return PROVIDER_MODELS.llmstudio ?? [];
    }
}

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
    return provider.toUpperCase();
}

async function pickProvider(message, initialValue) {
    const provider = await select({
        message,
        options: PROVIDERS.map(p => ({ value: p, label: p })),
        initialValue,
    });
    if (isCancel(provider)) { cancel('Cancelled'); process.exit(0); }
    return provider;
}

async function pickModel(provider, message, initialModel) {
    let baseList;
    if (provider === 'ollama') {
        baseList = getOllamaModels();
    } else if (provider === 'llmstudio') {
        baseList = await getLlmStudioModels();
    } else {
        baseList = PROVIDER_MODELS[provider] ?? [];
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const last = loadLast();
    const initialWorkspace = process.cwd();

    intro('REI Launcher');

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

    if (providerSetup === 'single') {
        const provider = await pickProvider('Provider:', last.provider);
        const model    = await pickModel(provider, 'Model:', last.provider === provider ? last.model : undefined);

        Object.assign(config, { provider, model });
        envVars.MODEL_PROVIDER = provider;
        const prefix = getEnvPrefix(provider);
        envVars[`${prefix}_MODEL`] = model;
        // Explicitly clear AGENT_MODEL_PROVIDER to prevent .env bleed-through in single provider mode
        envVars.AGENT_MODEL_PROVIDER = '';

        // Ollama: optionally set different models per mode
        if (provider === 'ollama') {
            const perMode = await confirm({
                message: 'Use different models per mode (ask/planning vs agent)?',
                initialValue: last.ollamaPerMode ?? false,
            });
            if (isCancel(perMode)) { cancel('Cancelled'); process.exit(0); }

            if (perMode) {
                note('ask + planning will use the first model.\nagent will use the second.', 'Per-mode models');
                const askModel   = await pickModel('ollama', 'Model for ask + planning:', last.ollamaAskModel ?? model);
                const agentModel = await pickModel('ollama', 'Model for agent:', last.ollamaAgentModel ?? model);
                envVars.OLLAMA_MODEL_ASK      = askModel;
                envVars.OLLAMA_MODEL_PLANNING = askModel;
                envVars.OLLAMA_MODEL_AGENT    = agentModel;
                Object.assign(config, { ollamaPerMode: true, ollamaAskModel: askModel, ollamaAgentModel: agentModel });
            } else {
                // Single provider without per-mode overrides: override all modes to the selected model
                // to prevent falling back to values in .env
                envVars.OLLAMA_MODEL_ASK      = model;
                envVars.OLLAMA_MODEL_PLANNING = model;
                envVars.OLLAMA_MODEL_AGENT    = model;
                Object.assign(config, { ollamaPerMode: false });
            }
        }

    } else {
        // Multi-provider: ask/planning provider + agent provider
        note('Step 1 of 2: provider for ask and planning modes.', 'Multi-provider setup');
        const askProvider = await pickProvider('Provider (ask + planning):', last.askProvider);
        const askModel    = await pickModel(askProvider, 'Model (ask + planning):', last.askProvider === askProvider ? last.askModel : undefined);

        note('Step 2 of 2: provider for agent mode.', 'Multi-provider setup');
        const agentProvider = await pickProvider('Provider (agent):', last.agentProvider);
        const agentModel    = await pickModel(agentProvider, 'Model (agent):', last.agentProvider === agentProvider ? last.agentModel : undefined);

        Object.assign(config, { askProvider, askModel, agentProvider, agentModel });
        envVars.MODEL_PROVIDER = askProvider;
        
        const askPrefix = getEnvPrefix(askProvider);
        const agentPrefix = getEnvPrefix(agentProvider);
        
        envVars[`${askPrefix}_MODEL`]              = askModel;
        envVars.AGENT_MODEL_PROVIDER                               = agentProvider;
        envVars[`${agentPrefix}_MODEL_AGENT`]      = agentModel;

        // Explicitly set per-mode vars so ask/planning don't inherit the agent model
        if (askProvider === 'ollama') {
            envVars.OLLAMA_MODEL_ASK      = askModel;
            envVars.OLLAMA_MODEL_PLANNING = askModel;
        }
    }

    // ── Step 5: Context & token budget (unified) ───────────────────────────
    // Writes the provider-agnostic REI_* names that src/config/model-runtime.ts
    // resolves. These take precedence over OLLAMA_NUM_CTX / LLM_STUDIO_MAX_TOKENS,
    // so the wizard must use them — otherwise a value it writes gets shadowed and
    // silently ignored. Prompted only for local providers (cloud models have large
    // fixed windows and rarely need REI's budget overrides).
    const usesOllama = envVars.MODEL_PROVIDER === 'ollama' || envVars.AGENT_MODEL_PROVIDER === 'ollama';
    const LOCAL_PROVIDERS = ['ollama', 'llmstudio'];
    const usesLocal =
        LOCAL_PROVIDERS.includes(envVars.MODEL_PROVIDER) ||
        LOCAL_PROVIDERS.includes(envVars.AGENT_MODEL_PROVIDER);

    if (usesLocal) {
        // Context window (REI's history-trimming assumption). 0 = no trimming.
        if (process.env.REI_CONTEXT_WINDOW !== undefined) {
            // Already set in .env — carry it through silently so the wizard never
            // overwrites a deliberate choice (and never writes a shadowed value).
            envVars.REI_CONTEXT_WINDOW = process.env.REI_CONTEXT_WINDOW;
        } else {
            const setCtx = await confirm({
                message: 'Set REI_CONTEXT_WINDOW (history-trimming budget; 0 = no trimming)?',
                initialValue: last.setCtxWindow ?? false,
            });
            if (isCancel(setCtx)) { cancel('Cancelled'); process.exit(0); }

            if (setCtx) {
                const ctxValue = await select({
                    message: 'REI_CONTEXT_WINDOW (0 = let the model manage its own window):',
                    options: ['0', '8192', '16384', '32768', '60000'].map(v => ({ value: v, label: v })),
                    initialValue: last.ctxWindow ?? '0',
                });
                if (isCancel(ctxValue)) { cancel('Cancelled'); process.exit(0); }
                envVars.REI_CONTEXT_WINDOW = ctxValue;
                Object.assign(config, { setCtxWindow: true, ctxWindow: ctxValue });
            } else {
                Object.assign(config, { setCtxWindow: false });
            }
        }

        // Output cap = provider hard limit AND budget reserve (one value). Keep
        // >= 8192: 4096 truncates long tool calls mid-edit.
        if (process.env.REI_MAX_OUTPUT_TOKENS !== undefined) {
            envVars.REI_MAX_OUTPUT_TOKENS = process.env.REI_MAX_OUTPUT_TOKENS;
        } else {
            const outValue = await select({
                message: 'REI_MAX_OUTPUT_TOKENS (max tokens the model can emit per turn):',
                options: ['8192', '16384', '32768'].map(v => ({ value: v, label: v })),
                initialValue: last.maxOutputTokens ?? '8192',
            });
            if (isCancel(outValue)) { cancel('Cancelled'); process.exit(0); }
            envVars.REI_MAX_OUTPUT_TOKENS = outValue;
            Object.assign(config, { maxOutputTokens: outValue });
        }
    }

    // ── Step 6: server env ─────────────────────────────────────────────────
    // Always set workspace path vars — used by server; harmless for CLI.
    envVars.REI_WORKSPACE_PATH  = projectPath;
    envVars.ALLOWED_WORKSPACES  = projectPath;

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

        for (const [key, value] of Object.entries(envVars)) {
            if (value === undefined) continue;
            const regex = new RegExp(`^${key}=.*$`, 'm');
            if (regex.test(envContent)) {
                envContent = envContent.replace(regex, `${key}=${value}`);
            } else {
                envContent += `\n${key}=${value}`;
            }
        }
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
    const cmd = isServer
        ? 'npm run server:dev'
        : `npm run dev -- --workspace ${projectArg} chat`;

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
    await loadConfiguration();
    await main();
}

start();