const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const Razorpay = require("razorpay");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());


// SUPABASE CONNECTION

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);


// RAZORPAY CONNECTION

const razorpay = new Razorpay({

  key_id: process.env.RAZORPAY_KEY_ID,

  key_secret: process.env.RAZORPAY_KEY_SECRET

});



// TEST ROUTE

app.get("/", (req,res)=>{

res.send("Kaushalya Guest House Backend is Running");

});




// CREATE RAZORPAY ORDER

app.post("/create-order", async (req,res)=>{


try{


const options = {


amount: req.body.amount * 100,

currency:"INR",

receipt:"KGH_"+Date.now()


};



const order = await razorpay.orders.create(options);



res.json({

success:true,

order:{
  
id:order.id,

amount:order.amount,

currency:order.currency


});



}

catch(error){


console.log("RAZORPAY ORDER ERROR:",error);


res.status(500).json({

success:false,

message:error.message

});


}


});






// CREATE BOOKING


app.post("/create-booking", async(req,res)=>{


try{


const bookingId="KGH-"+Date.now();



const booking={


booking_id:bookingId,


customer_name:req.body.customer_name,


phone:req.body.phone,


email:req.body.email,


room_type:req.body.room_type,


check_in:req.body.check_in,


check_out:req.body.check_out,


adults:req.body.adults || 1,


children:req.body.children || 0,


payment_type:req.body.payment_type,


payment_status:req.body.payment_status || "Pending",


razorpay_payment_id:req.body.razorpay_payment_id || null,


amount:req.body.amount,


booking_status:"Pending",


refund_status:"N/A",


special_request:req.body.special_request



};




const {data,error}=await supabase

.from("bookings")

.insert([booking])

.select();



if(error){


console.log("SUPABASE ERROR:",error);


return res.status(400).json({

success:false,

message:error.message

});


}



res.json({

success:true,

booking_id:bookingId,

booking:data


});



}


catch(err){


console.log("SERVER ERROR:",err);


res.status(500).json({

success:false,

message:err.message

});


}



});





const PORT=process.env.PORT || 10000;



app.listen(PORT,()=>{


console.log(`Server running on port ${PORT}`);


});
