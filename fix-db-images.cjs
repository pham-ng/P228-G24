const Database = require('better-sqlite3');
const db = new Database('data.db');

const rows = db.prepare('SELECT id, name_vi FROM room_types').all();

// The two that failed:
// "Deluxe giường đôi" -> should match "Deluxe Giường Đôi"
// "Grand Deluxe Hướng Biển Giường Đôi" -> doesn't exist? Wait let me check.

const folders = {
  "Deluxe giường đôi": "Deluxe Giường Đôi",
  "Grand Deluxe Hướng Biển Giường Đôi": "Grand Deluxe Hướng Biển Giường Đôi"
};

for (const row of rows) {
  for (const [folder, dbName] of Object.entries(folders)) {
    if (row.name_vi.toLowerCase() === dbName.toLowerCase()) {
       const slug = folder.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase().replace(/[^a-z0-9]+/g, "-").trim();
       console.log(`Matching ${folder} to ID ${row.id}`);
       // Wait, I need to read the images again for these folders
       const fs = require('fs');
       const path = require('path');
       const sourceFolder = process.env.SOURCE_ROOMS_DIR || path.join(__dirname, 'client', 'public', 'rooms', slug);
       if(fs.existsSync(sourceFolder)) {
         const files = fs.readdirSync(sourceFolder).filter(f => f.match(/\.(jpg|jpeg|png|webp|gif)$/i));
         const imageUrls = files.map(file => `/rooms/${slug}/${file}`);
         if (imageUrls.length > 0) {
           db.prepare('UPDATE room_types SET images = ? WHERE id = ?').run(JSON.stringify(imageUrls), row.id);
           console.log(`Updated ID ${row.id} with ${imageUrls.length} images.`);
         }
       }
    }
  }
}
