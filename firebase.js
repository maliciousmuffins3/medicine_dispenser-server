const admin = require("firebase-admin");
require('dotenv').config(); 


// const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG)

admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
  }),
  databaseURL: "https://medicine-dispenser-38b4e-default-rtdb.asia-southeast1.firebasedatabase.app"
});

const db = admin.firestore();
const rtdb = admin.database();


module.exports = {
  db,rtdb
};