export interface ModelProvider {
  complete(prompt: string): Promise<string>;
}
