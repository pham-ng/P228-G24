const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database('data.db');

try {
  db.exec('ALTER TABLE dining_venues ADD COLUMN images TEXT NOT NULL DEFAULT \"[]\"');
  console.log('Added images column to dining_venues');
} catch(e) {
  // Column probably exists
}

const sourceBase = process.env.SOURCE_DINING_DIR || path.join(__dirname, 'client', 'public', 'dining');
const targetBase = path.join(__dirname, 'client', 'public', 'dining');

// Folder to ID mapping based on the db query
const folderToId = {
  "Bách Giai": 1,
  "Halal VietFlavors": 2,
  "Jasmine": 3,
  "Lotus": 4,
  "Beachcomber": 5,
  "Pool bar": 6,
  "Seaview Lounge": 7
};

function createSlug(name) {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .trim();
}

const entries = fs.readdirSync(sourceBase, { withFileTypes: true });
for (const entry of entries) {
  if (entry.isDirectory()) {
    const venueName = entry.name;
    const dbId = folderToId[venueName];
    
    if (dbId) {
      const slug = createSlug(venueName);
      const sourceFolder = path.join(sourceBase, venueName);
      const targetFolder = path.join(targetBase, slug);
      
      if (!fs.existsSync(targetFolder)) {
        fs.mkdirSync(targetFolder, { recursive: true });
      }
      
      const files = fs.readdirSync(sourceFolder).filter(f => f.match(/\.(jpg|jpeg|png|webp|gif)$/i));
      const imageUrls = [];
      
      for (const file of files) {
        const sourceFile = path.join(sourceFolder, file);
        const targetFile = path.join(targetFolder, file);
        fs.copyFileSync(sourceFile, targetFile);
        imageUrls.push(`/dining/${slug}/${file}`);
      }
      
      if (imageUrls.length > 0) {
        const imagesJson = JSON.stringify(imageUrls);
        const stmt = db.prepare('UPDATE dining_venues SET images = ? WHERE id = ?');
        stmt.run(imagesJson, dbId);
        console.log(`Updated "${venueName}" with ${imageUrls.length} images.`);
      } else {
        console.log(`No images found in "${venueName}"`);
      }
    } else {
      console.log(`No DB mapping for folder: ${venueName}`);
    }
  }
}
console.log('Done mapping dining images!');
