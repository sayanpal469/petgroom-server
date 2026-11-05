export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const badRequest = (m, code) => new ApiError(400, m, code ?? "bad_request");
export const unauthorized = (m = "Please log in.") => new ApiError(401, m, "unauthorized");
export const forbidden = (m = "You don't have access to this.") => new ApiError(403, m, "forbidden");
export const notFound = (m = "Not found.") => new ApiError(404, m, "not_found");
export const conflict = (m, code) => new ApiError(409, m, code ?? "conflict");
