/**
 * @fileoverview Shared utilities for MCP transport clients (stdio, HTTP, etc.).
 * Extracted here to eliminate code duplication between transport implementations.
 *
 * @module rei/tools/mcp/shared
 */

import { type Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ---------------------------------------------------------------------------
// Text extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extracts text content from an MCP tool call response.
 * Filters for `type === "text"` entries and joins them with newlines.
 */
export function extractTextContent(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  return (
    result.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n") ?? ""
  );
}

/**
 * Extracts text content from an MCP resource read response.
 * Accepts entries with `type === "text"` or no type field.
 */
export function extractTextContentFromContents(result: {
  contents?: Array<{ type?: string; text?: string }>;
}): string {
  return (
    result.contents
      ?.filter((c) => c.type === "text" || !c.type)
      .map((c) => c.text ?? "")
      .join("\n") ?? ""
  );
}

/**
 * Extracts text content from an MCP prompt get response.
 */
export function extractPromptMessages(result: {
  messages?: Array<{ content?: { text?: string } }>;
}): string {
  return (
    result.messages
      ?.map((m) => m.content?.text ?? "")
      .filter(Boolean)
      .join("\n") ?? ""
  );
}

// ---------------------------------------------------------------------------
// Notification handler setup
// ---------------------------------------------------------------------------

/**
 * Registers the standard set of MCP notification handlers on a client.
 * Called once during initialisation before the connection handshake.
 */
export function setupNotificationHandlers(
  client: Client,
  serverName: string,
): void {
  client.setNotificationHandler(
    ProgressNotificationSchema,
    (notification) => {
      console.debug(
        `[REI/MCP/${serverName}] Progress: ${JSON.stringify(notification)}`,
      );
    },
  );

  client.setNotificationHandler(
    LoggingMessageNotificationSchema,
    (notification) => {
      console.debug(
        `[REI/MCP/${serverName}] Log: ${JSON.stringify(notification)}`,
      );
    },
  );

  client.setNotificationHandler(
    ResourceUpdatedNotificationSchema,
    (notification) => {
      console.debug(
        `[REI/MCP/${serverName}] Resource updated: ${JSON.stringify(notification)}`,
      );
    },
  );

  client.setNotificationHandler(
    ResourceListChangedNotificationSchema,
    () => {
      console.debug(`[REI/MCP/${serverName}] Resource list changed`);
    },
  );

  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    console.debug(`[REI/MCP/${serverName}] Tool list changed`);
  });
}
