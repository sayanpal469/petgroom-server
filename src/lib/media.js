import mongoose from "mongoose";
import sharp from "sharp";
import { Readable } from "node:stream";
import { badRequest, notFound } from "./errors.js";

const buckets = {};
function bucket(name) {
  buckets[name] ??= new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: name });
  return buckets[name];
}
/** Test runs reconnect to a fresh database. */
export const resetBuckets = () => Object.keys(buckets).forEach((k) => delete buckets[k]);

export const PUBLIC_BUCKET = "media";
export const CLINIC_BUCKET = "clinic";

const MAX_BYTES = 8 * 1024 * 1024;

export function decodeImage(base64) {
  const clean = String(base64).replace(/^data:[\w/+.-]+;base64,/, "");
  const buf = Buffer.from(clean, "base64");
  if (!buf.length) throw badRequest("Empty image.");
  if (buf.length > MAX_BYTES) throw badRequest("Image is larger than 8 MB.");
  return buf;
}

const isJpeg = (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

/**
 * Every upload is decoded and re-encoded, which removes EXIF data (camera, GPS) and anything
 * hidden inside the file. A file that is not really an image fails here.
 */
async function normalise(buf, { maxWidth, quality }) {
  try {
    return await sharp(buf, { failOn: "error", limitInputPixels: 50_000_000 }).rotate().resize({ width: maxWidth, withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toBuffer();
  } catch {
    throw badRequest("That file is not a valid image.");
  }
}

function put(bucketName, data, filename, metadata) {
  return new Promise((resolve, reject) => {
    const up = bucket(bucketName).openUploadStream(filename, { contentType: "image/jpeg", metadata });
    Readable.from(data).pipe(up).on("error", reject).on("finish", () => resolve(up.id));
  });
}

export async function storePublicImage(buf, filename, maxWidth = 1400) {
  const out = await normalise(buf, { maxWidth, quality: 82 });
  const id = await put(PUBLIC_BUCKET, out, filename);
  return `/media/${id}`;
}

/** Clinic records: JPEG/JPG only, as agreed for the module. PDF and everything else is refused. */
export async function storePrescription(buf, filename, metadata) {
  if (!isJpeg(buf)) throw badRequest("Only JPEG/JPG prescription images are allowed.");
  const out = await normalise(buf, { maxWidth: 2600, quality: 90 });
  const id = await put(CLINIC_BUCKET, out, filename, metadata);
  return { fileId: id, size: out.length };
}

export async function readFile(bucketName, id) {
  const _id = new mongoose.Types.ObjectId(id);
  const [file] = await bucket(bucketName).find({ _id }).toArray();
  if (!file) throw notFound();
  const chunks = [];
  for await (const c of bucket(bucketName).openDownloadStream(_id)) chunks.push(c);
  return Buffer.concat(chunks);
}

export function streamPublic(id, res, next) {
  const _id = new mongoose.Types.ObjectId(id);
  bucket(PUBLIC_BUCKET)
    .find({ _id })
    .toArray()
    .then(([file]) => {
      if (!file) return next(notFound());
      res.set({
        "Content-Type": "image/jpeg",
        "Content-Length": String(file.length),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
      bucket(PUBLIC_BUCKET).openDownloadStream(_id).on("error", next).pipe(res);
    })
    .catch(next);
}
