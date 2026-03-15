import type { Agent } from "../core/agent.js";

export async function planningSkill(agent: Agent, task: string): Promise<string> {
  const prompt = `You are a planning assistant. Break down the following task into clear, actionable steps:\n\nTask: ${task}`;
  return agent.run(prompt);
}
