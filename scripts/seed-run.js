import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mongoose from "mongoose";
import sharp from "sharp";
import { hashPassword, randomToken } from "../src/lib/crypto.js";
import { CLINIC_BUCKET, storePrescription, storePublicImage } from "../src/lib/media.js";
import { DEFAULT_SETTINGS, addDaysISO, saveSettings, storeInstant, storeNow, weekday } from "../src/lib/misc.js";
import { billTotals, statusFromPayments } from "../src/lib/money.js";
import { saveSmsConfig } from "../src/lib/sms.js";
import { stepsFor } from "../src/lib/slots.js";
import { ean13 } from "../src/routes/panelCatalog.js";
import * as m from "../src/models/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(fs.readFileSync(path.join(here, "catalog.json"), "utf8"));
const PRODUCT_PHOTOS = JSON.parse(fs.readFileSync(path.join(here, "../seed-assets/products/map.json"), "utf8"));

/** Same data on every run, so a reseed gives the same demo. */
function rng(seed) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CUSTOMERS = [
  ["Riya Sen", "9876543210", "riya.sen@gmail.com", "123 Park Street", "Barasat", "700124"],
  ["Ananya Mukherjee", "9830022114", "ananya.m@gmail.com", "8 Lake View Road", "Madhyamgram", "700129"],
  ["Sourav Banerjee", "9051033221", null, "22 Station Road", "Barasat", "700124"],
  ["Priyanka Roy", "8335044102", "priyanka.roy@yahoo.com", "5B Jessore Road", "Barasat", "700126"],
  ["Rahul Chatterjee", "9748055190", null, "14 Canal Street", "Dum Dum", "700125"],
  ["Sneha Das", "6290066871", "sneha.das@outlook.com", "61 College Para", "Barasat", "700124"],
  ["Arindam Ghosh", "9874270034", null, "3 Netaji Sarani", "Madhyamgram", "700129"],
  ["Moumita Paul", "7003181245", null, "18 Kazipara Road", "Barasat", "700126"],
  ["Debjit Saha", "9674591356", null, "9 Banamali Road", "Dum Dum", "700125"],
  ["Tanushree Dey", "8981012467", "tanu.dey@gmail.com", "27 Hospital Road", "Barasat", "700124"],
  ["Kunal Bose", "9433023578", null, "2 Rabindra Pally", "Madhyamgram", "700129"],
  ["Pooja Agarwal", "9804034689", "pooja.ag@gmail.com", "40 VIP Road", "Kolkata", "700049"],
  ["Subhajit Mondal", "7384045790", null, "11 Green Park", "Barasat", "700124"],
  ["Ishita Kar", "9163056801", null, "6 School Lane", "Barasat", "700126"],
  ["Demo Customer", "1234567890", "demo@pawsstation.in", "1 Demo Street", "Barasat", "700124"],
];

const PETS = [
  [0, "Bruno", "dog", "Golden Retriever", "large", "4 yrs", "golden-bruno", true, "Scared of the dryer, prefers towel dry."],
  [0, "Coco", "cat", "Indian Tabby", "small", "2 yrs", "cat-tabby", true, "Anxious around dogs."],
  [0, "Momo", "dog", "Shih Tzu", "small", "1 yr", "shih-tzu", false],
  [1, "Leo", "dog", "Cavalier King Charles", "small", "3 yrs", "cavalier", true],
  [2, "Tiger", "dog", "Golden Retriever", "large", "5 yrs", "golden-flower", true, "Hates the dryer."],
  [3, "Mishti", "cat", "Persian", "small", "4 yrs", "cat-green", true],
  [4, "Bolt", "dog", "Beagle", "medium", "3 yrs", "beagle", true],
  [5, "Cookie", "dog", "Samoyed", "large", "2 yrs", "samoyed-pink", true],
  [6, "Simba", "dog", "Labrador", "large", "6 yrs", "lab-tongue", true, "Bites when nails are clipped."],
  [7, "Pixie", "dog", "Yorkshire Terrier", "small", "8 months", "yorkie-puppy", false],
  [8, "Rocky", "dog", "Husky", "large", "4 yrs", "husky", true],
  [9, "Kitty", "cat", "Indian Shorthair", "small", "1 yr", "cat-kitten", true],
  [10, "Bruno", "dog", "Pug", "small", "5 yrs", "pug-yellow", true, "Breathing issues, keep sessions short."],
  [11, "Biscuit", "dog", "Corgi", "medium", "1 yr", "corgi-puppy", true],
  [12, "Max", "dog", "Australian Shepherd", "medium", "3 yrs", "aussie", true],
  [13, "Luna", "cat", "Indian Tabby", "small", "3 yrs", "cat-orange", true],
  [8, "Daisy", "dog", "French Bulldog", "small", "2 yrs", "frenchie-yellow", true],
  [4, "Sheru", "dog", "Indie", "medium", "7 yrs", "terrier", true],
  [14, "Buddy", "dog", "Golden Retriever", "medium", "2 yrs", "golden-puppy", true, "Friendly, loves treats."],
];

