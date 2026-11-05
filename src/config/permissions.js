export const ROLES = ["customer", "staff", "admin", "super_admin", "clinic"];
export const PANEL_ROLES = ["staff", "admin", "super_admin", "clinic"];

/** Every module a panel account can be given. The API checks these; the panel only hides what is missing. */
export const PERMISSIONS = [
  "dashboard.view",
  "bookings.manage",
  "orders.manage",
  "billing.manage",
  "customers.manage",
  "catalog.manage",
  "inventory.manage",
  "schedule.manage",
  "staff.assign",
  "reports.view",
  "settings.manage",
  "work.own",
  "clinic.view",
  "clinic.upload",
  "users.manage",
  "audit.view",
];

const ADMIN_DEFAULT = PERMISSIONS.filter((p) => !["users.manage", "audit.view", "clinic.upload", "work.own"].includes(p));

export const ROLE_DEFAULTS = {
  customer: [],
  staff: ["work.own"],
  clinic: ["clinic.view", "clinic.upload"],
  admin: ADMIN_DEFAULT,
  super_admin: PERMISSIONS,
};

/** The role's defaults with the account's own grants and revocations applied. Super admins always keep everything. */
export function effectivePermissions(user) {
  if (user.role === "super_admin") return [...PERMISSIONS];
  const set = new Set(ROLE_DEFAULTS[user.role] ?? []);
  for (const p of user.grants ?? []) set.add(p);
  for (const p of user.revokes ?? []) set.delete(p);
  return [...set];
}
