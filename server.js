const express = require("express");
const cors = require("cors");
const Razorpay = require("razorpay");
const crypto = require("crypto");
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

app.use(express.json({ limit: "1mb" }));

/* =========================================
   ENVIRONMENT VARIABLES
========================================= */

function cleanEnv(value) {
  return String(value || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

const SUPABASE_URL = cleanEnv(
  process.env.SUPABASE_URL
);

const SUPABASE_ANON_KEY = cleanEnv(
  process.env.SUPABASE_ANON_KEY
);

const RAZORPAY_KEY_ID = cleanEnv(
  process.env.RAZORPAY_KEY_ID
);

const RAZORPAY_KEY_SECRET = cleanEnv(
  process.env.RAZORPAY_KEY_SECRET
);

/* =========================================
   VALIDATE ENVIRONMENT VARIABLES
========================================= */

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error(
    "Missing Supabase environment variables."
  );
  process.exit(1);
}

if (!RAZORPAY_KEY_ID || !RAZORPAY_KEY_SECRET) {
  console.error(
    "Missing Razorpay environment variables."
  );
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
   SUPABASE
========================================= */

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY
);

/* =========================================
   RAZORPAY
========================================= */


console.log("Razorpay credential check:", {
  keyId: RAZORPAY_KEY_ID,
  keyIdLength: RAZORPAY_KEY_ID?.length,
  secretLength: RAZORPAY_KEY_SECRET?.length
});

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET
});

/* =========================================
   HOME / HEALTH CHECK
========================================= */

app.get("/", (req, res) => {
  return res
    .status(200)
    .send("Kaushalya Guest House Backend Running");
});

/* =========================================
   CREATE RAZORPAY ORDER
========================================= */

app.post("/create-order", async (req, res) => {
  try {
    const amount = Number(req.body.amount);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Invalid payment amount."
      });
    }

    const amountInPaise = Math.round(amount * 100);

    if (amountInPaise < 100) {
      return res.status(400).json({
        success: false,
        message: "Payment amount is too low."
      });
    }

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
      currency: order.currency,
      key_id: RAZORPAY_KEY_ID
    });
  } catch (error) {
    const razorpayMessage =
      error?.error?.description ||
      error?.message ||
      "Unable to create Razorpay order.";

    const razorpayCode =
      error?.error?.code || "UNKNOWN_ERROR";

    const receivedStatus = Number(error?.statusCode);

    const statusCode =
      Number.isInteger(receivedStatus) &&
      receivedStatus >= 400 &&
      receivedStatus <= 599
        ? receivedStatus
        : 500;

    console.error("RAZORPAY ORDER ERROR:", {
      code: razorpayCode,
      message: razorpayMessage,
      statusCode
    });

    return res.status(statusCode).json({
      success: false,
      message: razorpayMessage,
      code: razorpayCode
    });
  }
});

/* =========================================
   VERIFY RAZORPAY PAYMENT
========================================= */

