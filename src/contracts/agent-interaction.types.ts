export interface AgentFileRequest {
  path: string;
}

export interface AgentSREdit {
  file: string;
  description?: string;
  search: string;
  replace: string;
}

export interface AgentWholeFileEdit {
  file: string;
  content: string;
}
