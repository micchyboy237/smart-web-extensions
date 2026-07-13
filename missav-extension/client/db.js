// db.js - Place this in your extension (background.js, popup.js, etc.)
const DB_NAME = "MissAVExtensionDB";
const DB_VERSION = 1;
const STORE_NAME = "items";

/**
 * Opens the IndexedDB database connection
 * @returns {Promise<IDBDatabase>} Database instance
 */
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => reject(request.error);

    request.onsuccess = () => {
      const db = request.result;
      // Global error handler
      db.onerror = (event) =>
        console.error("[DB] Database error:", event.target.error);
      resolve(db);
    };

    // Schema setup / upgrade
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: false,
        });
        // Indexes for faster queries
        store.createIndex("codeIndex", "code", { unique: false });
        store.createIndex("episodeIndex", "episode", { unique: false });
        store.createIndex("videoIdIndex", "videoId", { unique: false });
        console.log("[DB] 📦 Database schema created/upgraded");
      }
    };
  });
}

// ====================== CREATE ======================

/**
 * Create or update an item (upsert)
 * @param {Object} item - Item with 'id' property
 * @returns {Promise<*>} The key of the saved item
 */
async function createItem(item) {
  console.log("[DB] 📝 createItem called with:", item);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(item);
    req.onsuccess = () => {
      console.log("[DB] ✅ Item saved with id:", item.id);
      resolve(req.result);
    };
    req.onerror = () => {
      console.error("[DB] ❌ createItem failed:", req.error);
      reject(req.error);
    };
    tx.oncomplete = () => db.close();
    tx.onerror = () => reject(tx.error);
  });
}

// ====================== READ ======================

/**
 * Get a single item by its ID
 * @param {string} id - The item ID to retrieve
 * @returns {Promise<Object|undefined>} The item or undefined if not found
 */
async function getItem(id) {
  console.log("[DB] 🔍 getItem called for id:", id);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => {
      if (req.result) {
        console.log("[DB] ✅ Item found:", req.result);
      } else {
        console.log("[DB] ⚠️ No item found for id:", id);
      }
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/**
 * Get all items with optional filtering, sorting, and limiting
 * @param {Object} options - Configuration options
 * @param {string} options.index - Index name to query (e.g., 'codeIndex')
 * @param {string} options.value - Value to search for
 * @param {boolean} options.exactMatch - true for exact match, false for prefix
 * @param {string} options.sortBy - Field to sort by
 * @param {string} options.sortOrder - 'asc' or 'desc'
 * @param {string} options.direction - Cursor direction ('next', 'prev', etc.)
 * @param {number} options.limit - Maximum number of items to return
 * @returns {Promise<Array>} Array of matching items
 */
async function getAll(options = {}) {
  console.log("[DB] 📋 getAll() called with options:", options);
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const items = [];
    const tx = db.transaction([STORE_NAME], "readonly");
    const store = tx.objectStore(STORE_NAME);

    // Support for index-based queries
    if (options.index && options.value) {
      console.log(
        `[DB] 🔍 Using index "${options.index}" with value "${options.value}"`,
      );
      const index = store.index(options.index);
      const keyRange = options.exactMatch
        ? IDBKeyRange.only(options.value)
        : IDBKeyRange.bound(options.value, options.value + "\uffff");

      const req = index.openCursor(keyRange, options.direction || "next");

      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          items.push(cursor.value);
          cursor.continue();
        } else {
          console.log(
            `[DB] 📊 Retrieved ${items.length} items from index query`,
          );
          const result = options.sortBy
            ? sortItems(items, options.sortBy, options.sortOrder)
            : items;
          resolve(result);
        }
      };

      req.onerror = () => {
        console.error("[DB] ❌ getAll with index failed:", req.error);
        reject(req.error);
      };
    } else {
      // Get all items using cursor
      const req = store.openCursor(null, options.direction || "next");

      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (cursor) {
          items.push(cursor.value);
          cursor.continue();
        } else {
          console.log(`[DB] 📊 Retrieved ${items.length} total items`);
          const sortedResult = options.sortBy
            ? sortItems(items, options.sortBy, options.sortOrder)
            : items;
          const finalResult = options.limit
            ? sortedResult.slice(0, options.limit)
            : sortedResult;
          resolve(finalResult);
        }
      };

      req.onerror = () => {
        console.error("[DB] ❌ getAll failed:", req.error);
        reject(req.error);
      };
    }

    tx.oncomplete = () => {
      console.log("[DB] 🔒 Transaction complete, closing DB");
      db.close();
    };

    tx.onerror = () => {
      console.error("[DB] ❌ Transaction error in getAll:", tx.error);
      reject(tx.error);
    };
  });
}

