import PDFDocument from "pdfkit";
import { billTotals } from "./money.js";

const clock = (m) => {
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
// PDF base fonts have no rupee glyph.
const rs = (n) => `Rs. ${Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (d) => new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

function render(build) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 48 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    build(doc);
    doc.end();
  });
}

function header(doc, settings, title) {
  doc.rect(0, 0, doc.page.width, 92).fill("#FFC814");
  doc.fill("#1A1A1A").font("Helvetica-Bold").fontSize(22).text(settings.storeName, 48, 26);
  doc.font("Helvetica").fontSize(10).text(settings.tagline, 48, 54);
  doc.font("Helvetica-Bold").fontSize(14).text(title, 48, 34, { align: "right", width: doc.page.width - 96 });
  doc.fill("#2B2B2B").font("Helvetica").fontSize(10).text(`${settings.address}  |  ${settings.phone}`, 48, 108);
  if (settings.gstEnabled && settings.gstin) doc.text(`GSTIN: ${settings.gstin}`);
  doc.moveDown(1.2);
}

function rows(doc, list) {
  for (const [k, v] of list) {
    const y = doc.y;
    doc.font("Helvetica").fillColor("#6B6B6B").text(k, 48, y, { width: 150 });
    doc.font("Helvetica-Bold").fillColor("#1A1A1A").text(String(v ?? "-"), 200, y, { width: doc.page.width - 248 });
    doc.moveDown(0.45);
  }
  doc.font("Helvetica").fillColor("#2B2B2B");
}

const heading = (doc, text) => {
  doc.moveDown(0.6);
  doc.font("Helvetica-Bold").fontSize(12).fillColor("#1A1A1A").text(text, 48);
  doc.moveDown(0.4);
  doc.fontSize(10);
};

export const bookingSlip = ({ booking, customer, pet, groomer, settings }) =>
  render((doc) => {
    header(doc, settings, "BOOKING SLIP");
    heading(doc, "Appointment");
    rows(doc, [
      ["Booking ID", `#${booking.bookingNo}`],
      ["Date", day(booking.date)],
      ["Time", clock(booking.start)],
      ["Duration", `${booking.duration} min`],
      ["Status", booking.status.replaceAll("_", " ")],
      ["Groomer", groomer?.name ?? "Any available"],
    ]);
    heading(doc, "Customer");
    rows(doc, [
      ["Name", customer.name],
      ["Phone", customer.phone],
    ]);
    heading(doc, "Pet");
    rows(doc, [
      ["Name", pet?.name],
      ["Type / Breed", [pet?.type, pet?.breed].filter(Boolean).join(" / ")],
      ["Age", pet?.age],
    ]);
    heading(doc, "Services");
    rows(doc, [...booking.serviceNames.map((n, i) => [`${i + 1}.`, n]), ["Estimated total", rs(booking.estimate)]]);
    doc.moveDown(1).font("Helvetica").fillColor("#6B6B6B").text("No advance payment. Pay at the store after the service. The final price is set at billing.", 48);
  });

export const invoicePdf = ({ invoice, settings }) =>
  render((doc) => {
    const t = billTotals(invoice);
    header(doc, settings, invoice.status === "cancelled" ? "CANCELLED BILL" : settings.gstEnabled ? "TAX INVOICE" : "RECEIPT");
    rows(doc, [
      ["Bill no.", `#${invoice.invoiceNo}`],
      ["Date", day(invoice.date)],
      ["Customer", invoice.customerName],
      ["Phone", invoice.customerPhone],
      ...(invoice.petName ? [["Pet", invoice.petName]] : []),
    ]);
    heading(doc, "Items");
    const col = [48, 300, 345, 420];
    const y0 = doc.y;
    doc.font("Helvetica-Bold").text("Item", col[0], y0).text("Qty", col[1], y0).text("Rate", col[2], y0).text("Amount", col[3], y0);
    doc.moveDown(0.5).font("Helvetica");
    for (const i of invoice.items) {
      const y = doc.y;
      doc.text(`${i.name}${i.code ? ` (${i.code})` : ""}`, col[0], y, { width: 245 });
      const after = doc.y;
      doc.text(String(i.qty), col[1], y).text(rs(i.price), col[2], y).text(rs(i.price * i.qty), col[3], y);
      doc.y = Math.max(after, doc.y);
      doc.moveDown(0.3);
    }
    doc.moveDown(0.6);
    rows(doc, [
      ["Subtotal", rs(t.subtotal)],
      ...(t.discount ? [[invoice.discountLabel ?? "Discount", `- ${rs(t.discount)}`]] : []),
      ["Taxable amount", rs(t.taxable)],
      ...(invoice.gstEnabled ? [["CGST", rs(t.cgst)], ["SGST", rs(t.sgst)]] : []),
      ["Round off", rs(t.roundOff)],
      ["Total", rs(t.total)],
      ["Paid", rs(t.paid)],
      ["Due", rs(t.due)],
      ["Payment", invoice.payments.map((p) => `${p.mode} ${rs(p.amount)}`).join(", ") || "Unpaid"],
    ]);
  });