const HSN = { food: "2309", treats: "2309", shampoo: "3305", accessories: "4201", toys: "9503" };
const GROOMER_PHONES = ["9007011223", "9831144556", "7044077889"];

async function uploadPets() {
  const dir = path.join(here, "../seed-assets/pets");
  const map = {};
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".jpg"))) {
    map[`/images/pets/${file}`] = await storePublicImage(fs.readFileSync(path.join(dir, file)), file, 1000);
  }
  return map;
}

async function uploadProducts() {
  const dir = path.join(here, "../seed-assets/products");
  const map = {};
  for (const [slug, file] of Object.entries(PRODUCT_PHOTOS)) {
    map[slug] = await storePublicImage(fs.readFileSync(path.join(dir, file)), file, 1000);
  }
  return map;
}

/** A clearly labelled sample page, so no real medical record is ever part of the demo. */
const samplePrescription = (pet, date, i) => {
  const lines = ["Tab. Sample-Cillin 250 mg  —  1 tab twice daily, 5 days", "Syr. Demo-Derm 5 ml  —  once daily after food", "Ear drops  —  2 drops each ear, 7 days"].slice(0, 2 + (i % 2));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200"><rect width="900" height="1200" fill="#fdfcf7"/><rect x="0" y="0" width="900" height="150" fill="#FFC814"/><text x="50" y="70" font-family="Arial" font-size="40" font-weight="700">Paws Station Clinic</text><text x="50" y="115" font-family="Arial" font-size="24">Barasat, Kolkata</text><text x="50" y="220" font-family="Arial" font-size="28">Patient: ${pet}</text><text x="600" y="220" font-family="Arial" font-size="28">Date: ${date}</text><text x="50" y="320" font-family="Georgia" font-size="46" font-style="italic">Rx</text>${lines.map((l, n) => `<text x="70" y="${400 + n * 70}" font-family="Georgia" font-size="28">${n + 1}. ${l}</text>`).join("")}<text x="50" y="1130" font-family="Arial" font-size="24" fill="#b00">SAMPLE DEMO RECORD – NOT A REAL PRESCRIPTION</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
};

