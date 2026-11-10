/**
 * HTTP clients for the Estonian e-Business Register (Äriregister, RIK). Three surfaces:
 *
 * - Public, no account: the autocomplete JSON API (ariregister.rik.ee/est/api/autocomplete) and the SOAP
 *   e-invoice recipient query (earveRegistriParing_v1), which the XML service answers without credentials.
 * - REST (ar-rest.rik.ee, OpenAPI at /openapi.json): needs an API key created under an RIK API contract.
 *   GET /keyLogin/ with an `apiKey` header returns a bearer token that the other endpoints take.
 * - SOAP/XML (ariregxmlv6.rik.ee): the same contract, but a username and password sent inside the SOAP body.
 *   Used only for queries the REST API doesn't cover (annual report line items, document list, classifiers).
 *
 * Credentials come from the environment or, on macOS, from the Keychain, so they never have to be written into an
 * MCP client config file.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { XMLParser } from "fast-xml-parser";

const execFileAsync = promisify(execFile);

export const PUBLIC_BASE_URL = "https://ariregister.rik.ee";
export const REST_BASE_URL = "https://ar-rest.rik.ee";
export const SOAP_URL = "https://ariregxmlv6.rik.ee/";
export const REST_KEYCHAIN_SERVICE = "ariregister-api-key";
export const SOAP_KEYCHAIN_SERVICE = "ariregister-xml";
const CONTRACT_URL = "https://ariregister.rik.ee/eng/contract";
const API_KEY_HOWTO = "https://abiinfo.rik.ee/en/e-business-register-queries/xml-service-api/adding-api-keys-rest-services";
const SOAP_NS = "http://arireg.x-road.eu/producer/";

export class AriregError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AriregError";
  }
}

export type Query = Record<string, string | number | boolean | (string | number)[] | undefined | null>;
export type Language = "est" | "eng";

export interface AriregClientOptions {
  apiKey?: string;
  username?: string;
  password?: string;
  restBaseUrl?: string;
  soapUrl?: string;
  userAgent?: string;
}

const keychain = async (service: string): Promise<{ account?: string; secret: string } | undefined> => {
  if (process.platform !== "darwin") return undefined;
  try {
    const [{ stdout: secret }, { stdout: attrs }] = await Promise.all([
      execFileAsync("security", ["find-generic-password", "-s", service, "-w"]),
      execFileAsync("security", ["find-generic-password", "-s", service]),
    ]);
    if (!secret.trim()) return undefined;
    return { account: attrs.match(/"acct"<blob>="(.*)"/)?.[1], secret: secret.trim() };
  } catch {
    return undefined;
  }
};

const fetchOrThrow = async (url: URL | string, init: RequestInit): Promise<Response> => {
  try {
    return await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000), ...init });
  } catch (err) {
    throw new AriregError(0, "NETWORK_ERROR", `Could not reach ${new URL(url).origin}: ${(err as Error).message}`);
  }
};

const parseJson = (text: string): any => {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const xmlEscape = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Element names that repeat in SOAP responses: always parse them as arrays, even when there is one. */
const LIST_TAGS = new Set([
  "klient",
  "item",
  "majandusaasta_aruanded",
  "majandusaasta_aruanded_read",
  "majandusaasta_aruanded_veerud",
  "ettevotja_dokumendid",
  "klassifikaator",
  "klassifikaatori_vaartus",
  "registrikood",
]);

const xml = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  // Keep values as text: codes like "01" or registry codes must not turn into numbers.
  parseTagValue: false,
  isArray: (name) => LIST_TAGS.has(name),
});

/** A plain JSON value as SOAP body elements: arrays repeat the element, objects nest, null/undefined are skipped. */
const toXml = (name: string, value: unknown): string => {
  if (value === undefined || value === null) return "";
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(name)) throw new AriregError(400, "INVALID_FIELD", `Invalid element name: ${name}`);
  if (Array.isArray(value)) return value.map((v) => toXml(name, v)).join("");
  if (typeof value === "object") {
    return `<prod:${name}>${Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => toXml(k, v))
      .join("")}</prod:${name}>`;
  }
  return `<prod:${name}>${xmlEscape(String(value))}</prod:${name}>`;
};

