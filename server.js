const express = require("express");
const bodyParser = require("body-parser");
const { db, rtdb } = require("./firebase");
const nodemailer = require("nodemailer");

const {
  addHours,
  getHourDifference,
  getMilitaryTime,
  getApproachingSchedule,
  getNextSchedule,
  toLocalISOString
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
    const medicineRef = db
      .collection("medicines")
      .doc(UID)
      .collection("schedules");
    const medicineSnapshot = await medicineRef.get();

    if (medicineSnapshot.empty) {
      try {
        await rtdb.ref(`/nextSchedule/${UID}`).remove();
      } catch (error) {
        console.error("Error removing next schedule:", error);
      }
      return res.status(404).json({ error: "No medicines found" });
    }

    const medicineArray = medicineSnapshot.docs.map((doc) => doc.data());
    const nameValues = medicineArray.map((med) => med.medicineName);

    const stocksRef = rtdb.ref(`stocks/${UID}`);
    const stockSnap = await stocksRef.once("value");
    const stockData = stockSnap.val();

    if (stockData) {
      const invalidKeys = Object.keys(stockData).filter(
        (k) => !nameValues.includes(k)
      );
      if (invalidKeys.length > 0) {
        const deleteOps = Object.fromEntries(invalidKeys.map((k) => [k, null]));
        await stocksRef.update(deleteOps);
        console.log("Deleted invalid stock keys:", invalidKeys);
      }
    }

    const historyRef = db
      .collection("history")
      .doc(UID)
      .collection("medications");
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

        const medicine = medicineArray.find(
          (m) => m.medicineName === data.medicineName
        );
        if (!medicine) continue;

        let newTime = new Date(time.getTime());
        do {
          newTime = new Date(
            newTime.getTime() + medicine.intervalValue * 3600000
          );
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

    if (nextSchedule) {
      const convertedTime = nextSchedule.time.toDate();
      nextSchedule.time = toLocalISOString(new Date(convertedTime));

      const nextRef = rtdb.ref(`nextSchedule/${UID}`);
      const currentNextSnap = await nextRef.get();
      const currentData = currentNextSnap.exists()
        ? currentNextSnap.val()
        : null;

      if (
        typeof nextSchedule === "object" &&
        Object.keys(nextSchedule).length > 0 &&
        JSON.stringify(currentData) !== JSON.stringify(nextSchedule)
      ) {
        await nextRef.set(nextSchedule);
        console.log("Updated next schedule in RTDB.");
      } else {
        console.log(
          "Skipped next schedule update due to no change or invalid data."
        );
      }
    }
    else{
      try {
        await rtdb.ref(`/nextSchedule/${UID}`).remove();
      } catch (error) {
        console.error("Error removing next schedule:", error);
      }
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
    const schedRef = db
      .collection("medicines")
      .doc(UID)
      .collection("schedules");
    const snapshot = await schedRef.get();

    if (snapshot.empty) {
      await rtdb.ref(`/nextSchedule/${UID}`).remove();
      return res.status(404).json({ error: "No schedules found" });
    }

    const currentSchedule = getApproachingSchedule(snapshot)[0];
    if (!currentSchedule)
      return res.status(404).json({ error: "No approaching schedule" });

    const { medicineName, medicineDose, intervalType, intervalValue } =
      currentSchedule;
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
      return res
        .status(200)
        .json({ message: "One-time medicine taken and cleaned up." });
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

    return res
      .status(200)
      .json({ message: "Configuration has been set successfully." });
  } catch (e) {
    return res.status(500).json({ message: "Internal Server Error" });
  }
});

// Email cooldown map: { email: timestamp }
const emailCooldownMap = {};
const COOLDOWN_MS = 1000 * 60 * 5; // 5 minutes

// Nodemailer transporter
const transporter = nodemailer.createTransport({
  service: "gmail", // or another provider
  auth: {
    user: "medicine.dispenser.32@gmail.com",
    pass: "vsnxbmyiqsihturw",
  },
});

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

app.get("/email-reminder", async (req, res) => {
  // ✅ Trim email input to remove whitespace issues
  const email = (req.query.email || "").trim();

  // ❌ Basic validation failed
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ error: "Invalid or missing email" });
  }

  // ⏱️ Enforce cooldown
  const lastSent = emailCooldownMap[email];
  const now = Date.now();

  if (lastSent && now - lastSent < COOLDOWN_MS) {
    const secondsLeft = Math.ceil((COOLDOWN_MS - (now - lastSent)) / 1000);
    return res.status(429).json({
      error: `Cooldown active. Try again in ${secondsLeft} seconds.`,
    });
  }

  // 📩 Email content
  const htmlContent = `
    <div style="background-color: #e6f4ea; padding: 20px; border-radius: 8px; font-family: Arial, sans-serif; color: #2e7d32;">
      <h2 style="color: #2e7d32;">⏰ Time to Take Your Medicine!</h2>
      <p>Hey there! Just a friendly reminder to take your prescribed medication.</p>
      <p>Health is wealth — stay consistent and stay healthy 💊</p>
      <hr style="border-top: 1px solid #a5d6a7;">
      <p style="font-size: 12px; color: #388e3c;">Sent by your smart medication scheduler</p>
    </div>
  `;

  const mailOptions = {
    from: '"Medicine Dispenser" <medicine.dispenser.32@gmail.com>',
    to: email,
    subject: "⏰ Time to Take Your Medicine!",
    html: htmlContent,
  };

  try {
    await transporter.sendMail(mailOptions);
    emailCooldownMap[email] = now;
    console.log(`Email sent to ${email}`);
    return res.status(200).json({
      message: "Email sent successfully.",
      email,
    });
  } catch (error) {
    console.error("Error sending email:", error);
    return res.status(500).json({ error: "Failed to send email." });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port http://localhost:${port}/`);
});
