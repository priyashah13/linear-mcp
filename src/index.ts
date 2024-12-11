import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
  ListResourceTemplatesRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { LinearClient } from "@linear/sdk";
import dotenv from "dotenv";

dotenv.config();

const API_KEY = process.env.LINEAR_API_KEY;
if (!API_KEY) {
  throw new Error("LINEAR_API_KEY environment variable is required");
}

class LinearServer {
  private server: Server;
  private linearClient: LinearClient;

  constructor() {
    this.server = new Server(
      {
        name: "linear-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      }
    );

    this.linearClient = new LinearClient({
      apiKey: process.env.LINEAR_API_KEY!,
      accessToken: process.env.LINEAR_ACCESS_TOKEN!,
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Resources for reading Linear data
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: "linear://issues/active",
          name: "Active Issues",
          mimeType: "application/json",
          description: "Currently active issues in Linear",
        },
        {
          uri: "linear://teams",
          name: "Teams",
          mimeType: "application/json",
          description: "List of teams in the workspace",
        },
      ],
    }));

    // Add this handler if you want to support resource templates
    this.server.setRequestHandler(
      ListResourceTemplatesRequestSchema,
      async () => ({
        resourceTemplates: [
          {
            uriTemplate: "linear://issues/{issueId}",
            name: "Single Issue",
            mimeType: "application/json",
            description: "Get a specific issue by ID",
          },
        ],
      })
    );

    this.server.setRequestHandler(
      ReadResourceRequestSchema,
      async (request) => {
        const uri = request.params.uri;

        try {
          let content;

          if (uri === "linear://issues/active") {
            const issues = await this.linearClient.issues({
              filter: {
                state: { type: { in: ["started", "unstarted", "backlog"] } },
              },
            });
            content = await issues.nodes;
          } else if (uri === "linear://teams") {
            const teams = await this.linearClient.teams();
            content = await teams.nodes;
          } // Handle template resource
          else if (uri.startsWith("linear://issues/")) {
            const issueId = uri.replace("linear://issues/", "");
            // Skip the "active" case we handled above
            if (issueId !== "active") {
              const issue = await this.linearClient.issue(issueId);
              content = await issue;
            }
          } else {
            throw new McpError(
              ErrorCode.InvalidRequest,
              `Unknown resource: ${uri}`
            );
          }

          return {
            contents: [
              {
                uri: request.params.uri,
                mimeType: "application/json",
                text: JSON.stringify(content, null, 2),
              },
            ],
          };
        } catch (error) {
          throw new McpError(
            ErrorCode.InternalError,
            `Linear API error: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    );

    // Tools for creating and modifying Linear data
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "create_issue",
          description: "Create a new issue in Linear",
          inputSchema: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Title of the issue",
              },
              description: {
                type: "string",
                description: "Description of the issue",
              },
              teamId: {
                type: "string",
                description: "ID of the team to assign the issue to",
              },
              priority: {
                type: "number",
                description: "Priority of the issue (0-4)",
                minimum: 0,
                maximum: 4,
              },
            },
            required: ["title", "teamId"],
          },
        },
        {
          name: "read_team_ids",
          description: "Read team ids",
          inputSchema: {
            type: "object",
            properties: {},
            required: [],
          },
        },
        {
          name: "update_issue",
          description: "Update an existing issue in Linear",
          inputSchema: {
            type: "object",
            properties: {
              issueId: {
                type: "string",
                description: "ID of the issue to update",
              },
              title: {
                type: "string",
                description: "New title for the issue",
              },
              description: {
                type: "string",
                description: "New description for the issue",
              },
              status: {
                type: "string",
                description: "New status for the issue",
              },
            },
            required: ["issueId"],
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        if (request.params.name === "create_issue") {
          const { title, description, teamId, priority } = request.params
            .arguments as {
            title: string;
            description: string;
            teamId: string;
            priority: number;
          };

          const issue = await this.linearClient.createIssue({
            title,
            description,
            teamId,
            priority,
          });

          return {
            content: [
              {
                type: "text",
                text: `Created issue: ${(await issue.issue)?.url}`,
              },
            ],
          };
        }

        if (request.params.name === "update_issue") {
          const { issueId, title, description } = request.params.arguments as {
            issueId: string;
            title: string;
            description: string;
          };

          const issue = await this.linearClient.updateIssue(issueId, {
            title,
            description,
          });

          return {
            content: [
              {
                type: "text",
                text: `Updated issue: ${(await issue.issue)?.url}`,
              },
            ],
          };
        }

        if (request.params.name === "read_team_ids") {
          const teams = await this.linearClient.teams();
          return {
            content: [{ type: "text", text: JSON.stringify(teams.nodes) }],
          };
        }

        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${request.params.name}`
        );
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Linear API error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async run(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("Linear MCP server running on stdio");
  }
}

const server = new LinearServer();
server.run().catch(console.error);
