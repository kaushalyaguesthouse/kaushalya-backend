const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const { createClient } = require("@supabase/supabase-js");
require("dotenv").config();

const app = express();

/* =========================================
   MIDDLEWARE
========================================= */

app.use(
  cors({
    origin: [
      "https://kaushalyaguesthouse.github.io",
      "http://localhost:3000",
      "http://127.0.0.1:5500"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

app.use(express.json());

/* =========================================
   CLEAN ENVIRONMENT VARIABLES
========================================= */

function cleanEnv(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

const SUPABASE_URL = cleanEnv(process.env.SUPABASE_URL);
const SUPABASE_ANON_KEY = cleanEnv(process.env.SUPABASE_ANON_KEY);
const RAZORPAY_KEY_ID = cleanEnv(process.env.RAZORPAY_KEY_ID);
const RAZORPAY_KEY_SECRET = cleanEnv(
  process.env.RAZORPAY_KEY_SECRET
);

/* =========================================
   ENVIRONMENT VALIDATION
========================================= */

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing Supabase environment variables.");
  process.exit(1);
}

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.error("Missing Razorpay environment variables.");
  process.exit(1);
}

if (
  !RAZORPAY_KEY_ID.startsWith("rzp_live_") &&
  !RAZORPAY_KEY_ID.startsWith("rzp_test_")
) {
  console.error("Invalid Razorpay Key ID format.");
  process.exit(1);
}

/* =========================================
   SUPABASE CONNECTION
========================================= */

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

/* =========================================
   RAZORPAY CONNECTION
========================================= */

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

/* =========================================
   HOME / HEALTH CHECK
========================================= */

app.get("/", (req, res) => {
  res.status(200).send(
    "Kaushalya Guest House Backend Running"
  );
});
/* =========================================
   ENVIRONMENT CHECK (TEMPORARY)
========================================= */

app.get("/env-check", (req, res) => {
  res.json({
    razorpay_key_id: RAZORPAY_KEY_ID,
    secret_loaded: Boolean(RAZORPAY_KEY_SECRET),
    secret_length: RAZORPAY_KEY_SECRET.length,
    key_mode: RAZORPAY_KEY_ID.startsWith("rzp_live_")
      ? "live"
      : "test"
  });
});
/* =========================================
   CREATE RAZORPAY ORDER
========================================= */

app.post("/create-order", async (req, res) => {
  try {
    const amount = Number(req.body.amount);

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment amount."
      });
    }

    const amountInPaise = Math.round(amount * 100);

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `KGH_${Date.now()}`,
      notes: {
        business: "Kaushalya Guest House",
        payment_type: "30% Advance"
      }
    });

    return res.status(200).json({
      success: true,
      order_id: order.id,
      amount: order.amount,
      currency: order.currency
    });
  } catch (error) {
    console.error(
      "RAZORPAY ORDER ERROR:",
      error?.error?.description ||
      error?.message ||
      error
    );

    return res.status(
      error?.statusCode || 500
    ).json({
      success: false,
      message:
        error?.error?.description ||
        error?.message ||
        "Unable to create Razorpay order."
    });
  }
});

/* =========================================
   CREATE BOOKING
========================================= */

app.post("/create-booking", async (req, res) => {
  try {
    const {
      customer_name,
      phone,
      email,
      room_type,
      check_in,
      check_out,
      adults,
      children,
      payment_type,
      payment_status,
      razorpay_payment_id,
      amount,
      special_request
    } = req.body;

    if (
      !customer_name ||
      !phone ||
      !email ||
      !room_type ||
      !check_in ||
      !check_out
    ) {
      return res.status(400).json({
        success: false,
        message: "Required booking information is missing."
      });
    }

    const checkInDate = new Date(check_in);
    const checkOutDate = new Date(check_out);

    if (
      Number.isNaN(checkInDate.getTime()) ||
      Number.isNaN(checkOutDate.getTime()) ||
      checkOutDate <= checkInDate
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Check-out date must be after the check-in date."
      });
    }

    const bookingId = `KGH-${Date.now()}`;

    const booking = {
      booking_id: bookingId,
      customer_name: String(customer_name).trim(),
      phone: String(phone).trim(),
      email: String(email).trim().toLowerCase(),
      room_type,
      check_in,
      check_out,
      adults: Number(adults) || 1,
      children: Number(children) || 0,
      payment_type:
        payment_type || "Pay Later",
      payment_status:
        payment_status || "Pending",
      razorpay_payment_id:
        razorpay_payment_id || null,
      amount: Number(amount) || 0,
      booking_status: "Confirmed",
      refund_status: "N/A",
      special_request:
        String(special_request || "").trim()
    };

    const { data, error } = await supabase
      .from("bookings")
      .insert([booking])
      .select();

    if (error) {
      console.error(
        "SUPABASE BOOKING ERROR:",
        error.message
      );

      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    return res.status(201).json({
      success: true,
      booking_id: bookingId,
      booking: data
    });
  } catch (error) {
    console.error(
      "CREATE BOOKING ERROR:",
      error?.message || error
    );

    return res.status(500).json({
      success: false,
      message:
        error?.message ||
        "Unable to create booking."
    });
  }
});

/* =========================================
   START SERVER
========================================= */

const PORT = Number(process.env.PORT) || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Kaushalya backend running on port ${PORT}`
  );
});
