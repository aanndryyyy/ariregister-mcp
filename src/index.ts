#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AriregClient } from "./client.js";
import { registerTools } from "./tools.js";

const { version, description } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
  description: string;
};

// Inlined as a data: URI so it works over stdio, where the client cannot fetch a relative path.
const icon = {
  src: `data:image/svg+xml;base64,${readFileSync(new URL("../assets/icon.svg", import.meta.url)).toString("base64")}`,
  mimeType: "image/svg+xml",
  sizes: ["any"],
};

const HOUR = 3_600_000;

const client = new AriregClient({
  apiKey: process.env.ARIREGISTER_API_KEY,
  username: process.env.ARIREGISTER_USERNAME,
  password: process.env.ARIREGISTER_PASSWORD,
  restBaseUrl: process.env.ARIREGISTER_REST_URL,
  soapUrl: process.env.ARIREGISTER_XML_URL,
  userAgent: `ariregister-mcp/${version}`,
});

const handle = serveStdio(
  () => {
    const server = new McpServer(
      {
        name: "ariregister",
        title: "Äriregister (e-Business Register)",
        version,
        description,
        websiteUrl: "https://github.com/aanndryyyy/ariregister-mcp",
        icons: [icon],
      },
      {
        capabilities: { tools: {} },
        // The tool list is static for the life of the process and holds no per-user data.
        cacheHints: {
          "tools/list": { ttlMs: HOUR, cacheScope: "public" },
          "server/discover": { ttlMs: HOUR, cacheScope: "public" },
        },
        instructions:
          "Tools for the Estonian e-Business Register (Äriregister, RIK). Start with search_companies to turn a name " +
          "into an 8-digit registry code; it and check_einvoice_recipients are public. get_company, find_companies, " +
          "get_representation_rights, list_annual_reports, get_beneficial_owners and search_trusts use the REST API and " +
          "need an API key; get_annual_report_figures, list_company_documents, get_classifier and xml_service_request use " +
          "the XML service and need the contract username and password. A tool returns CREDENTIALS_MISSING when its " +
          "credentials aren't set. Beneficial-owner data is restricted and every lookup is logged with the requester's " +
          "identity: only call get_beneficial_owners with details the user gave for themselves. Limits: 50 000 queries " +
          "per day, and one XML query at a time. Link a company's register page: https://ariregister.rik.ee/eng/company/{registry_code}.",
      },
    );
    registerTools(server, client);
    return server;
  },
  { onerror: (err) => console.error("[ariregister-mcp]", err) },
);

client.credentialStatus().then(({ rest, soap }) =>
  console.error(
    `[ariregister-mcp] REST API key: ${rest ?? "not set"}; XML service login: ${soap ?? "not set"} (public tools work without either)`,
  ),
);

const shutdown = () => {
  void handle.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
