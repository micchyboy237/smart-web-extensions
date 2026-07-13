async function demo() {
  try {
    // Create
    const newId = await createItem({
      name: "Test Feature",
      value: true,
      date: new Date().toISOString(),
    });
    console.log("Created with ID:", newId);

    // Read
    const item = await readItem(newId);
    console.log("Read item:", item);

    // Update
    await updateItem({ id: newId, name: "Updated Feature", value: false });

    // Read all
    const all = await readAllItems();
    console.log("All items:", all);

    // Delete
    await deleteItem(newId);
  } catch (err) {
    console.error("IndexedDB error:", err);
  }
}

// Call demo() when needed (e.g., on extension load or button click)
