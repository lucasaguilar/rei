#!/usr/bin/env node
// Test script: probes LM Studio for reasoning_effort compatibility with ThinkingCap-Qwen3.6-27B
// Run: node scripts/test-reasoning-effort.js

const baseUrl = process.env.LLM_STUDIO_BASE_URL || "http://localhost:1234/v1";
const apiKey = process.env.LLM_STUDIO_API_KEY || "lm-studio";
const model = process.env.LLM_STUDIO_MODEL || '';

function reasoningLength(r) {
  return r.reasoningLength || 0;
}

async function testReasoningEffort(level) {
  const body = {
    model: model,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is 2 + 2? Think step by step." },
    ],
    temperature: 0.6,
    max_tokens: 2048,
    reasoning_effort: level,
    stream: false,
  };

  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    const elapsed = Date.now() - start;

    if (!res.ok || data.error) {
      return {
        level,
        ok: false,
        status: res.status,
        error: data.error?.message || JSON.stringify(data).slice(0, 200),
        elapsedMs: elapsed,
      };
    }

    const msg = data.choices?.[0]?.message || {};
    return {
      level,
      ok: true,
      status: res.status,
      contentLength: (msg.content || "").length,
      reasoningLength: (msg.reasoning_content || "").length,
      hasReasoning: !!msg.reasoning_content && (msg.reasoning_content || "").length > 0,
      finishReason: data.choices?.[0]?.finish_reason,
      elapsedMs: elapsed,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    return {
      level,
      ok: false,
      error: err.message,
      elapsedMs: elapsed,
    };
  }
}

async function testNoReasoningParam() {
  const body = {
    model: model,
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "What is 2 + 2? Think step by step." },
    ],
    temperature: 0.6,
    max_tokens: 2048,
    stream: false,
  };

  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    const elapsed = Date.now() - start;

    if (!res.ok || data.error) {
      return {
        level: "(no param)",
        ok: false,
        status: res.status,
        error: data.error?.message || JSON.stringify(data).slice(0, 200),
        elapsedMs: elapsed,
      };
    }

    const msg = data.choices?.[0]?.message || {};
    return {
      level: "(no param)",
      ok: true,
      status: res.status,
      contentLength: (msg.content || "").length,
      reasoningLength: (msg.reasoning_content || "").length,
      hasReasoning: !!msg.reasoning_content && (msg.reasoning_content || "").length > 0,
      finishReason: data.choices?.[0]?.finish_reason,
      elapsedMs: elapsed,
    };
  } catch (err) {
    const elapsed = Date.now() - start;
    return {
      level: "(no param)",
      ok: false,
      error: err.message,
      elapsedMs: elapsed,
    };
  }
}

async function main() {
  console.log("═".repeat(72));
  console.log("  REI — Test reasoning_effort compatibility");
  console.log("═".repeat(72));
  console.log(`  URL:   ${baseUrl}`);
  console.log(`  Model: ${model || "<auto/first>"}`);
  console.log("═".repeat(72));
  console.log();

  const levels = ["none", "minimal", "low", "medium", "high"];
  const results = [];

  // First: baseline without the param at all
  console.log("[1/6] Baseline — NO reasoning_effort param …");
  results.push(await testNoReasoningParam());

  for (const level of levels) {
    console.log(`[${levels.indexOf(level) + 2}/6] reasoning_effort="${level}" …`);
    results.push(await testReasoningEffort(level));
  }

  console.log();
  console.log("═".repeat(72));
  console.log("  Results");
  console.log("═".repeat(72));

  for (const r of results) {
    const icon = r.ok ? "✅" : "❌";
    if (r.ok) {
      console.log(
        `  ${icon} "${r.level.padEnd(10)}" → content=${String(r.contentLength).padStart(5)} chars  ` +
        `reasoning=${String(r.reasoningLength).padStart(5)} chars  ` +
        `has_thinking=${String(r.hasReasoning).padStart(5)}  ` +
        `${r.elapsedMs}ms`
      );
    } else {
      console.log(
        `  ${icon} "${r.level.padEnd(10)}" → ERROR: ${(r.error || "unknown").slice(0, 80)}`
      );
    }
  }

  // Verdict
  const allOk = results.every(r => r.ok);
  const hasReasoningLevels = results.filter(r => r.ok && r.hasReasoning);

  console.log();
  console.log("─".repeat(72));
  if (!allOk) {
    const failed = results.filter(r => !r.ok);
    console.log("  ⚠️  reasoning_effort is NOT fully supported — some levels failed.");
    console.log(`  Failed: ${failed.map(r => `"${r.level}"`).join(", ")}`);
    console.log("  → Set REI_REASONING_EFFORT_ASK=none and REI_REASONING_EFFORT_AGENT=none in REI");
  } else if (hasReasoningLevels.length > 0) {
    console.log("  ✅ reasoning_effort IS supported by this model in LM Studio.");
    const noneResult = results.find(r => r.level === "none");
    const highResult = results.find(r => r.level === "high");
    if (noneResult && highResult) {
      const noneLen = reasoningLength(noneResult);
      const highLen = reasoningLength(highResult);
      console.log(`  "none" reasoning chars: ${noneLen} | "high" reasoning chars: ${highLen}`);
      if (Math.abs(noneLen - highLen) < 20) {
        console.log("  ⚠️  WARNING: 'none' and 'high' produce similar reasoning output.");
        console.log("     Model may be ignoring the parameter (collapsing to on/off).");
        console.log("     → Use 'none' to disable, any other value enables thinking.");
      } else {
        console.log("  ✅ Parameter is respected — granular control works.");
      }
    }
    console.log("  → REI config: set REI_REASONING_EFFORT_AGENT=medium, ASK=none");
  } else {
    console.log("  ℹ️  Model does not produce reasoning_content (not a thinking model).");
    console.log("     reasoning_effort param is accepted but has no effect.");
  }

  console.log();
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