/**
 * Sort items array by specified field
 * @param {Array} items - Items to sort
 * @param {string} sortBy - Field to sort by
 * @param {string} sortOrder - 'asc' or 'desc'
 * @returns {Array} Sorted items
 */
function sortItems(items, sortBy, sortOrder = "asc") {
  console.log(`[DB] 🔄 Sorting by "${sortBy}" in ${sortOrder} order`);
  return items.sort((a, b) => {
    let valueA = a[sortBy];
    let valueB = b[sortBy];

    // Handle null/undefined values
    if (valueA == null) valueA = "";
    if (valueB == null) valueB = "";

    // Handle numeric sorting for episode numbers
    if (sortBy === "episode") {
      valueA = parseInt(valueA) || 0;
      valueB = parseInt(valueB) || 0;
    }

    // Compare values
    let comparison = 0;
    if (valueA < valueB) comparison = -1;
    if (valueA > valueB) comparison = 1;

    return sortOrder === "desc" ? -comparison : comparison;
  });
}

// ====================== UPDATE ======================

/**
 * Update an existing item (or insert if doesn't exist)
 * @param {Object} item - Item with 'id' property
 * @returns {Promise<*>} The key of the updated item
 */
async function updateItem(item) {
  console.log("[DB] 🔄 updateItem called with:", item);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.put(item);
    req.onsuccess = () => {
      console.log("[DB] ✅ Item updated:", item.id);
      resolve(req.result);
    };
    req.onerror = () => {
      console.error("[DB] ❌ updateItem failed:", req.error);
      reject(req.error);
    };
    tx.oncomplete = () => db.close();
  });
}

// ====================== DELETE ======================

/**
 * Delete a single item by ID
 * @param {string} id - The item ID to delete
 * @returns {Promise<boolean>} true if deleted successfully
 */
async function deleteItem(id) {
  console.log("[DB] 🗑️ deleteItem called for id:", id);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.delete(id);
    req.onsuccess = () => {
      console.log("[DB] ✅ Item deleted:", id);
      resolve(true);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/**
 * Delete ALL items from the store
 * @returns {Promise<boolean>} true if cleared successfully
 */
async function deleteAll() {
  console.log("[DB] 🗑️🗑️ deleteAll() called - clearing entire store");
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const req = store.clear();

    req.onsuccess = () => {
      console.log("[DB] ✅ All items deleted successfully");
      resolve(true);
    };

    req.onerror = () => {
      console.error("[DB] ❌ deleteAll failed:", req.error);
      reject(req.error);
    };

    tx.oncomplete = () => {
      console.log("[DB] 🔒 Transaction complete, closing DB");
      db.close();
    };

    tx.onerror = () => {
      console.error("[DB] ❌ Transaction error in deleteAll:", tx.error);
      reject(tx.error);
    };
  });
}

// ====================== UTILITY QUERIES ======================

/**
 * Get items by JAV code
 * @param {string} code - The code to search for (e.g., "juq")
 * @returns {Promise<Array>} Matching items
 */
async function getItemsByCode(code) {
  console.log("[DB] 🔍 getItemsByCode called for code:", code);
  return getAll({ index: "codeIndex", value: code, exactMatch: true });
}

/**
 * Get items by episode number
 * @param {string} episode - The episode to search for (e.g., "373")
 * @returns {Promise<Array>} Matching items
 */
async function getItemsByEpisode(episode) {
  console.log("[DB] 🔍 getItemsByEpisode called for episode:", episode);
  return getAll({ index: "episodeIndex", value: episode, exactMatch: true });
}

/**
 * Get items by name (text search across all items)
 * @param {string} name - The name/text to search for
 * @returns {Promise<Array>} Matching items
 */
async function getItemsByName(name) {
  console.log("[DB] 🔍 getItemsByName called for name:", name);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const items = [];
    const tx = db.transaction([STORE_NAME], "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        if (cursor.value.name === name || cursor.value.text === name) {
          items.push(cursor.value);
        }
        cursor.continue();
      } else {
        console.log(
          `[DB] 📊 Found ${items.length} items matching name "${name}"`,
        );
        resolve(items);
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

/**
 * Get total count of items in the store
 * @returns {Promise<number>} Number of items
 */
async function getCount() {
  console.log("[DB] 🔢 getCount() called");
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_NAME], "readonly");
    const store = tx.objectStore(STORE_NAME);
    const req = store.count();
    req.onsuccess = () => {
      console.log("[DB] 📊 Total items count:", req.result);
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => db.close();
  });
}

console.log("[DB] ✅ db.js loaded successfully");
