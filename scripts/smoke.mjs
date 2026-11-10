// End-to-end smoke test: spawns the built server over stdio with the official MCP client and calls the tools against
// the live e-Business Register. Public tools always run. REST tools run when ARIREGISTER_API_KEY is set (or a Keychain
// entry exists), XML tools when ARIREGISTER_USERNAME / ARIREGISTER_PASSWORD are set; otherwise they must fail with
// CREDENTIALS_MISSING. Everything is read-only. Set SKIP_KEYCHAIN=1 to test the no-credentials path on a Mac that has them.
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const env = { ...process.env };
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], env, stderr: "inherit" });
const modern = process.env.PROTOCOL !== "legacy";
const client = new Client(
  { name: "ariregister-smoke", version: "0.0.0" },
  modern ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
);
await client.connect(transport);

let failures = 0;
const call = async (name, args = {}, { expectError = false, expectCode } = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  let good = expectError ? res.isError : !res.isError;
  if (good && expectCode) good = text.includes(expectCode);
  if (!good) failures++;
  console.log(`${good ? "PASS" : "FAIL"} ${name} ${JSON.stringify(args)} -> ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  return text;
};

console.log("protocol:", client.getNegotiatedProtocolVersion(), "server:", JSON.stringify(client.getServerVersion()));
const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).join(", "));

// Public
const { results } = JSON.parse(await call("search_companies", { query: "Arbictus" }));
const code = results.find((r) => r.registry_code === "14663023") ? "14663023" : results[0]?.registry_code;
if (!code) failures++;
await call("search_companies", { query: "70000310" }); // RIK itself
await call("check_einvoice_recipients", { registry_codes: [code, 70000310], include_names: true });
await call("check_einvoice_recipients", { registry_codes: ["123"] }, { expectError: true });

const authed = (missing) => (missing ? { expectError: true, expectCode: "CREDENTIALS_MISSING" } : {});
const noRest = !process.env.ARIREGISTER_API_KEY && process.env.HAS_KEYCHAIN_REST !== "1";
const noSoap = !(process.env.ARIREGISTER_USERNAME && process.env.ARIREGISTER_PASSWORD) && process.env.HAS_KEYCHAIN_XML !== "1";

// REST
await call("get_company", { registry_code: code, include: ["general", "related_persons"] }, authed(noRest));
await call("find_companies", { name: "Arbictus", page_size: 2 }, authed(noRest));
await call("get_representation_rights", { entity_code: code, entity_code_country: "EST", person_type: "J", page_size: 2 }, authed(noRest));
await call("list_annual_reports", { registry_code: code, page_size: 3 }, authed(noRest));
await call("search_trusts", { trust_name: "fond", page_size: 2 }, authed(noRest));

// XML
const figs = await call("get_annual_report_figures", { registry_code: code }, authed(noSoap));
if (!noSoap) {
  const year = JSON.parse(figs).available?.[0]?.year;
  if (year) await call("get_annual_report_figures", { registry_code: code, year });
}
await call("list_company_documents", { registry_code: code, document_type: "A" }, authed(noSoap));
await call("get_classifier", { classifier: "EVSTAATUSED" }, authed(noSoap));
await call("xml_service_request", { operation: "lihtandmed_v2", body: { ariregistri_kood: code } }, authed(noSoap));

await client.close();
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
