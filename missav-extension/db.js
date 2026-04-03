// db.js - Place this in your extension (background.js, popup.js, etc.)

const DB_NAME = "MissAVExtensionDB";
const DB_VERSION = 1;
const STORE_NAME = "items";

// Open database (creates it if it doesn't exist)
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      // Global error handler
      db.onerror = (event) =>
        console.error("Database error:", event.target.error);
      resolve(db);
    };

    // Schema setup / upgrade
    request.onupgradeneeded = (event) => {
      const db = event.target.result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });

        // Optional indexes for faster queries
        store.createIndex("nameIndex", "name", { unique: false });
        store.createIndex("dateIndex", "date", { unique: false });
      }
    };
  });
}

// === CRUD Helpers ===

// Create (add new item)
async function createItem(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(item); // ← updates if url exists, inserts otherwise

    req.onsuccess = () => resolve(req.result); // returns the auto-generated key
    req.onerror = () => reject(req.error);

    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  });
}

// Read single item by key
async function readItem(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);

    tx.oncomplete = () => db.close();
  });
}

// Read all items (using cursor)
async function readAllItems() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const items = [];
    const tx = db.transaction([STORE_NAME], "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        items.push(cursor.value);
        cursor.continue();
      } else {
        resolve(items);
      }
    };
    req.onerror = () => reject(req.error);

    tx.oncomplete = () => db.close();
  });
}

// Update (or insert if key doesn't exist) - uses put()
async function updateItem(item) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(item); // item must include the 'id' for updates

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);

    tx.oncomplete = () => db.close();
  });
}

// Delete by key
async function deleteItem(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);

    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);

    tx.oncomplete = () => db.close();
  });
}

// Example: Query by index
async function getItemsByName(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const items = [];
    const tx = db.transaction([STORE_NAME], "readonly");
    const store = tx.objectStore(STORE_NAME);
    const index = store.index("nameIndex");
    const req = index.openCursor(IDBKeyRange.only(name));

    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        items.push(cursor.value);
        cursor.continue();
      } else {
        resolve(items);
      }
    };
    req.onerror = () => reject(req.error);

    tx.oncomplete = () => db.close();
  });
}
