import { z } from "zod";
import { ApiError } from "../lib/errors.js";

export const objectId = z.string().regex(/^[0-9a-f]{24}$/i, "Invalid id");
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
export const minutes = z.number().int().min(0).max(1439);
export const text = (max = 200) => z.string().trim().max(max);
export const phone10 = z.string().regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit mobile number");
export const anyPhone = z.string().regex(/^\d{10}$/, "Enter a valid 10-digit mobile number");
export const idParams = z.strictObject({ id: objectId });

/** Schemas are strict objects, so an unknown field (role, noShowCount, ...) is an error and never reaches a model. */
export const validate = (schemas) => (req, _res, next) => {
  for (const part of ["body", "query", "params"]) {
    if (!schemas[part]) continue;
    const r = schemas[part].safeParse(req[part]);
    if (!r.success) {
      const issue = r.error.issues[0];
      const where = issue?.path?.join(".");
      return next(new ApiError(400, issue?.message && where ? `${where}: ${issue.message}` : "Invalid input.", "invalid_input"));
    }
    req.valid ??= {};
    req.valid[part] = r.data;
  }
  next();
};