app.post("/verify-payment", (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature
    } = req.body;

    if (
      !razorpay_order_id ||
      !razorpay_payment_id ||
      !razorpay_signature
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Payment verification information is missing."
      });
    }

    const signatureBody =
      `${razorpay_order_id}|${razorpay_payment_id}`;

    const expectedSignature = crypto
      .createHmac("sha256", RAZORPAY_KEY_SECRET)
      .update(signatureBody)
      .digest("hex");

    const expectedBuffer = Buffer.from(
      expectedSignature,
      "utf8"
    );

    const receivedBuffer = Buffer.from(
      String(razorpay_signature),
      "utf8"
    );

    const isValid =
      expectedBuffer.length === receivedBuffer.length &&
      crypto.timingSafeEqual(
        expectedBuffer,
        receivedBuffer
      );

    if (!isValid) {
      return res.status(400).json({
        success: false,
        message:
          "Payment signature verification failed."
      });
    }

    return res.status(200).json({
      success: true,
      message: "Payment verified successfully."
    });
  } catch (error) {
    console.error(
      "PAYMENT VERIFICATION ERROR:",
      error?.message || error
    );

    return res.status(500).json({
      success: false,
      message: "Unable to verify payment."
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
        message:
          "Required booking information is missing."
      });
    }

    const checkInDate = new Date(
      `${check_in}T00:00:00`
    );

    const checkOutDate = new Date(
      `${check_out}T00:00:00`
    );

    if (
      Number.isNaN(checkInDate.getTime()) ||
      Number.isNaN(checkOutDate.getTime()) ||
      checkOutDate <= checkInDate
    ) {
      return res.status(400).json({
        success: false,
        message:
          "Check-out date must be after check-in."
      });
    }

    const numericAmount = Number(amount);

    if (
      !Number.isFinite(numericAmount) ||
      numericAmount < 0
    ) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking amount."
      });
    }

    const numericAdults = Math.max(
      Number.parseInt(adults, 10) || 1,
      1
    );

    const numericChildren = Math.max(
      Number.parseInt(children, 10) || 0,
      0
    );

    const bookingId = `KGH-${Date.now()}`;

    const booking = {
      booking_id: bookingId,
      customer_name: String(customer_name).trim(),
      phone: String(phone).trim(),
      email: String(email).trim().toLowerCase(),
      room_type: String(room_type).trim(),
      check_in,
      check_out,
      adults: numericAdults,
      children: numericChildren,
      payment_type:
        payment_type || "Pay Later",
      payment_status:
        payment_status || "Pending",
      razorpay_payment_id:
        razorpay_payment_id || null,
      amount: numericAmount,
      booking_status: "Confirmed",
      refund_status: "N/A",
      special_request: String(
        special_request || ""
      ).trim()
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
   CREATE REVIEW
========================================= */

app.post("/create-review", async (req, res) => {
  try {
    const {
      customer_name,
      customer_email,
      rating,
      review
    } = req.body;

    if (
      !customer_name ||
      !customer_email ||
      !rating ||
      !review
    ) {
      return res.status(400).json({
        success: false,
        message: "All review fields are required."
      });
    }

    const { error } = await supabase
      .from("reviews")
      .insert([
        {
          customer_name: String(customer_name).trim(),
          customer_email: String(customer_email).trim().toLowerCase(),
          rating: Number(rating),
          review: String(review).trim(),
          approved: false
        }
      ]);

    if (error) {
      console.error("SUPABASE REVIEW ERROR:", error);

      return res.status(400).json({
        success: false,
        message: error.message
      });
    }

    return res.status(201).json({
      success: true,
      message: "Review submitted successfully."
    });

  } catch (error) {

    console.error("CREATE REVIEW ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to submit review."
    });

  }
});
/* =========================================
   GET APPROVED REVIEWS
========================================= */

app.get("/reviews", async (req, res) => {
  try {

    const { data, error } = await supabase
      .from("reviews")
      .select("*")
      .eq("approved", true)
      .order("created_at", { ascending: false });

    if (error) {

      console.error("LOAD REVIEWS ERROR:", error);

      return res.status(400).json({
        success: false,
        message: error.message
      });

    }

    return res.status(200).json({
      success: true,
      reviews: data
    });

  } catch (error) {

    console.error("GET REVIEWS ERROR:", error);

    return res.status(500).json({
      success: false,
      message: "Unable to load reviews."
    });

  }
});
/* =========================================
   ROUTE NOT FOUND
========================================= */

app.use((req, res) => {
  return res.status(404).json({
    success: false,
    message: "Route not found."
  });
});

/* =========================================
   START SERVER
========================================= */

const PORT =
  Number(process.env.PORT) || 10000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Kaushalya backend running on port ${PORT}`
  );

  console.log(
    "Razorpay mode:",
    RAZORPAY_KEY_ID.startsWith("rzp_live_")
      ? "Live"
      : "Test"
  );

  console.log(
    "Razorpay credentials loaded:",
    Boolean(
      RAZORPAY_KEY_ID &&
      RAZORPAY_KEY_SECRET
    )
  );
});