export async function runSeed({ superEmail = "owner@pawsstation.in", superPassword, log = console.log } = {}) {
  const r = rng(20261101);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const now = storeNow();
  const today = now.date;

  log("Uploading images to the database…");
  const petImg = await uploadPets();
  const prodImg = await uploadProducts();
  const swap = (url) => petImg[url] ?? url;

  await saveSettings({ ...DEFAULT_SETTINGS });
  await saveSmsConfig({ enabled: false, demoEnabled: true, demoPhone: "1234567890", demoCode: "1234" });

  log("Catalog…");
  const services = await m.Service.insertMany(catalog.services.map((s, order) => ({ ...s, id: undefined, image: swap(s.image), gstRate: 18, sac: "999729", active: true, order })));
  await m.Package.insertMany(catalog.packages.map((p) => ({ ...p, id: undefined })));
  const groomers = await m.Groomer.insertMany(
    catalog.groomers.map((g, i) => ({ ...g, id: undefined, phone: GROOMER_PHONES[i], workStart: 540, workEnd: 1200, weeklyOff: [(weekday(today) + 3 + i) % 7], leaveDays: [], active: true })),
  );

  let code = 100000;
  const products = await m.Product.insertMany(
    catalog.products.map((p) => {
      const image = prodImg[p.slug] ?? swap(p.gallery.find((g) => g.endsWith(".jpg")));
      return {
        ...p,
        id: undefined,
        image,
        gallery: [image, ...p.gallery.filter((g) => g.endsWith(".jpg")).map(swap)],
        variants: p.variants.map((v) => ({ ...v, barcode: ean13(`890${String(++code).padStart(9, "0")}`) })),
        gstRate: 18,
        hsn: HSN[p.category] ?? "9999",
        lowStockLevel: 5,
        active: true,
      };
    }),
  );
  await m.Counter.updateOne({ _id: "barcode" }, { $set: { seq: code } }, { upsert: true });

  await m.Coupon.insertMany([
    { code: "PAWS10", type: "percent", value: 10, minAmount: 0, startDate: addDaysISO(today, -60), endDate: addDaysISO(today, 120), usageLimit: 500, used: 41, active: true, description: "10% off shop and services" },
    { code: "WELCOME50", type: "flat", value: 50, minAmount: 499, startDate: addDaysISO(today, -60), endDate: addDaysISO(today, 120), usageLimit: 0, used: 18, active: true, description: "₹50 off on orders above ₹499" },
    { code: "PACK20", type: "percent", value: 20, minAmount: 1000, startDate: addDaysISO(today, -5), endDate: addDaysISO(today, 25), usageLimit: 100, used: 6, active: true, description: "Flat 20% off on grooming packages" },
    { code: "WEEKDAY", type: "flat", value: 100, minAmount: 600, startDate: addDaysISO(today, -5), endDate: addDaysISO(today, 25), usageLimit: 0, used: 3, active: true, description: "Free nail trim value on weekdays" },
  ]);

  await m.Content.insertMany([
    ...catalog.gallery.map((g, order) => ({ kind: "gallery", order, data: { type: g.type, name: g.name, service: g.service, before: swap(g.before), after: swap(g.after) } })),
    ...catalog.offers.map((o, order) => ({ kind: "offer", order, data: { title: o.title, text: o.text, code: o.code, image: swap(o.image), tone: o.tone } })),
    ...catalog.reviews.map((x, order) => ({ kind: "review", order, data: { name: x.name, pet: x.pet, rating: x.rating, text: x.text, photo: swap(x.photo) } })),
    ...catalog.faqs.map((x, order) => ({ kind: "faq", order, data: x })),
  ]);

  log("Accounts…");
  const credentials = [];
  const account = async (role, name, email, extra = {}, password) => {
    const pass = password ?? `Paws-${randomToken(9)}`;
    credentials.push({ role, name, email, password: pass });
    return m.User.create({ role, name, email, passwordHash: await hashPassword(pass), ...extra });
  };
  await account("super_admin", "Store Owner", superEmail, {}, superPassword);
  await account("admin", "Store Admin", "admin@pawsstation.in");
  await account("clinic", "Dr. Meera Nandi", "clinic@pawsstation.in");
  const staffEmails = ["arjun@pawsstation.in", "priya@pawsstation.in", "rahul@pawsstation.in"];
  for (let i = 0; i < groomers.length; i++) await account("staff", groomers[i].name, staffEmails[i], { groomerId: groomers[i]._id, phone: GROOMER_PHONES[i] });

  log("Customers, pets, bookings, orders, bills…");
  const customers = await m.User.insertMany(
    CUSTOMERS.map(([name, phone, email, line1, line2, pincode], i) => ({
      role: "customer",
      name,
      phone,
      ...(email ? { email } : {}),
      addresses: [{ label: "Home", kind: "home", line1, line2, city: "Kolkata", pincode, state: "West Bengal", phone: `+91 ${phone}`, isDefault: true }],
      noShowCount: i === 6 ? 3 : 0,
      notes: i === 6 ? "Called twice to confirm. Prefers evening slots." : undefined,
      createdAt: new Date(Date.now() - (30 + i * 37) * 86400_000),
    })),
  );
  const pets = await m.Pet.insertMany(PETS.map(([owner, name, type, breed, size, age, photo, vaccinated, notes]) => ({ userId: customers[owner]._id, name, type, breed, size, age, photo: swap(`/images/pets/${photo}.jpg`), vaccinated, notes })));

  let bookingSeq = 1000;
  let invoiceSeq = 10300;
  let orderSeq = 10235;
  const bookingDocs = [];
  const invoiceDocs = [];
  const orderDocs = [];
  const holds = [];
  const loads = new Map();
  const logs = [];
  const notes = [];

  const bill = (user, pet, items, source, date, refId, extra = {}) => {
    const _id = new mongoose.Types.ObjectId();
    const base = { items, gstEnabled: true, discountPercent: extra.discountPercent, discountLabel: extra.discountLabel };
    const t = billTotals({ ...base, payments: [] });
    const paying = extra.unpaid ? 0 : t.total;
    const payments = paying ? [{ mode: pick(["Cash", "UPI", "UPI", "Card"]), amount: paying, at: date }] : [];
    invoiceDocs.push({ _id, ...base, payments, invoiceNo: `PSB${++invoiceSeq}`, date, userId: user._id, customerName: user.name, customerPhone: `+91 ${user.phone}`, petName: pet ? `${pet.name} (${pet.breed})` : undefined, source: { type: source, refId: String(refId) }, status: statusFromPayments(t.total, paying), createdAt: date, updatedAt: date });
    return _id;
  };

  const makeBooking = (pet, date, start, status, groomer, chosen) => {
    const user = customers.find((c) => c._id.equals(pet.userId));
    const duration = chosen.reduce((s, x) => s + x.durations[pet.size], 0);
    const estimate = chosen.reduce((s, x) => s + x.prices[pet.size], 0);
    const _id = new mongoose.Types.ObjectId();
    const at = storeInstant(date, start);
    // Booked a few days ahead, but never later than now: upcoming visits were made in the past too.
    const booked = new Date(Math.min(at.getTime() - (2 + Math.floor(r() * 5)) * 86400_000, Date.now() - (3 + Math.floor(r() * 48)) * 3600_000));
    const history = { booked };
    const flow = ["confirmed", "scheduled", "checked_in", "grooming_started", "in_progress", "completed", "ready_for_pickup", "picked_up"];
    const reach = flow.indexOf(status);
    flow.slice(0, reach + 1).forEach((s, i) => (history[s] = s === "confirmed" || s === "scheduled" ? new Date(booked.getTime() + 3600_000 * (i + 1)) : new Date(at.getTime() + (i - 1) * 8 * 60_000)));
    if (status === "cancelled" || status === "no_show") history[status] = new Date(at.getTime() - 3 * 3600_000);
    const doc = {
      _id, bookingNo: `PSK${++bookingSeq}`, userId: user._id, petId: pet._id, serviceIds: chosen.map((x) => x._id), serviceNames: chosen.map((x) => x.name), groomerId: groomer._id, date, start, duration, status,
      source: pick(["online", "online", "online", "phone", "walkin"]), estimate, history, createdAt: booked, updatedAt: booked, acknowledgedAt: reach >= 1 ? booked : undefined,
      cancelReason: status === "cancelled" ? pick(["Customer travelling", "Pet unwell", "Rescheduled by phone"]) : undefined,
      pickup: status === "picked_up" ? { verifiedAt: history.picked_up, verifiedByName: groomer.name } : {},
    };
    if (status === "picked_up" || status === "completed" || status === "ready_for_pickup") {
      doc.photos = { before: swap(pick(catalog.gallery).before), after: pet.photo };
      if (status === "picked_up" && r() > 0.5) doc.rating = 4 + Math.round(r());
      doc.invoiceId = bill(user, pet, chosen.map((x, i) => ({ key: `s${i}`, kind: "service", refId: String(x._id), name: `${x.name} (${pet.size[0].toUpperCase()}${pet.size.slice(1)})`, qty: 1, price: x.prices[pet.size], gstRate: 18, code: "SAC 999729" })), "booking", new Date(at.getTime() + duration * 60_000), _id, { unpaid: status !== "picked_up" && r() > 0.5 });
    }
    if (!["cancelled", "no_show"].includes(status)) {
      for (const minute of stepsFor(start, duration, 30)) {
        holds.push({ date, minute, groomerId: groomer._id, bookingId: _id });
        loads.set(`${date}|${minute}`, (loads.get(`${date}|${minute}`) ?? 0) + 1);
      }
    }
    bookingDocs.push(doc);
    return doc;
  };

  const free = (groomer, date, start, duration) => {
    if (start + duration > 1200) return false;
    return stepsFor(start, duration, 30).every((minute) => !holds.some((h) => h.date === date && h.minute === minute && h.groomerId.equals(groomer._id)) && (loads.get(`${date}|${minute}`) ?? 0) < 3);
  };

  const plan = (date, count, statusFor) => {
    for (let i = 0; i < count; i++) {
      const pet = pick(pets);
      const options = services.filter((s) => pet.type === "dog" || s.forCats);
      const chosen = r() > 0.6 ? [pick(options), pick(options)].filter((v, n, a) => a.indexOf(v) === n) : [pick(options)];
      const duration = chosen.reduce((s, x) => s + x.durations[pet.size], 0);
      const groomer = pick(groomers);
      const start = 570 + Math.floor(r() * 18) * 30;
      if (!free(groomer, date, start, duration)) continue;
      makeBooking(pet, date, start, statusFor(), groomer, chosen);
    }
  };

  for (let d = -60; d <= -1; d++) plan(addDaysISO(today, d), 3 + Math.floor(r() * 4), () => (r() < 0.08 ? "cancelled" : r() < 0.05 ? "no_show" : "picked_up"));
  for (let d = 1; d <= 14; d++) plan(addDaysISO(today, d), 2 + Math.floor(r() * 3), () => (r() < 0.75 ? "confirmed" : "scheduled"));

  // Today's board shows one booking at every stage, so each dashboard has something to act on.
  const todays = [
    [pets[0], 600, "ready_for_pickup", 0, [services[0]]],
    [pets[3], 630, "completed", 2, [services[0]]],
    [pets[6], 660, "in_progress", 1, [services[1]]],
    [pets[7], 690, "grooming_started", 0, [services[2]]],
    [pets[10], 720, "checked_in", 2, [services[3]]],
    [pets[13], 780, "scheduled", 0, [services[0]]],
    [pets[14], 840, "confirmed", 1, [services[2]]],
    [pets[16], 900, "confirmed", 2, [services[3]]],
    [pets[1], 960, "confirmed", 0, [services[2]]],
    [pets[18], 1020, "ready_for_pickup", 1, [services[3]]],
  ];
  for (const [pet, start, status, g, chosen] of todays) makeBooking(pet, today, start, status, groomers[g], chosen);

  for (let d = -55; d <= 0; d += 2) {
    const user = pick(customers);
    const date = new Date(storeInstant(addDaysISO(today, d), 660 + Math.floor(r() * 300)));
    const lines = [pick(products), pick(products)].filter((v, n, a) => a.indexOf(v) === n && v.stock > 0).map((p) => {
      const v = pick(p.variants);
      return { productId: p._id, variantId: v.id, name: p.name, variant: v.label, image: p.image, price: v.price, qty: 1 + Math.floor(r() * 2), gstRate: 18, hsn: p.hsn };
    });
    if (!lines.length) continue;
    const fulfilment = r() > 0.4 ? "delivery" : "pickup";
    const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);
    const deliveryCharge = fulfilment === "delivery" && subtotal < 999 ? 50 : 0;
    const status = d < -3 ? (r() < 0.1 ? "cancelled" : "delivered") : pick(["placed", "confirmed", "packed", fulfilment === "delivery" ? "out_for_delivery" : "ready_for_pickup"]);
    const flow = ["placed", "confirmed", "packed", fulfilment === "delivery" ? "out_for_delivery" : "ready_for_pickup", "delivered"];
    const history = {};
    const reach = status === "cancelled" ? 0 : flow.indexOf(status);
    flow.slice(0, reach + 1).forEach((s, i) => (history[s] = new Date(date.getTime() + i * 3 * 3600_000)));
    if (status === "cancelled") history.cancelled = new Date(date.getTime() + 3600_000);
    const _id = new mongoose.Types.ObjectId();
    const a = user.addresses[0];
    const doc = { _id, orderNo: `PSO${++orderSeq}`, userId: user._id, items: lines, fulfilment, payment: fulfilment === "delivery" ? "COD" : "PAY_AT_STORE", status, deliveryCharge, discount: 0, history, createdAt: date, updatedAt: date, ...(fulfilment === "delivery" ? { address: [a.line1, a.line2, a.city, a.pincode, a.state].join(", "), addressId: String(a._id) } : {}), cancelReason: status === "cancelled" ? "Customer changed their mind" : undefined };
    if (status === "delivered") {
      const items = [...lines.map((l, i) => ({ key: `p${i}`, kind: "product", refId: String(l.productId), variantId: l.variantId, name: `${l.name} (${l.variant})`, qty: l.qty, price: l.price, gstRate: 18, code: `HSN ${l.hsn}` })), ...(deliveryCharge ? [{ key: "d", kind: "charge", name: "Delivery charge", qty: 1, price: deliveryCharge, gstRate: 18, code: "SAC 996812" }] : [])];
      doc.invoiceId = bill(user, null, items, "order", history.delivered, _id);
    }
    if (status !== "cancelled") for (const l of lines) logs.push({ productId: l.productId, change: -l.qty, reason: "sale", refId: String(_id), at: date });
    orderDocs.push(doc);
  }

  for (const p of products) logs.push({ productId: p._id, change: p.stock, reason: "stock_in", note: "Opening stock", at: new Date(Date.now() - 70 * 86400_000) });

  const riya = customers[0];
  notes.push(
    { userId: riya._id, kind: "booking", title: "Your pet is ready for pickup", message: "Open your booking and show the pickup OTP at the store.", href: "/account/bookings", unread: true },
    { userId: riya._id, kind: "offer", title: "Special Offer", message: "Flat 20% OFF on Grooming Packages. Use PACK20.", href: "/services", unread: true },
  );

  await m.Booking.collection.insertMany(bookingDocs);
  await m.Invoice.collection.insertMany(invoiceDocs);
  await m.Order.collection.insertMany(orderDocs);
  await m.SlotHold.insertMany(holds);
  await m.SlotLoad.insertMany([...loads].map(([_id, count]) => ({ _id, count })));
  await m.StockLog.insertMany(logs);
  await m.Notification.insertMany(notes);
  await m.Counter.bulkWrite(Object.entries({ booking: bookingSeq, invoice: invoiceSeq, order: orderSeq }).map(([_id, seq]) => ({ updateOne: { filter: { _id }, update: { $set: { seq } }, upsert: true } })));

  // Generate the OTP through the same path the live flow uses.
  const { seal, randomDigits } = await import("../src/lib/crypto.js");
  const ready = await m.Booking.find({ status: "ready_for_pickup" }).select("_id");
  for (const b of ready) {
    await m.Booking.updateOne({ _id: b._id }, { $set: { pickup: { otpSealed: seal(Buffer.from(randomDigits(6))), generatedAt: new Date(), expiresAt: new Date(Date.now() + 48 * 3600_000), attempts: 0 } } });
  }

  log("Sample clinic records…");
  const doctor = await m.User.findOne({ role: "clinic" });
  for (let i = 0; i < 6; i++) {
    const pet = pets[[0, 0, 0, 3, 6, 1][i]];
    const takenOn = addDaysISO(today, -[3, 34, 80, 12, 21, 45][i]);
    const { fileId, size } = await storePrescription(await samplePrescription(pet.name, takenOn, i), `prescription-${takenOn}.jpg`, { petId: String(pet._id) });
    await m.Prescription.create({ petId: pet._id, fileId, takenOn, note: i === 0 ? "Follow-up in 2 weeks" : "", size, uploadedBy: doctor._id, uploadedByName: doctor.name });
  }

  // A rupee-accurate check that the demo books balance before the seed reports success.
  const sum = invoiceDocs.reduce((s, i) => s + billTotals(i).total, 0);
  return { credentials, stats: { customers: customers.length, pets: pets.length, bookings: bookingDocs.length, orders: orderDocs.length, invoices: invoiceDocs.length, products: products.length, revenue: sum } };
}

export const CLEAR_BUCKETS = ["media.files", "media.chunks", `${CLINIC_BUCKET}.files`, `${CLINIC_BUCKET}.chunks`];
