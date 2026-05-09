import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import inquirer from 'inquirer';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { PROJECTS, PROVIDER_MODELS } from './launch-rei.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

dotenv.config({ path: path.join(ROOT, '.env') });

// PROJECTS and PROVIDER_MODELS are loaded from launch-rei.config.js (git-ignored).
// Copy launch-rei.config.example.js to launch-rei.config.js to get started.

const PROVIDERS = Object.keys(PROVIDER_MODELS);
const CUSTOM = '[ enter custom model... ]';

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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const last = loadLast();

    // Step 1: workspace (with validation)
    let project;
    let validProjectSelected = false;
    while (!validProjectSelected) {
        const { selectedProject } = await inquirer.prompt([{
            type: 'list',
            name: 'selectedProject',
            message: 'Workspace:',
            choices: PROJECTS,
            default: last.project,
        }]);

        // Validate that the project path exists (works on Windows, macOS, Linux)
        const projectPath = path.isAbsolute(selectedProject)
            ? selectedProject
            : path.resolve(ROOT, selectedProject);

        if (fs.existsSync(projectPath)) {
            project = selectedProject;
            validProjectSelected = true;
        } else {
            console.log(`\n❌ Path does not exist: ${projectPath}\nPlease select a valid workspace.\n`);
        }
    }

    // Step 2: provider
    const { provider } = await inquirer.prompt([{
        type: 'list',
        name: 'provider',
        message: 'Provider:',
        choices: PROVIDERS,
        default: last.provider,
    }]);

    // Step 3: model (suggestions for selected provider + custom option)
    const modelChoices = [...(PROVIDER_MODELS[provider] ?? []), CUSTOM];
    const { modelChoice } = await inquirer.prompt([{
        type: 'list',
        name: 'modelChoice',
        message: 'Model:',
        choices: modelChoices,
        default: last.provider === provider ? last.model : modelChoices[0],
    }]);

    let model = modelChoice;
    if (modelChoice === CUSTOM) {
        const { customModel } = await inquirer.prompt([{
            type: 'input',
            name: 'customModel',
            message: 'Enter model name:',
            validate: (v) => v.trim().length > 0 || 'Model name cannot be empty',
        }]);
        model = customModel.trim();
    }

    saveLast({ project, provider, model });

    // Build env — each provider reads its own env var (e.g. OPENROUTER_MODEL, GROQ_MODEL)
    const envKey = `${provider.toUpperCase()}_MODEL`;
    const env = {
        ...process.env,
        MODEL_PROVIDER: provider,
        [envKey]: model,
    };

    console.log(`\nLaunching REI [${provider}] ${model} → ${project}\n`);

    // shell:true resolves npm/npm.cmd on Windows, macOS, and Linux transparently
    const child = spawn(
        'npm',
        ['run', 'dev', '--', '--workspace', project, 'chat'],
        { env, stdio: 'inherit', shell: true },
    );

    child.on('error', (err) => {
        console.error(`Failed to launch REI: ${err.message}`);
        process.exit(1);
    });

    child.on('close', (code) => {
        if (code !== 0) console.log(`REI exited with code ${code}`);
    });
}

main();