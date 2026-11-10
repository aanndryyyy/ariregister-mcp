/**
 * Output schemas (`outputSchema`) for every tool. Register data is large and varies by company, so objects are
 * `looseObject`: the fields a model relies on are typed and everything else passes through unchanged.
 */
import * as z from "zod";

const item = z.looseObject({});

export const results = z.looseObject({
  results: z.array(
    z.looseObject({
      registry_code: z.string(),
      name: z.string(),
      status: z.string().optional(),
      url: z.string().optional(),
    }),
  ),
});

export const einvoice = z.looseObject({
  pages: z.number(),
  recipients: z.array(z.looseObject({ registry_code: z.string(), status: z.string(), name: z.string().optional() })),
});

export const company = z.looseObject({ company: item.nullable(), url: z.string() });

export const paged = z.looseObject({ total: z.number(), list: z.array(item) });

export const beneficialOwners = z.looseObject({ registry_code: z.string(), beneficial_owners: item.nullable() });

const figures = z.looseObject({
  report_code: z.string().optional(),
  report_name: z.string().optional(),
  lines: z.array(z.looseObject({ line: z.number(), name: z.string().optional(), values: z.record(z.string(), z.number().nullable()) })),
});

export const reportFigures = z.looseObject({
  registry_code: z.string(),
  year: z.number().optional(),
  available: z.array(item).optional(),
  reports: z.array(figures).optional(),
  message: z.string().optional(),
});

export const documents = z.looseObject({ pages: z.number().optional(), documents: z.array(item) });

export const classifiers = z.looseObject({
  classifiers: z.array(z.looseObject({ code: z.string(), name: z.string().optional(), values: z.array(item) })),
});

export const xmlResponse = z.looseObject({ operation: z.string(), response: z.unknown() });
