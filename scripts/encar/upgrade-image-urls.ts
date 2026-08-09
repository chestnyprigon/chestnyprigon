import path from "node:path";
import { config as loadEnvironment } from "dotenv";
import { createClient } from "@supabase/supabase-js";
import { encarPhotoUrl } from "../../src/lib/encar/images";

loadEnvironment({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

const supabase = createClient(
  required("NEXT_PUBLIC_SUPABASE_URL"),
  required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function main() {
  const pageSize = 500;
  let from = 0;
  let updated = 0;

  while (true) {
    const { data, error } = await supabase
      .from("vehicle_images")
      .select("id,source_url")
      .order("id")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    if (!data?.length) break;

    const changed = data.filter((image) => encarPhotoUrl(image.source_url) !== image.source_url);
    for (let offset = 0; offset < changed.length; offset += 25) {
      const batch = changed.slice(offset, offset + 25);
      const results = await Promise.all(batch.map((image) => supabase.from("vehicle_images").update({ source_url: encarPhotoUrl(image.source_url) }).eq("id", image.id)));
      const failure = results.find((result) => result.error)?.error;
      if (failure) throw new Error(failure.message);
    }

    updated += changed.length;
    process.stdout.write(`Processed ${from + data.length} images; upgraded ${updated}.\n`);
    if (data.length < pageSize) break;
    from += pageSize;
  }

  process.stdout.write(`Completed: upgraded ${updated} Encar image URLs to the 1280×768 policy endpoint.\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
