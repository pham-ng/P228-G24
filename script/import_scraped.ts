import * as fs from "fs";
import * as path from "path";
import { storage } from "../server/storage.js";
import { reindex } from "../server/retrieval.js";

const DATA_DIR = "D:\\DATA\\Vin_Wonder";

function stripHtml(html: string): string {
  // Very basic HTML stripping:
  // 1. Remove scripts and styles
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ");
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ");
  // 2. Extract content from main body if possible, or just strip tags
  const bodyMatch = text.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    text = bodyMatch[1];
  }
  // 3. Replace typical block elements with newlines
  text = text.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n");
  // 4. Strip all other tags
  text = text.replace(/<[^>]+>/g, " ");
  // 5. Decode basic entities
  text = text.replace(/&nbsp;/g, " ")
             .replace(/&amp;/g, "&")
             .replace(/&lt;/g, "<")
             .replace(/&gt;/g, ">")
             .replace(/&quot;/g, "\"");
  // 6. Condense whitespace
  text = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n/g, "\n\n").trim();
  return text;
}

async function main() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".html"));
  
  const existingArticles = storage.listKb();
  const existingTitles = new Set(existingArticles.map(a => a.title));
  
  let added = 0;
  
  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    const title = file.replace(".html", "").trim();
    
    // Skip duplicates
    if (existingTitles.has(title)) {
      console.log(`Skipping duplicate: ${title}`);
      continue;
    }
    
    // Read and parse
    const rawHtml = fs.readFileSync(filePath, "utf-8");
    const textContent = stripHtml(rawHtml);
    
    // Simple nonsense filter: if text is too short or doesn't have enough words
    if (textContent.length < 500) {
      console.log(`Skipping likely nonsense/empty: ${title}`);
      continue;
    }
    
    // Add to knowledge base with metadata
    const tags = JSON.stringify(["vin_wonder", "scraped", "v1"]);
    
    storage.createKb({
      hotelId: 1,
      category: "vin_wonder",
      title: title,
      body: textContent,
      tags: tags,
      updatedAt: new Date().toISOString()
    });
    
    console.log(`Imported: ${title}`);
    added++;
  }
  
  if (added > 0) {
    console.log(`Added ${added} new articles. Reindexing...`);
    const stats = await reindex();
    console.log(`Reindex complete: ${stats.chunks} chunks total, embedded: ${stats.embedded}`);
  } else {
    console.log("No new articles added.");
  }
}

main().catch(console.error);
