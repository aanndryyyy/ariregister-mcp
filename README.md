<img src="assets/icon.svg" width="64" height="64" alt="">

# ariregister-mcp

An [MCP](https://modelcontextprotocol.io) server for the Estonian e-Business Register ([Äriregister](https://ariregister.rik.ee), run by RIK) ([API docs](https://avaandmed.ariregister.rik.ee/en/open-data-api/introduction-api-services)).
Use it to look up Estonian companies, their people and representation rights, annual reports, and e-invoice readiness from Claude or any other MCP client.

- Built on the **MCP TypeScript SDK v2** (`@modelcontextprotocol/server`). It serves the **2026-07-28** protocol revision and still works with clients on the 2025 revisions.
- Uses the stdio transport. It needs Node.js 20 or newer.
- Every tool is read-only.

## Tools

The register has three access levels, and each tool needs one of them.

| Tool | What it does | Needs |
| --- | --- | --- |
| `search_companies` | Find companies by name, part of a name, or registry code (up to 10 matches, with status, address and page URL) | – |
| `check_einvoice_recipients` | Check whether up to 100 companies accept e-invoices, and through which operator | – |
| `get_company` | Full company data: general data, related persons, commercial pledges, rulings, registry cards | API key |
| `find_companies` | Filtered company search by name, EMTAK activity, location, status, or a related person or company | API key |
| `get_representation_rights` | Who may represent a company, and whether they can act alone | API key |
| `list_annual_reports` | Filed annual reports with revenue, balance-sheet total, employees, audit status and file links | API key |
| `get_beneficial_owners` | A company's beneficial owners. The data is restricted and every lookup is logged | API key + legal basis |
| `search_trusts` | The register of trusts and the people involved | API key |
| `get_annual_report_figures` | Annual report line items (balance sheet, income statement, …) for this year and the previous one | XML login |
| `list_company_documents` | Documents in a company's public file (annual report PDF/XBRL, articles) with download URLs | XML login |
| `get_classifier` | Code lists (legal forms, statuses, roles, countries, …) | XML login |
| `xml_service_request` | Any other XML service query, e.g. daily change lists, entries and rulings, revenue by activity | XML login |

- **–**: public. `search_companies` uses the register's autocomplete API. `check_einvoice_recipients` uses the XML service's e-invoice query, which RIK serves without a contract.
- **API key**: the REST API at `https://ar-rest.rik.ee` ([OpenAPI](https://ar-rest.rik.ee/docs); a copy is in `spec/`). The server trades the key for a bearer token at `/keyLogin/`, caches the token, and logs in again when the token expires.
- **XML login**: the SOAP service at `https://ariregxmlv6.rik.ee`. It takes the contract's username and password inside each request. It's only used for queries the REST API doesn't cover.

## Getting access

The public tools work without any setup. For the others:

1. Sign the API contract at <https://ariregister.rik.ee/eng/contract>. RIK takes about 5 working days to review it. A contract that covers only the API services is free.
2. For the REST tools, create an API key in your e-Business Register account ([instructions](https://abiinfo.rik.ee/en/e-business-register-queries/xml-service-api/adding-api-keys-rest-services)).
3. For the XML tools, use the username and password that come with the contract.

You can set the credentials as environment variables in your MCP client config. On macOS you can store them in the Keychain instead, so they're never written into a config file:

```bash
security add-generic-password -U -s ariregister-api-key -a api-key -w          # REST API key (prompts for it)
security add-generic-password -U -s ariregister-xml -a <username> -w           # XML service password (prompts for it)
```

Environment variables take precedence over the Keychain.

## Setup

**Claude Code** (from a local clone)

```bash
cd ariregister-mcp && npm install   # builds dist/ automatically
claude mcp add -s user ariregister -- node "$PWD/dist/index.js"
# or, with credentials in the config instead of the Keychain:
claude mcp add -s user ariregister -e ARIREGISTER_API_KEY=xxx -e ARIREGISTER_USERNAME=xxx -e ARIREGISTER_PASSWORD=xxx -- node "$PWD/dist/index.js"
```

**Claude Desktop, Cursor, and other clients using `mcpServers` JSON**

```json
{
  "mcpServers": {
    "ariregister": {
      "command": "node",
      "args": ["/path/to/ariregister-mcp/dist/index.js"],
      "env": { "ARIREGISTER_API_KEY": "xxx", "ARIREGISTER_USERNAME": "xxx", "ARIREGISTER_PASSWORD": "xxx" }
    }
  }
}
```

### Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `ARIREGISTER_API_KEY` | – | REST API key (Keychain fallback: service `ariregister-api-key`) |
| `ARIREGISTER_USERNAME` / `ARIREGISTER_PASSWORD` | – | XML service login (Keychain fallback: service `ariregister-xml`, account = username) |
| `ARIREGISTER_REST_URL` | `https://ar-rest.rik.ee` | Override the REST base URL |
| `ARIREGISTER_XML_URL` | `https://ariregxmlv6.rik.ee/` | Override the XML service URL, e.g. `https://demo-ariregxmlv6.rik.ee/` for RIK's test environment |

## Example prompts

- "What's the registry code of Arbictus OÜ, and is it still active?"
- "Can these five companies receive e-invoices?"
- "Who's on the management board of 14663023, and can they sign alone?"
- "Show the balance sheet and income statement from their 2025 annual report."
- "Which companies list Jaan Tamm as a board member?"

## Notes

- **Beneficial owners.** RIK only gives this data to requesters with a legal basis, and it logs each lookup with the requester's identity. `get_beneficial_owners` requires the requester's own name and identity-code country. The tool description tells the model to ask you for these details and never to guess them.
- **Language.** Classifier texts (statuses, roles, legal forms) default to English. Pass `language: "est"` for Estonian. Company status codes: R = registered, L = in liquidation, N = bankrupt, K = deleted.
- **Limits.** RIK allows 50 000 queries a day per contract and per key, one XML query at a time, and 20 document downloads a minute per IP. The server sends XML queries one at a time.
- **XML quirks.** The XML service rejects a request that leaves out a field it requires, even when the docs give that field a default. `xml_service_request` passes your `body` through as is, so check the query's documentation page.
- **Structured output.** Every tool declares an `outputSchema` and returns `structuredContent`, with the same JSON as text.
- **Bulk data.** For whole-register analysis, use RIK's daily [open data files](https://avaandmed.ariregister.rik.ee/en/downloading-open-data) (CC BY 4.0) instead of per-company queries.

## Development

```bash
npm install
npm run build
npx @modelcontextprotocol/inspector node dist/index.js   # interactive testing

# End-to-end smoke test against the live register. It's read-only. Tools without credentials must return
# CREDENTIALS_MISSING; set the env vars (or HAS_KEYCHAIN_REST=1 / HAS_KEYCHAIN_XML=1) to run them for real.
npm test
PROTOCOL=legacy npm test   # 2025-era protocol
```

## License

MIT