export class AriregClient {
  private readonly restBaseUrl: string;
  private readonly restOrigin: string;
  private readonly soapUrl: string;
  private readonly userAgent: string;
  private readonly envApiKey?: string;
  private readonly envSoap?: { username: string; password: string };
  private apiKey?: Promise<{ key: string; source: string }>;
  private soapCreds?: Promise<{ username: string; password: string; source: string }>;
  private token?: Promise<string>;
  /** RIK allows one simultaneous SOAP query per contract partner, so SOAP calls run one at a time. */
  private soapQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: AriregClientOptions = {}) {
    this.restBaseUrl = (opts.restBaseUrl || REST_BASE_URL).replace(/\/+$/, "");
    this.restOrigin = new URL(this.restBaseUrl).origin;
    this.soapUrl = opts.soapUrl || SOAP_URL;
    this.userAgent = opts.userAgent ?? "ariregister-mcp";
    if (opts.apiKey?.trim()) this.envApiKey = opts.apiKey.trim();
    if (opts.username?.trim() && opts.password) this.envSoap = { username: opts.username.trim(), password: opts.password };
  }

  // ───────────────────────────── Credentials ─────────────────────────────

  restCredentials(): Promise<{ key: string; source: string }> {
    if (this.envApiKey) return Promise.resolve({ key: this.envApiKey, source: "env" });
    this.apiKey ??= keychain(REST_KEYCHAIN_SERVICE).then((k) => {
      if (k) return { key: k.secret, source: "keychain" };
      this.apiKey = undefined; // retry on the next call, e.g. after the user adds the key
      throw new AriregError(
        401,
        "CREDENTIALS_MISSING",
        "This tool needs an e-Business Register REST API key. Sign the API contract at " +
          `${CONTRACT_URL} (free when it covers only the API services), create a key (${API_KEY_HOWTO}), then set ` +
          `ARIREGISTER_API_KEY in your MCP client config or, on macOS, run: security add-generic-password -U -s ` +
          `${REST_KEYCHAIN_SERVICE} -a api-key -w`,
      );
    });
    return this.apiKey;
  }

  soapCredentials(): Promise<{ username: string; password: string; source: string }> {
    if (this.envSoap) return Promise.resolve({ ...this.envSoap, source: "env" });
    this.soapCreds ??= keychain(SOAP_KEYCHAIN_SERVICE).then((k) => {
      if (k?.account) return { username: k.account, password: k.secret, source: "keychain" };
      this.soapCreds = undefined;
      throw new AriregError(
        401,
        "CREDENTIALS_MISSING",
        "This tool needs e-Business Register XML service credentials (the username and password of your RIK API " +
          `contract, ${CONTRACT_URL}). Set ARIREGISTER_USERNAME and ARIREGISTER_PASSWORD in your MCP client config or, ` +
          `on macOS, run: security add-generic-password -U -s ${SOAP_KEYCHAIN_SERVICE} -a <username> -w`,
      );
    });
    return this.soapCreds;
  }

  /** Which credentials are configured, without revealing them. */
  async credentialStatus(): Promise<{ rest: string | null; soap: string | null }> {
    const [rest, soap] = await Promise.allSettled([this.restCredentials(), this.soapCredentials()]);
    return {
      rest: rest.status === "fulfilled" ? rest.value.source : null,
      soap: soap.status === "fulfilled" ? soap.value.source : null,
    };
  }

  // ───────────────────────────── Public JSON ─────────────────────────────

  async autocomplete(q: string): Promise<any[]> {
    const url = new URL(`${PUBLIC_BASE_URL}/est/api/autocomplete`);
    url.searchParams.set("q", q);
    const res = await fetchOrThrow(url, { headers: { Accept: "application/json", "User-Agent": this.userAgent } });
    const text = await res.text();
    const json = parseJson(text);
    if (!res.ok) throw new AriregError(res.status, `HTTP_${res.status}`, text.slice(0, 300) || res.statusText);
    if (json?.status && json.status !== "OK") throw new AriregError(502, "AUTOCOMPLETE_ERROR", JSON.stringify(json).slice(0, 300));
    return Array.isArray(json?.data) ? json.data : [];
  }

  // ───────────────────────────── REST ─────────────────────────────

  private login(): Promise<string> {
    this.token ??= (async () => {
      const { key } = await this.restCredentials();
      const res = await fetchOrThrow(`${this.restBaseUrl}/keyLogin/`, {
        headers: { Accept: "application/json", apiKey: key, "User-Agent": this.userAgent },
      });
      const json = parseJson(await res.text());
      if (!res.ok || typeof json?.access_token !== "string") {
        throw new AriregError(
          res.status === 404 ? 401 : res.status,
          json?.code ? String(json.code) : "LOGIN_FAILED",
          `API key login failed (HTTP ${res.status}${json?.message ? `: ${json.message}` : ""}). Check ARIREGISTER_API_KEY.`,
        );
      }
      return json.access_token as string;
    })().catch((err) => {
      this.token = undefined;
      throw err;
    });
    return this.token;
  }

  /** Build a REST URL from a path, refusing anything that would leave the API origin. */
  private restUrl(path: string, query?: Query): URL {
    if (!path.startsWith("/") || path.startsWith("//") || /\.\.|[\\#\s]/.test(path)) {
      throw new AriregError(400, "INVALID_PATH", `Invalid API path: ${path}`);
    }
    const url = new URL(this.restBaseUrl + path);
    if (url.origin !== this.restOrigin) throw new AriregError(400, "INVALID_PATH", `Path escapes the API: ${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
      else url.searchParams.set(k, String(v));
    }
    return url;
  }

  /** GET a REST endpoint. Returns `null` for 204 (no data). */
  async rest<T = any>(path: string, { query, language = "eng" }: { query?: Query; language?: Language } = {}): Promise<T | null> {
    const url = this.restUrl(path, query);
    for (let attempt = 0; ; attempt++) {
      const token = await this.login();
      const res = await fetchOrThrow(url, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          apiVersion: "V1",
          acceptLanguage: language,
          "User-Agent": this.userAgent,
        },
      });
      // The token may have expired: log in again once.
      if (res.status === 401 && attempt === 0) {
        this.token = undefined;
        continue;
      }
      if (res.status === 204) return null;
      const text = await res.text();
      const json = parseJson(text);
      if (!res.ok) {
        let msg: string =
          (typeof json?.message === "string" && json.message) ||
          (typeof json?.detail === "string" && json.detail) ||
          text.slice(0, 500) ||
          res.statusText;
        if (res.status === 422 && Array.isArray(json?.detail)) {
          msg = `Validation failed: ${json.detail.map((d: any) => `${(d.loc ?? []).join(".")}: ${d.msg}`).join("; ")}`;
        }
        if (res.status === 403) msg += " (your contract or API key has no access to this service)";
        if (res.status === 429) msg += " (rate limited: 50 000 requests/day per contract and per key)";
        throw new AriregError(res.status, json?.code ? String(json.code) : `HTTP_${res.status}`, msg);
      }
      return (json ?? null) as T;
    }
  }

  // ───────────────────────────── SOAP ─────────────────────────────

  /**
   * Call a SOAP operation and return its response `keha` as plain JSON (namespace prefixes stripped, values as text).
   * `body` becomes the `<prod:keha>` children. With `auth`, the contract username and password are added.
   */
  soap(operation: string, body: Record<string, unknown>, { auth = true }: { auth?: boolean } = {}): Promise<any> {
    const run = async () => {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(operation)) throw new AriregError(400, "INVALID_OPERATION", `Invalid operation: ${operation}`);
      const creds = auth ? await this.soapCredentials() : undefined;
      const keha = {
        ...(creds ? { ariregister_kasutajanimi: creds.username, ariregister_parool: creds.password } : {}),
        ...body,
      };
      const envelope =
        `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
        `xmlns:prod="${SOAP_NS}"><soapenv:Body><prod:${operation}>${toXml("keha", keha)}</prod:${operation}></soapenv:Body></soapenv:Envelope>`;
      const res = await fetchOrThrow(this.soapUrl, {
        method: "POST",
        headers: { "Content-Type": "text/xml; charset=utf-8", Accept: "text/xml", "User-Agent": this.userAgent },
        body: envelope,
      });
      const text = await res.text();
      let doc: any;
      try {
        doc = xml.parse(text);
      } catch {
        throw new AriregError(res.status || 502, "BAD_RESPONSE", `Unreadable SOAP response: ${text.slice(0, 300)}`);
      }
      const soapBody = doc?.Envelope?.Body;
      const fault = soapBody?.Fault;
      if (fault) {
        const msg = String(fault.faultstring ?? "SOAP fault").replace(/ariregister_parool[^<]*/g, "ariregister_parool");
        const authFault = /kasutajanimi|parool|sessioon|autent|authent|password|user/i.test(msg);
        throw new AriregError(authFault ? 401 : 400, authFault ? "AUTH_FAILED" : "SOAP_FAULT", msg, fault.detail || undefined);
      }
      if (!res.ok || !soapBody) throw new AriregError(res.status || 502, `HTTP_${res.status}`, text.slice(0, 300));
      const response = soapBody[`${operation}Response`];
      if (!response) throw new AriregError(502, "BAD_RESPONSE", `No ${operation}Response in the SOAP answer.`);
      return response.keha ?? null;
    };
    const next = this.soapQueue.then(run, run);
    this.soapQueue = next.catch(() => undefined);
    return next;
  }
}
