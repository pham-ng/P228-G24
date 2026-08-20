const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const db = new Database('data.db');

try {
  db.exec('ALTER TABLE services ADD COLUMN images TEXT NOT NULL DEFAULT \"[]\"');
  console.log('Added images column to services');
} catch(e) {
  // Column probably exists
}

// Ensure the directory exists
const targetBase = path.join(__dirname, 'client', 'public', 'services');
if (!fs.existsSync(targetBase)) {
  fs.mkdirSync(targetBase, { recursive: true });
}

// Since we don't have the explicit folders from the user yet, we will just map a few key IDs 
// and the user can replace the dummy images later, or they can run an import script like before.
// We will mock images for IDs: 15 (Cable car), 16 (VinWonders)
// But to make it clean, we just update the DB with some placeholder paths.
// The user can drop their images into public/services/vinwonders/ etc.

const map = {
  15: ['/services/cable-car.jpg'],
  16: ['/services/vinwonders.jpg'],
  18: ['/services/vinpearl-harbour.jpg'],
  21: ['/services/water-sports.jpg'],
};

for (const [id, urls] of Object.entries(map)) {
  const imagesJson = JSON.stringify(urls);
  db.prepare('UPDATE services SET images = ? WHERE id = ?').run(imagesJson, id);
  console.log(`Updated service ${id} with ${urls.length} images.`);
}
