import type { CallToolResult, McpServer, ServerContext } from "@modelcontextprotocol/server";
import * as z from "zod";
import { AriregClient, AriregError, type Language } from "./client.js";
import * as out from "./schemas.js";

type ToolResult = CallToolResult;

/** Same JSON as text (compact) and as `structuredContent` (typed by `outputSchema`). */
const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data as Record<string, unknown>,
});

const fail = (err: unknown): ToolResult => {
  if (err instanceof AriregError) {
    const error: Record<string, unknown> = { status: err.status, code: err.code, message: err.message };
    if (err.details !== undefined) error.details = err.details;
    return { content: [{ type: "text", text: JSON.stringify({ error }) }], isError: true };
  }
  return { content: [{ type: "text", text: `Error: ${(err as Error)?.message ?? String(err)}` }], isError: true };
};

const run =
  <A>(fn: (args: A, ctx: ServerContext) => Promise<unknown>) =>
  async (args: A, ctx: ServerContext): Promise<ToolResult> => {
    try {
      return ok(await fn(args, ctx));
    } catch (err) {
      return fail(err);
    }
  };

const asArray = <T>(v: T | T[] | undefined | null): T[] => (Array.isArray(v) ? v : v == null ? [] : [v]);

const companyUrl = (code: string | number) => `https://ariregister.rik.ee/eng/company/${code}`;

// ───────────────────────────── Shared input fields ─────────────────────────────

const registryCode = z
  .union([z.string().regex(/^\d{8}$/), z.number().int().min(10_000_000).max(99_999_999)])
  .describe("8-digit Estonian registry code (registrikood), e.g. 14663023. Find it with search_companies.");
const language = z
  .enum(["eng", "est"])
  .optional()
  .describe("Language of classifier texts (statuses, roles, legal forms): 'eng' (default) or 'est'.");
const onlyValid = z.boolean().optional().describe("Only current data (default true). False includes historical entries.");
const pageNumber = z.number().int().min(1).max(100_000).optional().describe("Page number (default 1).");
const pageSize = z.number().int().min(1).max(1000).optional().describe("Results per page, 1–1000 (default 100).");
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const country3 = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .describe("ISO 3166-1 alpha-3 country code, e.g. 'EST', 'FIN', 'LVA'.");
const STATUS_NOTE = "Company status codes: R = registered, L = in liquidation, N = bankrupt, K = deleted.";

const lang = (l?: Language): Language => l ?? "eng";

