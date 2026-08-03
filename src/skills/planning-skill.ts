import type { Agent } from "../core/agent.js";

// Planning skill function
/**
 * A planning skill that takes an agent and a task as input, and returns a string of actionable steps to complete the task.
 * @param agent - The agent that will perform the planning skill.
 * @param task - The task to be broken down into actionable steps.
 * @returns A string of actionable steps to complete the task.
 */
export async function planningSkill(
  agent: Agent,
  task: string,
): Promise<string> {
  const prompt = `You are a planning assistant. Break down the following task into clear, actionable steps:\n\nTask: ${task}`;
  return agent.run(prompt);
}
