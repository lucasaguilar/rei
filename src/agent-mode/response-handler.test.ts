import { describe, it, expect } from "vitest";
import { extractCommandRequests } from "./response-handler.js";

describe("response-handler extractCommandRequests", () => {
  it("extracts raw commands perfectly", () => {
    const response = `<execute_command>grep -r "VectorMetadata" src</execute_command>`;
    const commands = extractCommandRequests(response);
    expect(commands).toEqual(['grep -r "VectorMetadata" src']);
  });

  it("extracts and normalizes commands wrapped in inline backticks", () => {
    const response = `<execute_command>\`grep -r "VectorMetadata" src --include="*.ts"\`</execute_command>`;
    const commands = extractCommandRequests(response);
    expect(commands).toEqual(['grep -r "VectorMetadata" src --include="*.ts"']);
  });

  it("extracts and normalizes commands wrapped in markdown code blocks with bash language", () => {
    const response = `<execute_command>
\`\`\`bash
grep -r "VectorMetadata" src --include="*.ts"
\`\`\`
</execute_command>`;
    const commands = extractCommandRequests(response);
    expect(commands).toEqual(['grep -r "VectorMetadata" src --include="*.ts"']);
  });

  it("extracts multiple commands and normalizes each", () => {
    const response = `
      Some conversational text.
      <execute_command>\`npm run test\`</execute_command>
      More text.
      <execute_command>
      \`\`\`
      git diff
      \`\`\`
      </execute_command>
    `;
    const commands = extractCommandRequests(response);
    expect(commands).toEqual(['npm run test', 'git diff']);
  });
});