export function registerTools(server: McpServer, client: AriregClient): void {
  // ───────────────────────────── Public (no account) ─────────────────────────────

  server.registerTool(
    "search_companies",
    {
      title: "Search companies",
      description:
        "Find Estonian companies and other legal persons by name, part of a name, or registry code. Public, no account " +
        "needed. Returns up to 10 matches with registry code, status, legal address and the register page URL; " +
        `historical names match too. ${STATUS_NOTE}`,
      inputSchema: z.object({
        query: z.string().trim().min(2).describe("Name, name fragment or registry code, e.g. 'Arbictus' or '14663023'."),
      }),
      outputSchema: out.results,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ query }) => {
      const data = await client.autocomplete(query);
      return {
        results: data.map((c: any) => ({
          registry_code: String(c.reg_code),
          name: c.name,
          status: c.status,
          legal_address: c.legal_address,
          zip_code: c.zip_code,
          historical_names: c.historical_names,
          company_id: c.company_id,
          legal_form: c.legal_form,
          url: c.url,
        })),
      };
    }),
  );

  server.registerTool(
    "check_einvoice_recipients",
    {
      title: "Check e-invoice recipients",
      description:
        "Check whether companies are in the e-invoice recipient register, i.e. whether you can send them a machine-" +
        "readable e-invoice through an operator. Public, no account needed. Status OK = has a valid link in the " +
        "e-invoice register (operator in `service_provider`), MR = registry code not found in the e-invoice register.",
      inputSchema: z.object({
        registry_codes: z.array(registryCode).min(1).max(100).describe("1–100 registry codes."),
        include_names: z.boolean().optional().describe("Also return company names (default false)."),
        page: z.number().int().min(1).optional().describe("Result page (default 1)."),
      }),
      outputSchema: out.einvoice,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ registry_codes, include_names, page }) => {
      const keha = await client.soap(
        "earveRegistriParing_v1",
        {
          // The XML service rejects requests that leave these out, even though the docs give defaults.
          tagasta_nimed: include_names ? "TRUE" : "FALSE",
          tulemuste_lk: page ?? 1,
          registrikoodid: { registrikood: registry_codes },
        },
        { auth: false },
      );
      return {
        pages: Number(keha?.lehekylgi ?? 1),
        recipients: asArray(keha?.kliendid?.klient).map((k: any) => ({
          registry_code: String(k.registrikood),
          ...(k.nimi ? { name: k.nimi } : {}),
          status: k.staatus,
          ...(k.teenusepakkuja ? { service_provider: k.teenusepakkuja } : {}),
        })),
      };
    }),
  );

  // ───────────────────────────── REST (API key) ─────────────────────────────

  const INCLUDE = ["general", "related_persons", "commercial_pledges", "rulings", "registry_cards"] as const;

  server.registerTool(
    "get_company",
    {
      title: "Get company data",
      description:
        "Full register data for one company (REST, needs an API key). Choose blocks with `include`: general (names, " +
        "addresses, legal form, share capital, financial year, contacts, EMTAK activities, VAT number), related_persons " +
        "(board and council members, shareholders, representation rights), commercial_pledges, rulings (court registry " +
        `rulings), registry_cards (entries on the registry card). Default: general. ${STATUS_NOTE}`,
      inputSchema: z.object({
        registry_code: registryCode,
        include: z.array(z.enum(INCLUDE)).optional().describe("Data blocks to return (default ['general'])."),
        only_valid: onlyValid,
        language,
      }),
      outputSchema: out.company,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ registry_code, include, only_valid, language }) => {
      const want = new Set(include?.length ? include : ["general"]);
      const data = await client.rest(`/company/${registry_code}`, {
        language: lang(language),
        query: {
          includeGeneralData: want.has("general"),
          includeRelatedPersons: want.has("related_persons"),
          includeCommercialPledgeData: want.has("commercial_pledges"),
          includeRulings: want.has("rulings"),
          includeRegistryCards: want.has("registry_cards"),
          onlyValid: only_valid,
        },
      });
      return { company: data, url: companyUrl(registry_code) };
    }),
  );

  server.registerTool(
    "find_companies",
    {
      title: "Find companies (detailed search)",
      description:
        "Search companies with filters (REST, needs an API key): name, registry code, EMTAK activity code, location, " +
        "status, or a related person or company (e.g. every company where a person is a board member). Returns " +
        "contacts, VAT number, address, activities and the matching related persons. Paginated (see `total`). " +
        STATUS_NOTE,
      inputSchema: z.object({
        name: z.string().optional().describe("Company name."),
        registry_code: registryCode.optional(),
        activity_code: z.string().optional().describe("EMTAK activity code, e.g. '62011'."),
        person_first_name: z.string().optional(),
        person_surname: z.string().optional(),
        person_birthday: date.optional().describe("Related person's date of birth, YYYY-MM-DD."),
        identity_code: z.string().optional().describe("Related person's personal identification code."),
        identity_code_country: country3.optional(),
        person_roles: z
          .array(z.string())
          .optional()
          .describe(
            "Role codes of the related person, e.g. JUHL (management board member), JUHA (sole board member), N " +
              "(supervisory board member), O or OSAN (shareholder), S (stockholder), PROK (procurator), LIKV (liquidator), " +
              "A (founder), FIE (sole trader).",
          ),
        legal_person_name: z.string().optional().describe("Name of a related legal person (e.g. a parent company)."),
        legal_person_code: z.string().optional().describe("Registry code of a related legal person."),
        legal_person_code_country: country3.optional(),
        location: z.string().optional().describe("Location in the company address, e.g. 'Tallinn'."),
        admin_unit: z.string().optional().describe("Administrative unit (EHAK) in the company address."),
        statuses: z.array(z.enum(["R", "L", "N", "K"])).optional().describe("Only these statuses (default all)."),
        only_valid: onlyValid,
        page: pageNumber,
        page_size: pageSize,
        language,
      }),
      outputSchema: out.paged,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async (a) => {
      const data: any = await client.rest("/company/companyRelations", {
        language: lang(a.language),
        query: {
          legalEntityName: a.name,
          registryCode: a.registry_code,
          activityCode: a.activity_code,
          personFirstName: a.person_first_name,
          personSurname: a.person_surname,
          personBirthday: a.person_birthday,
          identityCode: a.identity_code,
          identityCodeCountry: a.identity_code_country,
          personRoles: a.person_roles,
          legalPersonName: a.legal_person_name,
          legalPersonCode: a.legal_person_code,
          legalPersonCodeCountry: a.legal_person_code_country,
          locationEnterpriserByAddress: a.location,
          adminUnitEnterpriserByAddress: a.admin_unit,
          statuses: a.statuses,
          onlyValid: a.only_valid,
          pageNumber: a.page,
          pageSize: a.page_size,
        },
      });
      return { total: data?.total ?? 0, list: data?.list ?? [] };
    }),
  );

  server.registerTool(
    "get_representation_rights",
    {
      title: "Get representation rights",
      description:
        "Who may represent companies, and how (REST, needs an API key): persons with their role and whether they can " +
        "act alone (`exclusiveRightOfRepresentation`), plus special conditions and joint-representation groups. Search " +
        "by a person or company (`entity_code` = personal code or registry code), or by name.",
      inputSchema: z.object({
        entity_code: z.string().optional().describe("Personal identification code or company registry code."),
        entity_code_country: country3.optional(),
        person_type: z.enum(["P", "J"]).optional().describe("P = natural person (default), J = legal person."),
        first_name: z.string().min(2).optional(),
        surname_or_company_name: z.string().min(2).optional(),
        birthday: date.optional(),
        page: pageNumber,
        page_size: pageSize,
        language,
      }),
      outputSchema: out.paged,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async (a) => {
      const data: any = await client.rest("/person/representationRights", {
        language: lang(a.language),
        query: {
          entityCode: a.entity_code,
          entityCodeCountry: a.entity_code_country,
          personType: a.person_type,
          personFirstName: a.first_name,
          surnameLegalEntityName: a.surname_or_company_name,
          personBirthday: a.birthday,
          pageNumber: a.page,
          pageSize: a.page_size,
        },
      });
      return { total: data?.total ?? 0, list: data?.list ?? [] };
    }),
  );

  server.registerTool(
    "list_annual_reports",
    {
      title: "List annual reports",
      description:
        "Annual reports filed by a company (REST, needs an API key): year, submission date, revenue, balance-sheet " +
        "total, employee count, audit status, and links to the report files (PDF, BDOC/DDOC, XBRL). For the actual " +
        "balance-sheet and income-statement lines use get_annual_report_figures.",
      inputSchema: z.object({
        registry_code: registryCode.optional(),
        year: z.number().int().min(1990).max(2100).optional().describe("Reporting year."),
        document_type: z.enum(["A", "D", "X"]).optional().describe("A = PDF, D = BDOC/DDOC, X = XBRL."),
        submitted_from: z.string().optional().describe("Submitted on or after this date-time (ISO 8601)."),
        submitted_to: z.string().optional().describe("Submitted on or before this date-time (ISO 8601)."),
        page: pageNumber,
        page_size: pageSize,
        language,
      }),
      outputSchema: out.paged,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async (a) => {
      if (!a.registry_code && !a.submitted_from) {
        throw new AriregError(400, "MISSING_FILTER", "Pass registry_code, or a submission period (submitted_from / submitted_to).");
      }
      const data: any = await client.rest("/company/documents/reports/financialYear", {
        language: lang(a.language),
        query: {
          registryCode: a.registry_code,
          reportYear: a.year,
          documentType: a.document_type,
          submissionStartDate: a.submitted_from,
          submissionEndDate: a.submitted_to,
          pageNumber: a.page,
          pageSize: a.page_size,
        },
      });
      return { total: data?.total ?? 0, list: data?.list ?? [] };
    }),
  );

  server.registerTool(
    "get_beneficial_owners",
    {
      title: "Get beneficial owners",
      description:
        "A company's beneficial owners (REST, needs an API key and a contract that grants beneficial-owner access). " +
        "This data is restricted: access needs a legal basis (e.g. a competent authority, an obliged " +
        "entity under the AML act, or a legitimate interest), and RIK logs every lookup together with the requester's " +
        "identity. The requester fields describe the PERSON MAKING THE QUERY and must be the real user's own details; " +
        "ask the user for them and never guess or fill them in from other context.",
      inputSchema: z.object({
        registry_code: registryCode,
        requester_first_name: z.string().min(1).describe("First name of the person making the query (the user)."),
        requester_last_name: z.string().min(1).describe("Last name of the person making the query."),
        requester_identity_code_country: country3.describe("Country of the requester's identity code."),
        requester_identity_code: z.string().optional().describe("Requester's personal identification code."),
        requester_birthday: date.optional().describe("Requester's date of birth, if they have no identity code."),
        query_reason: z.string().optional().describe("Why the data is needed (recorded with the lookup)."),
        connection_to_company: z.string().optional().describe("The requester's connection to the company."),
        only_valid: onlyValid,
        language,
      }),
      outputSchema: out.beneficialOwners,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async (a) => {
      const data = await client.rest(`/company/${a.registry_code}/beneficialOwners`, {
        language: lang(a.language),
        query: {
          firstName: a.requester_first_name,
          lastName: a.requester_last_name,
          identityCodeCountry: a.requester_identity_code_country,
          identityCode: a.requester_identity_code,
          birthday: a.requester_birthday,
          queryReason: a.query_reason,
          connectionToCompany: a.connection_to_company,
          onlyValid: a.only_valid,
        },
      });
      return { registry_code: String(a.registry_code), beneficial_owners: data };
    }),
  );

  server.registerTool(
    "search_trusts",
    {
      title: "Search trusts",
      description:
        "Search the register of trusts and similar arrangements (REST, needs an API key): trust name, status, country " +
        "and the people involved (trustee UH.HALDUR, settlor UH.LOOJA, beneficiary UH.SOODUST, …). Beneficial-owner " +
        "details of a trust are not requested by this tool.",
      inputSchema: z.object({
        trust_name: z.string().optional(),
        person_first_name: z.string().optional(),
        person_surname: z.string().optional(),
        person_birthday: date.optional(),
        identity_code: z.string().optional().describe("Personal identification code of a related person."),
        only_valid: onlyValid,
        page: pageNumber,
        page_size: pageSize,
        language,
      }),
      outputSchema: out.paged,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async (a) => {
      const data: any = await client.rest("/person/trustManagement", {
        language: lang(a.language),
        query: {
          trustManagementName: a.trust_name,
          personFirstName: a.person_first_name,
          personSurname: a.person_surname,
          personBirthday: a.person_birthday,
          identityCode: a.identity_code,
          includeBeneficialOwners: false,
          onlyValid: a.only_valid,
          pageNumber: a.page,
          pageSize: a.page_size,
        },
      });
      return { total: data?.total ?? 0, list: data?.list ?? [] };
    }),
  );

  // ───────────────────────────── SOAP (contract username + password) ─────────────────────────────

  const fetchFigures = async (registry_code: string | number, year: number, code: string, keel: Language) => {
    const keha = await client.soap("majandusaastaAruanneteKirjed_v1", {
      ariregistri_kood: registry_code,
      aruande_liik: code,
      aruandeaasta: year,
      keel,
    });
    return {
      report_code: keha?.aruande_liik ?? code,
      report_name: keha?.aruande_nimetus,
      period_start: keha?.majandusaasta_algus,
      period_end: keha?.majandusaasta_lopp,
      lines: asArray(keha?.majandusaasta_aruanded_read).map((r: any) => ({
        line: Number(r.rea_nr),
        name: r.rea_nimetus,
        values: Object.fromEntries(
          asArray(r.majandusaasta_aruanded_veerud).map((c: any) => [c.veeru_nimetus || c.veeru_kood, c.vaartus === "" ? null : Number(c.vaartus)]),
        ),
      })),
    };
  };

  server.registerTool(
    "get_annual_report_figures",
    {
      title: "Get annual report figures",
      description:
        "Line items of a company's annual report: balance sheet, income statement, cash flow and so on, with this " +
        "year's and the previous year's values (XML service, needs contract username and password). Without `year` " +
        "it lists the available reports (year, report code, name). With `year` and no `report_code` it returns every " +
        "report for that year (one query each); pass `report_code` (from the list) for just one.",
      inputSchema: z.object({
        registry_code: registryCode,
        year: z.number().int().min(1990).max(2100).optional().describe("Reporting year."),
        report_code: z.string().optional().describe("Report code from the list, e.g. '01' (balance sheet)."),
        language,
      }),
      outputSchema: out.reportFigures,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ registry_code, year, report_code, language }) => {
      const keel = lang(language);
      if (year !== undefined && report_code) {
        return { registry_code: String(registry_code), year, reports: [await fetchFigures(registry_code, year, report_code, keel)] };
      }
      const list = await client.soap("majandusaastaAruanneteLoetelu_v1", { ariregistri_kood: registry_code });
      const available = asArray(list?.majandusaasta_aruanded).map((r: any) => ({
        year: Number(r.aruande_aasta),
        report_code: r.aruande_kood,
        report_name: r.aruande_nimetus,
        period_start: r.majandusaasta_algus,
        period_end: r.majandusaasta_lopp,
      }));
      if (year === undefined) return { registry_code: String(registry_code), available };
      const codes = [...new Set(available.filter((r) => r.year === year).map((r) => r.report_code))];
      if (!codes.length) {
        return { registry_code: String(registry_code), year, reports: [], message: `No report data for ${year}.`, available };
      }
      const reports = [];
      for (const code of codes.slice(0, 10)) reports.push(await fetchFigures(registry_code, year, code, keel));
      return { registry_code: String(registry_code), year, reports };
    }),
  );

  server.registerTool(
    "list_company_documents",
    {
      title: "List company documents",
      description:
        "Documents in a company's public file (XML service, needs contract username and password): annual reports as " +
        "PDF, BDOC/DDOC and XBRL, and articles of association, with their e-Business Register URLs (opening one " +
        "needs a login there; this tool never requests the paid access token that would buy the document). Document types: A = annual report " +
        "PDF, D = BDOC/DDOC, X = XBRL, P = articles of association. Report types: A = annual, V = interim, L = " +
        "liquidation, P = final.",
      inputSchema: z.object({
        registry_code: registryCode,
        year: z.number().int().min(1990).max(2100).optional().describe("Reporting year."),
        document_type: z.enum(["A", "D", "X", "P"]).optional(),
        valid: z.enum(["K", "A"]).optional().describe("K = valid, A = expired."),
        page: z.number().int().min(1).optional(),
        language,
      }),
      outputSchema: out.documents,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ registry_code, year, document_type, valid, page, language }) => {
      const keha = await client.soap("ettevotjaDokumentideLoetelu_v1", {
        ariregistri_kood: registry_code,
        lehekylg: page ?? 1,
        aruandeaasta: year,
        dokumendi_liik: document_type,
        dokumendi_kehtivus: valid,
        keel: lang(language),
      });
      return {
        pages: keha?.lehekylgede_arv !== undefined ? Number(keha.lehekylgede_arv) : undefined,
        documents: asArray(keha?.ettevotja_dokumendid).map((d: any) => ({
          id: d.dokumendi_id,
          name: d.dokumendi_nimetus,
          type: d.dokumendi_liik,
          report_type: d.aruande_liik,
          year: d.aruandeaasta !== undefined ? Number(d.aruandeaasta) : undefined,
          size: d.dokumendi_suurus !== undefined ? Number(d.dokumendi_suurus) : undefined,
          status_date: d.dokumendi_seisu_kuupaev,
          valid: d.dokumendi_kehtivus,
          url: d.dokumendi_url,
        })),
      };
    }),
  );

  server.registerTool(
    "get_classifier",
    {
      title: "Get classifier",
      description:
        "Code lists used by the register (XML service, needs contract username and password), e.g. OIGVORMID (legal " +
        "forms), EVSTAATUSED (company statuses), ISIKROLLID (person roles), RIIGID (countries), SIDEVAH (contact types), " +
        "VALUUTAD (currencies). Use it to decode codes returned by the other tools.",
      inputSchema: z.object({
        classifier: z.string().regex(/^[A-Z_0-9]+$/).describe("Classifier code, e.g. 'OIGVORMID'."),
        language,
      }),
      outputSchema: out.classifiers,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ classifier, language }) => {
      const keha = await client.soap("klassifikaatorid_v1", { klassifikaator: classifier, keel: lang(language) });
      return {
        classifiers: asArray(keha?.klassifikaator).map((k: any) => ({
          code: k.klassifikaatori_kood,
          name: k.klassifikaatori_nimetus,
          values: asArray(k.klassifikaatori_vaartused?.klassifikaatori_vaartus).map((v: any) => ({
            code: v.klassifikaatori_vaartuse_kood,
            name: v.klassifikaatori_vaartuse_nimetus,
            ...(v.klassifikaatori_vaartuse_algus_kpv ? { valid_from: v.klassifikaatori_vaartuse_algus_kpv } : {}),
            ...(v.klassifikaatori_vaartuse_lopp_kpv ? { valid_to: v.klassifikaatori_vaartuse_lopp_kpv } : {}),
          })),
        })),
      };
    }),
  );

  server.registerTool(
    "xml_service_request",
    {
      title: "Call an XML service query",
      description:
        "Call any e-Business Register XML (SOAP) query that has no dedicated tool, e.g. ettevotjaMuudatusedTasuline_v1 " +
        "(companies changed on a date), kandedMaarused_v1 (entries and rulings for a day), aruandeMyygituluEMTAKjargi_v1 " +
        "(revenue by activity), detailandmed_v2. Your contract username and password are added automatically. `body` " +
        "holds the fields of `keha` as JSON: arrays repeat an element, objects nest. Field names and required fields are " +
        "in the per-query docs at https://avaandmed.ariregister.rik.ee/en/open-data-api/introduction-api-services; send " +
        "them in the order the docs list them. The " +
        "service rejects a request that leaves out a field it requires, even one with a documented default. The " +
        "response is the `keha` element as JSON with all values as text.",
      inputSchema: z.object({
        operation: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*_v\d+$/).describe("Query name, e.g. 'ettevotjaMuudatusedTasuline_v1'."),
        body: z.record(z.string(), z.unknown()).describe("Fields of the request `keha`, e.g. {\"kuupaev\": \"2026-11-06\", \"tulemuste_lk\": 1}."),
      }),
      outputSchema: out.xmlResponse,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    run(async ({ operation, body }) => {
      const { ariregister_kasutajanimi: _u, ariregister_parool: _p, ...rest } = body;
      return { operation, response: await client.soap(operation, rest) };
    }),
  );
}
