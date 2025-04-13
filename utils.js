const { DateTime } = require("luxon");
const admin = require("firebase-admin");


function getHourDifference(currentDate, targetDate) {
  const diffMs = Math.abs(currentDate - targetDate); // Absolute difference in milliseconds
  const diffHours = diffMs / (1000 * 60 * 60); // Convert milliseconds to hours
  return { diffHours }; // Return the difference in hours
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function getMilitaryTime(date) {
  const hours = date.getHours(); // Get the hour (0-23)
  const minutes = date.getMinutes(); // Get the minutes (0-59)

  // Pad hours and minutes with leading zeros if needed
  const militaryHours = hours.toString().padStart(2, '0');
  const militaryMinutes = minutes.toString().padStart(2, '0');

  return `${militaryHours}:${militaryMinutes}`;
}
  

function getApproachingSchedule(snapshot){
  const medicineArray = [];
  snapshot.forEach((doc) => {
    const data = doc.data();
    const { intervalType, intervalValue, medicineDose, medicineName, time, date, slotNumber } = data;
    currentIntervalType = intervalType;
    currentIntervalValue = intervalValue;
    console.log(`Processing medicine: ${medicineName}`);
    console.log(`Details - Interval Type: ${intervalType}, Interval Value: ${intervalValue}, Dose: ${medicineDose}, Time: ${time}, Date: ${date}`);
    medicineArray.push({ intervalType, intervalValue, medicineDose, medicineName, time, date, slotNumber });
  });

  const approachingSchedules = medicineArray.filter((medicine) => {
    const currentDate = new Date();
    const { diffHours } = getHourDifference(currentDate, medicine.date.toDate());
    return diffHours <= 1; // Filter for schedules within the next hour
  });

  const sortedApproachingScheds = approachingSchedules.sort((a, b) => {
    const dateA = getHourDifference(new Date(), a.date.toDate()).diffHours;
    const dateB = getHourDifference(new Date(), b.date.toDate()).diffHours;
    return dateA - dateB; // Sort by date in ascending order
  });

  return sortedApproachingScheds;
}

// gets how much time have past accepts date and int
function isMoreThanHoursAgo(date, hours) {
  if (!(date instanceof Date) || isNaN(date)) {
    throw new Error("Invalid Date object provided.");
  }
  if (typeof hours !== 'number' || hours < 0) {
    throw new Error("Invalid number of hours.");
  }

  const now = new Date();
  const msAgo = now - date;
  const hoursInMs = hours * 60 * 60 * 1000;

  return msAgo > hoursInMs;
}

function getNextSchedule(snapshot) {
  const currentTime = new Date(); // Get the current time

  const filteredDocs = snapshot.docs
    .map(doc => {
      const data = doc.data(); // Get the document data

      // Ensure document has 'Scheduled' status and 'time' is a Firestore Timestamp
      if (data.status === 'Scheduled' && data.time instanceof admin.firestore.Timestamp) {
        // Convert Firestore Timestamp to JavaScript Date
        const scheduleTime = data.time.toDate();
        return { id: doc.id, ...data, scheduleTime };
      }
    })
    .filter(doc => doc !== undefined)  // Remove undefined entries (those that didn't meet the criteria)
    .filter(doc => doc.scheduleTime > currentTime);  // Only future schedules

  // Sort documents by scheduleTime (ascending order)
  const sortedArray = filteredDocs.sort((a, b) => a.scheduleTime - b.scheduleTime);

  // Return the sorted array of schedules, with the closest one to now being first
  return sortedArray;
}



module.exports = { getHourDifference, addHours, getMilitaryTime, getApproachingSchedule, isMoreThanHoursAgo, getNextSchedule};
