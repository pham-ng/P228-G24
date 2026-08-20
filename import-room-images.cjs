const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database('data.db');
const sourceBase = 'D:\\DATA\\Vin_Resort_NhaTrang\\Các loại phòng';
const targetBase = path.join(__dirname, 'client', 'public', 'rooms');

// Helper to create URL slug from folder name
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
    const roomName = entry.name;
    const slug = createSlug(roomName);
    const sourceFolder = path.join(sourceBase, roomName);
    const targetFolder = path.join(targetBase, slug);
    
    // Create target dir if not exists
    if (!fs.existsSync(targetFolder)) {
      fs.mkdirSync(targetFolder, { recursive: true });
    }
    
    // Read files
    const files = fs.readdirSync(sourceFolder).filter(f => f.match(/\.(jpg|jpeg|png|webp|gif)$/i));
    const imageUrls = [];
    
    for (const file of files) {
      const sourceFile = path.join(sourceFolder, file);
      const targetFile = path.join(targetFolder, file);
      fs.copyFileSync(sourceFile, targetFile);
      imageUrls.push(`/rooms/${slug}/${file}`);
    }
    
    if (imageUrls.length > 0) {
      const imagesJson = JSON.stringify(imageUrls);
      const stmt = db.prepare('UPDATE room_types SET images = ? WHERE LOWER(name_vi) = LOWER(?)');
      const info = stmt.run(imagesJson, roomName);
      console.log(`Updated "${roomName}" with ${imageUrls.length} images. Rows affected: ${info.changes}`);
    } else {
      console.log(`No images found in "${roomName}"`);
    }
  }
}
console.log('Done mapping all room images!');
