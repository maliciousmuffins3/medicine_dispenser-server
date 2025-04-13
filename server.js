const express = require("express");
const bodyParser = require("body-parser");
const { db, rtdb } = require("./firebase");
const {
  addHours,
  getHourDifference,
  getMilitaryTime,
  getApproachingSchedule,
  getNextSchedule,
} = require("./utils");

const port = 3000;
const app = express();

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get("/get-schedule", async (req, res) => {
  console.log("Received request on /get-schedule endpoint");

  const { UID } = req.query;
  if (!UID) return res.status(400).json({ error: "UID is required" });

  try {
    const medicineRef = db.collection("medicines").doc(UID).collection("schedules");
    const medicineSnapshot = await medicineRef.get();

    if (medicineSnapshot.empty) {
      return res.status(404).json({ error: "No medicines found" });
    }

    const medicineArray = medicineSnapshot.docs.map((doc) => doc.data());
    const nameValues = medicineArray.map((med) => med.medicineName);

    const stocksRef = rtdb.ref(`stocks/${UID}`);
    const stockSnap = await stocksRef.once("value");
    const stockData = stockSnap.val();

    if (stockData) {
      const invalidKeys = Object.keys(stockData).filter((k) => !nameValues.includes(k));
      if (invalidKeys.length > 0) {
        const deleteOps = Object.fromEntries(invalidKeys.map((k) => [k, null]));
        await stocksRef.update(deleteOps);
        console.log("Deleted invalid stock keys:", invalidKeys);
      }
    }

    const historyRef = db.collection("history").doc(UID).collection("medications");
    const historySnapshot = await historyRef.get();

    const batch = db.batch();
    const now = new Date();

    for (const doc of historySnapshot.docs) {
      const data = doc.data();
      const time = data.time?.toDate?.();
      const status = data.status;

      if (!data.medicineName) continue;

      if (!nameValues.includes(data.medicineName)) {
        batch.delete(doc.ref);
        continue;
      }

      if (time && time < now && now - time >= 3600000 && status !== "Missed") {
        batch.update(doc.ref, { status: "Missed" });

        const medicine = medicineArray.find((m) => m.medicineName === data.medicineName);
        if (!medicine) continue;

        let newTime = new Date(time.getTime());
        do {
          newTime = new Date(newTime.getTime() + medicine.intervalValue * 3600000);
        } while (newTime < new Date());

        const scheduledTime = getMilitaryTime(newTime);

        await historyRef.add({
          medicineName: medicine.medicineName,
          medicineDose: medicine.medicineDose,
          time: newTime,
          scheduledTime,
          status: "Scheduled",
        });
      }
    }

    await batch.commit();

    const updatedHistorySnapshot = await historyRef.get();
    const nextSchedule = getNextSchedule(updatedHistorySnapshot)?.[0];

    if (!nextSchedule) return res.status(200).json({ message: "No upcoming schedule found" });

    const convertedTime = nextSchedule.time.toDate();
    nextSchedule.time = new Date(convertedTime).toISOString();

    const nextRef = rtdb.ref(`nextSchedule/${UID}`);
    const currentNextSnap = await nextRef.get();
    const currentData = currentNextSnap.exists() ? currentNextSnap.val() : null;

    if (
      typeof nextSchedule === "object" &&
      Object.keys(nextSchedule).length > 0 &&
      JSON.stringify(currentData) !== JSON.stringify(nextSchedule)
    ) {
      await nextRef.set(nextSchedule);
      console.log("Updated next schedule in RTDB.");
    } else {
      console.log("Skipped next schedule update due to no change or invalid data.");
    }

    const sorted = getApproachingSchedule(medicineSnapshot);
    return res.status(200).json(sorted[0]);
  } catch (err) {
    console.error("Error in /get-schedule:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/update-schedule", async (req, res) => {
  const { UID } = req.body;
  if (!UID) return res.status(400).json({ error: "UID is required" });

  try {
    const schedRef = db.collection("medicines").doc(UID).collection("schedules");
    const snapshot = await schedRef.get();

    if (snapshot.empty) {
      await rtdb.ref(`/nextSchedule/${UID}`).remove();
      return res.status(404).json({ error: "No schedules found" });
    }

    const currentSchedule = getApproachingSchedule(snapshot)[0];
    if (!currentSchedule)
      return res.status(404).json({ error: "No approaching schedule" });

    const { medicineName, medicineDose, intervalType, intervalValue } = currentSchedule;
    const historyQuery = db
      .collection("history")
      .doc(UID)
      .collection("medications")
      .where("medicineName", "==", medicineName)
      .where("dose", "==", medicineDose)
      .where("status", "==", "Scheduled")
      .limit(1);

    const historySnap = await historyQuery.get();
    if (historySnap.empty)
      return res.status(404).json({ error: "History not found" });

    const historyDocRef = historySnap.docs[0].ref;
    await historyDocRef.update({ status: "Taken", taken: true });

    if (intervalType === "once") {
      await deleteOneTimeMedication(UID, medicineName, medicineDose);
      return res.status(200).json({ message: "One-time medicine taken and cleaned up." });
    }

    const nextTime = addHours(new Date(), Number(intervalValue));
    const nextTimeStr = getMilitaryTime(nextTime);

    await db.collection("history").doc(UID).collection("medications").add({
      medicineName,
      dose: medicineDose,
      status: "Scheduled",
      scheduledTime: nextTimeStr,
      time: nextTime,
    });

    const currentMedQuery = schedRef
      .where("medicineName", "==", medicineName)
      .where("medicineDose", "==", medicineDose)
      .limit(1);

    const currentMedSnap = await currentMedQuery.get();
    if (!currentMedSnap.empty) {
      const medDocRef = currentMedSnap.docs[0].ref;
      await medDocRef.update({ date: nextTime, time: nextTimeStr });
    }

    return res.status(200).json({ message: "Medicine schedule updated" });
  } catch (error) {
    console.error("Error in /update-schedule:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});

async function deleteOneTimeMedication(UID, medicineName, medicineDose) {
  const schedRef = db.collection("medicines").doc(UID).collection("schedules");
  const query = schedRef
    .where("medicineName", "==", medicineName)
    .where("medicineDose", "==", medicineDose)
    .limit(1);
  const snap = await query.get();
  if (!snap.empty) await snap.docs[0].ref.delete();

  await rtdb.ref(`/stocks/${UID}/${medicineName}`).remove();
  await rtdb.ref(`/nextSchedule/${UID}`).remove();
}

app.delete("/delete-next-schedule", async (req, res) => {
  const { UID } = req.query;
  if (!UID) return res.status(400).json({ error: "UID is required" });
  const nextScheduleRef = rtdb.ref(`/nextSchedule/${UID}`);
  try {
    await nextScheduleRef.remove();
    console.log(`Next schedule for UID ${UID} deleted successfully.`);
    res.status(200).json({ message: "Next schedule deleted successfully" });
  } catch (error) {
    console.error("Error deleting next schedule:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/initial-config", async (req, res) => {
  const { UID } = req.body;
  if (!UID) return res.status(400).json({ error: "UID is required" });

  const nextScheduleData = {
    isDispensing: false,
    isLocked: false,
    notifyCaregiver: true,
  };

  try {
    const configRef = rtdb.ref(`config/${UID}`);
    await configRef.set(nextScheduleData);
    console.log("Configuration has been set.");

    return res.status(200).json({ message: "Configuration has been set successfully." });
  } catch (e) {
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

app.delete("/reconcile-history", async (req, res) => {
  console.log("Received request on /reconcile-history");

  const { UID } = req.query;
  if (!UID) return res.status(400).json({ error: "UID is required" });

  try {
    const medicineRef = db.collection("medicines").doc(UID).collection("schedules");
    const medicineSnapshot = await medicineRef.get();

    const validMedicineNames = medicineSnapshot.docs.map(doc => doc.data().medicineName);
    if (validMedicineNames.length === 0) {
      return res.status(404).json({ error: "No medicines found in schedules." });
    }

    const historyRef = db.collection("history").doc(UID).collection("medications");
    const historySnapshot = await historyRef.get();

    const batch = db.batch();
    let deletedHistory = [];
    let orphanMedicines = new Set(validMedicineNames);

    for (const doc of historySnapshot.docs) {
      const data = doc.data();
      const medicineName = data.medicineName;

      if (!validMedicineNames.includes(medicineName)) {
        batch.delete(doc.ref);
        deletedHistory.push(medicineName);
        console.log(`Deleting orphaned history record: ${medicineName}`);
      } else {
        orphanMedicines.delete(medicineName);
      }
    }

    if (deletedHistory.length > 0) {
      await batch.commit();
    }

    const medicinesWithNoHistory = Array.from(orphanMedicines);

    return res.status(200).json({
      deletedHistoryCount: deletedHistory.length,
      deletedHistoryNames: deletedHistory,
      medicinesWithNoHistory: medicinesWithNoHistory,
    });
  } catch (err) {
    console.error("Error in /reconcile-history:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port http://localhost:${port}/`);
});
