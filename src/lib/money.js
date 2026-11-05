const round2 = (n) => Math.round(n * 100) / 100;

/**
 * BRD §7.2: discount is applied before tax, GST is split equally into CGST + SGST
 * per item rate, and the total is rounded to the rupee. Same maths as the panel's
 * lib/invoice.ts, so the screen and the saved bill always agree.
 */
export function billTotals(bill) {
  const subtotal = round2(bill.items.reduce((s, i) => s + i.price * i.qty, 0));
  const pct = subtotal * ((bill.discountPercent ?? 0) / 100);
  const discount = round2(Math.min(subtotal, pct + (bill.discountFlat ?? 0)));
  const factor = subtotal ? (subtotal - discount) / subtotal : 0;
  const taxable = round2(subtotal - discount);
  const gst = bill.items.reduce((s, i) => s + (i.price * i.qty * factor * (bill.gstEnabled ? i.gstRate : 0)) / 100, 0);
  const cgst = round2(gst / 2);
  const sgst = round2(gst / 2);
  const exact = taxable + cgst + sgst;
  const total = Math.round(exact);
  const paid = round2((bill.payments ?? []).reduce((s, p) => s + p.amount, 0));
  return { subtotal, discount, taxable, cgst, sgst, roundOff: round2(total - exact), total, paid, due: Math.max(0, round2(total - paid)) };
}

export function statusFromPayments(total, paid) {
  if (paid <= 0) return "unpaid";
  if (paid + 0.005 < total) return "partly_paid";
  return "paid";
}
