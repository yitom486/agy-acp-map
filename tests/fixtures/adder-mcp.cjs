// Minimal stdio MCP server for ACP Studio -> agy-acp registration testing.
// The official MCP SDK owns JSON-RPC framing, initialization, dispatch, and validation.
async function main() {
  const { McpServer } = await import("@modelcontextprotocol/server");
  const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
  const z = await import("zod/v4");

  const server = new McpServer({ name: "studio-adder", version: "0.2.0" });

  server.registerTool(
    "add",
    {
      description: "Add two finite numbers and return their sum.",
      inputSchema: z.object({
        a: z.number().finite().describe("First number"),
        b: z.number().finite().describe("Second number"),
      }),
    },
    async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
    }),
  );

  // stdio stdout is reserved for MCP protocol messages. Put logs on stderr.
  console.error("studio-adder MCP server running on stdio");
  await serveStdio(() => server);
}

main().catch((error) => {
  console.error("studio-adder MCP server failed:", error);
  process.exitCode = 1;
});
