export const ROLES = ["customer", "staff", "admin", "super_admin", "clinic", "driver", "accountant"];
export const PANEL_ROLES = ["staff", "admin", "super_admin", "clinic", "driver", "accountant"];

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
  "attendance.own",
  "attendance.manage",
  "pickdrop.manage",
  "pickdrop.own",
  "gst.view",
];

const ADMIN_DEFAULT = PERMISSIONS.filter((p) => !["users.manage", "audit.view", "clinic.upload", "work.own", "pickdrop.own"].includes(p));

export const ROLE_DEFAULTS = {
  customer: [],
  staff: ["work.own", "attendance.own"],
  clinic: ["clinic.view", "clinic.upload"],
  driver: ["pickdrop.own", "attendance.own"],
  // The store's CA: read-only bills and GST reports for filing returns.
  accountant: ["gst.view"],
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
