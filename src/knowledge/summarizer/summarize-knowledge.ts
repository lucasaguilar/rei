import { ModelProvider } from "../../providers/model-provider.js";
import { SummarizeFunction } from "../types.js";

export function createKnowledgeSummarizer(provider: ModelProvider): SummarizeFunction {
  return async (query: string, rawText: string): Promise<string> => {
    // We send a direct, synchronous request to the LLM to summarize the given text
    const prompt = [
      "You are an expert technical documentation summarizer.",
      `The user is asking a question related to: "${query}"`,
      "Below is a raw excerpt from official documentation.",
      "Extract and summarize ONLY the technical details, implementation steps, and code patterns that are highly relevant to the query.",
      "Ignore navigation links, footers, headers, and irrelevant promotional text.",
      "Keep it strictly technical and extremely concise (bullet points are preferred).",
      "Do NOT invent any information. If the text does not contain relevant info, just output 'No relevant technical implementation found.'",
      "",
      "--- RAW DOCUMENTATION TEXT ---",
      rawText,
      "--- END OF TEXT ---",
    ].join("\n");

    try {
      const result = await provider.completeChat([
        { role: "system", content: "You summarize technical documentation." },
        { role: "user", content: prompt }
      ]);
      return result.trim();
    } catch (error) {
      return "Summarization failed due to LLM error.";
    }
  };
}
