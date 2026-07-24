const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Razorpay = require("razorpay");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

app.get("/", (req, res) => {
  res.send("Kaushalya Guest House Backend is Running");
});

app.post("/create-booking", async (req, res) => {
  try {

    const bookingId = "KGH-" + Date.now();

    const booking = {
      booking_id: bookingId,
      customer_name: req.body.customer_name,
      phone: req.body.phone,
      email: req.body.email,
      room_type: req.body.room_type,
      check_in: req.body.check_in,
      check_out: req.body.check_out,
      adults: req.body.adults,
      children: req.body.children,
      payment_type: req.body.payment_type,
      payment_status: "Pending",
      amount: req.body.amount,
      booking_status: "Pending",
      refund_status: "N/A",
      special_request: req.body.special_request
    };

    const { data, error } = await supabase
      .from("bookings")
      .insert([booking]);

    if (error) {
      return res.status(400).json(error);
    }

    res.json({
      success: true,
      booking_id: bookingId,
      booking: data
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      message: err.message
    });
  }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
