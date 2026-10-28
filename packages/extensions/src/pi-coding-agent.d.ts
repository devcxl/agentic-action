declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionContext {
    hasUI?: boolean;
    mode?: string;
    [key: string]: unknown;
  }

  export interface ToolDefinition<TParams = Record<string, unknown>, TDetails = unknown> {
    name: string;
    label?: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    execute(
      toolCallId: string,
      params: TParams,
      signal?: AbortSignal,
      onUpdate?: (partial: { content: Array<{ type: string; text?: string }>; details?: unknown }) => void,
      ctx?: ExtensionContext,
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: TDetails;
      structuredContent?: TDetails;
      isError?: boolean;
      terminate?: boolean;
    }>;
  }

  export interface ProviderRefreshContext {
    signal?: AbortSignal;
    credential?: { type?: string; key?: string };
  }

  export interface ProviderConfig {
    name: string;
    baseUrl: string;
    apiKey: string;
    api: string;
    models: unknown[];
    refreshModels?: (context: ProviderRefreshContext) => Promise<unknown[]>;
  }

  export interface ExtensionAPI {
    on(
      event: string,
      handler: (event: Record<string, unknown>, ctx: ExtensionContext) => void | Promise<void>,
    ): void;
    registerProvider(id: string, config: ProviderConfig): void;
    registerTool<TParams = Record<string, unknown>, TDetails = unknown>(
      tool: ToolDefinition<TParams, TDetails>,
    ): void;
  }

  export function defineTool<TParams = Record<string, unknown>, TDetails = unknown>(
    tool: ToolDefinition<TParams, TDetails>,
  ): ToolDefinition<TParams, TDetails>;
}
