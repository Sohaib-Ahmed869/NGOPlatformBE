/**
 * scripts/fixAssetContentTypes.js
 *
 *   npm run audit:asset-types           # report only
 *   npm run fix:asset-types             # rewrite the wrong ones
 *   node scripts/fixAssetContentTypes.js --fix --prefix=branding
 *
 * Every object uploaded through config/s3.js before 2026-08-28 was stored as
 * `application/octet-stream`, whatever it actually was.
 *
 * The cause was upstream: `multerS3.AUTO_CONTENT_TYPE` calls
 * `fileType.fromStream()` WITHOUT awaiting it, then reads `.mime` off the
 * returned Promise — undefined — so S3 fell back to the generic type for every
 * upload. config/s3.js no longer uses that helper; this script repairs what it
 * already wrote.
 *
 * It matters because of email. A browser sniffs an `<img>` body and renders a
 * mislabelled PNG anyway, so the app looked fine — but Gmail proxies remote
 * images through googleusercontent.com and will not serve a logo that isn't
 * declared as an image, so branded headers arrived as a broken box.
 *
 * The repair is a CopyObject onto itself with MetadataDirective: REPLACE, which
 * rewrites the metadata and leaves the bytes (and the URL) untouched.
 */

require("dotenv").config();
const path = require("path");
const {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  CopyObjectCommand,
} = require("@aws-sdk/client-s3");

const BUCKET = process.env.S3_BUCKET_NAME;
const REGION = process.env.AWS_REGION || "us-east-1";

// Same table as config/s3.js. Anything not listed is left alone — this script
// only ever replaces a GENERIC type with a KNOWN one, never guesses.
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
};

const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream"]);

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : "";
};

const APPLY = has("--fix");
const PREFIX = valueOf("prefix");
const LIMIT = Number(valueOf("limit")) || 0;

async function* everyObject(s3) {
  let token;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: PREFIX || undefined, ContinuationToken: token }),
    );
    for (const obj of page.Contents || []) yield obj;
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
}

(async () => {
  if (!BUCKET) {
    console.error("S3_BUCKET_NAME is not set.");
    process.exit(1);
  }

  const s3 = new S3Client({
    region: REGION,
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });

  console.log(`\nBucket ${BUCKET} (${REGION})${PREFIX ? `, prefix "${PREFIX}"` : ""}`);
  console.log(APPLY ? "Mode: FIX — metadata will be rewritten.\n" : "Mode: report only — pass --fix to apply.\n");

  let scanned = 0;
  let wrong = 0;
  let fixed = 0;
  let failed = 0;
  const byType = {};

  for await (const obj of everyObject(s3)) {
    const key = obj.Key;
    const ext = path.extname(key).toLowerCase();
    const want = MIME_BY_EXT[ext];
    if (!want) continue; // not something we know how to label
    scanned += 1;
    if (LIMIT && scanned > LIMIT) break;

    let head;
    try {
      head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    } catch (err) {
      failed += 1;
      console.error(`  ! HEAD failed  ${key}  ${err.message}`);
      continue;
    }

    const current = String(head.ContentType || "").toLowerCase();
    if (!GENERIC.has(current)) continue; // already labelled — leave it

    wrong += 1;
    byType[want] = (byType[want] || 0) + 1;
    if (!APPLY) {
      if (wrong <= 15) console.log(`  ${current || "(none)"} → ${want}   ${key}`);
      else if (wrong === 16) console.log("  …");
      continue;
    }

    try {
      await s3.send(
        new CopyObjectCommand({
          Bucket: BUCKET,
          Key: key,
          CopySource: `${BUCKET}/${encodeURIComponent(key).replace(/%2F/g, "/")}`,
          // REPLACE is the whole point: without it S3 copies the old metadata
          // straight back and nothing changes.
          MetadataDirective: "REPLACE",
          ContentType: want,
          ContentDisposition: "inline",
          // Keys carry a unique suffix, so a stored object never changes bytes.
          CacheControl: "public, max-age=31536000, immutable",
        }),
      );
      fixed += 1;
      if (fixed % 25 === 0) process.stdout.write(`  …${fixed} fixed\n`);
    } catch (err) {
      failed += 1;
      console.error(`  ! COPY failed  ${key}  ${err.message}`);
    }
  }

  console.log(`\nScanned ${scanned} known-type object(s).`);
  console.log(`Mislabelled: ${wrong}`);
  for (const [type, n] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(5)}  → ${type}`);
  }
  if (APPLY) console.log(`Rewritten:   ${fixed}`);
  if (failed) console.log(`Failed:      ${failed}`);
  if (!APPLY && wrong) console.log("\nRe-run with --fix to rewrite them.\n");
  else console.log("");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
