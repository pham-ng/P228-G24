const Database = require('better-sqlite3');
const db = new Database('data.db');

const spaImageUrls = [
  '/services/akoya-spa-1.jpg',
  '/services/akoya-spa-2.jpg',
  '/services/akoya-spa-3.jpg'
];

const imagesJson = JSON.stringify(spaImageUrls);
const info = db.prepare("UPDATE services SET images = ? WHERE category = 'spa'").run(imagesJson);

console.log(`Updated ${info.changes} spa services with images!`);
