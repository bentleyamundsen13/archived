// Firebase — powers accounts (Google + email) and cloud-synced collections.
//
// SETUP (one time, ~5 minutes — full steps in README.md):
//   1. console.firebase.google.com -> Add project
//   2. Build -> Authentication -> enable "Google" and "Email/Password"
//   3. Build -> Firestore Database -> Create (production mode) -> set the
//      security rules from README.md
//   4. Project settings -> "Your apps" -> Web app -> copy the config object
//      and paste it below, replacing the PASTE_ values.
//
// These config values are NOT secrets — they're safe to ship in frontend
// code. Access is controlled by the Firestore security rules, not by
// hiding these strings. (Your GROQ key is different — that stays on Netlify.)

import { initializeApp } from "firebase/app";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "firebase/auth";
import { getFirestore, doc, getDoc, setDoc } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyD9xPySJe-fLNfgIkAr23PlqtN_GEbUKPs",
  authDomain: "archived1.firebaseapp.com",
  projectId: "archived1",
  storageBucket: "archived1.firebasestorage.app",
  messagingSenderId: "231437180597",
  appId: "1:231437180597:web:58374b407dd66c5af3a8fc",
  measurementId: "G-1CJF9FG8MY",
};

// True once you've pasted a real config. Until then the app runs in
// guest mode only (localStorage) and explains how to enable accounts.
export const firebaseReady = !firebaseConfig.apiKey.startsWith("PASTE");

let auth = null;
let db = null;

if (firebaseReady) {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}

export function watchAuth(callback) {
  if (!firebaseReady) return () => {};
  return onAuthStateChanged(auth, callback);
}

export async function googleSignIn() {
  const provider = new GoogleAuthProvider();
  await signInWithPopup(auth, provider);
}

export async function emailSignUp(email, password) {
  await createUserWithEmailAndPassword(auth, email, password);
}

export async function emailSignIn(email, password) {
  await signInWithEmailAndPassword(auth, email, password);
}

export async function logOut() {
  if (auth) await signOut(auth);
}

// ---- per-user data: one document per user holding all collections ----

export async function loadUserData(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : { collections: [] };
}

export async function saveUserData(uid, data) {
  await setDoc(doc(db, "users", uid), data);
}
