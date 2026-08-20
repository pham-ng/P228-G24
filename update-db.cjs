const Database = require('better-sqlite3');
const db = new Database('data.db');
const images = JSON.stringify([
  '/rooms/deluxe-giuong-doi/1.webp',
  '/rooms/deluxe-giuong-doi/2.webp',
  '/rooms/deluxe-giuong-doi/3.webp',
  '/rooms/deluxe-giuong-doi/4.webp'
]);
db.prepare("UPDATE room_types SET images = ? WHERE name_vi LIKE '%Deluxe Giường Đôi%'").run(images);
console.log('Updated Deluxe Giường Đôi images in DB');
