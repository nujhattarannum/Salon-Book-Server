import express from 'express'
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config'
import cors from 'cors'

const app = express()
const port = 8000

app.use(
  cors({
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    credentials: true,
  })
);
app.use(express.json());

const client = new MongoClient(process.env.MONGODB_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}
const database = client.db("SalonBook");
const servicesCollection = database.collection("services");
const appointmentsCollection = database.collection("appointments");
// APi To fetch salon services in the homepage 
app.get("/services", async (req, res) => {
  try {
    const services = await servicesCollection
      .find({ isActive: true })
      .toArray();

    res.status(200).json(services);
  } catch (error) {
    console.error("Error fetching services:", error);

    res.status(500).json({
      message: "Failed to fetch salon services",
    });
  }
});

// GET /services/:id -> Single Service Details
// ==========================================
app.get("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Validate MongoDB ObjectId format
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid service ID format." });
    }

    const service = await servicesCollection.findOne({ _id: new ObjectId(id) });

    if (!service) {
      return res.status(404).json({ message: "Service not found." });
    }

    res.status(200).json({ service });
  } catch (error) {
    console.error("Error fetching service details:", error);
    res.status(500).json({ message: "Failed to fetch service details." });
  }
});


// POST appoinments from /service/:id
app.post("/appointments", async (req, res) => {
  try {
    const { serviceId, customerId, date, time, notes } = req.body;

    if (!serviceId || !customerId || !date || !time) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    if (!ObjectId.isValid(serviceId)) {
      return res.status(400).json({ message: "Invalid service ID." });
    }

    const service = await servicesCollection.findOne({
      _id: new ObjectId(serviceId),
    });

    if (!service || (!service.isActive && service.status !== "active")) {
      return res.status(400).json({ message: "Service is unavailable or inactive." });
    }

    const conflict = await appointmentsCollection.findOne({
      serviceId: new ObjectId(serviceId),
      appointmentDate: date,
      timeSlot: time,
      status: { $in: ["pending", "confirmed"] },
    });

    if (conflict) {
      return res.status(409).json({ message: "This time slot is already booked." });
    }

    const newAppointment = {
      serviceId: new ObjectId(serviceId),
      customerId: ObjectId.isValid(customerId) ? new ObjectId(customerId) : customerId,
      appointmentDate: date,
      timeSlot: time,
      message: (notes || "").trim(),
      servicePrice: Number(service.price),
      paymentStatus: "unpaid",
      status: "pending",
      createdAt: new Date(),
    };

    const result = await appointmentsCollection.insertOne(newAppointment);
    res.status(201).json({
      message: "Appointment request submitted.",
      appointment: { _id: result.insertedId, ...newAppointment },
    });
  } catch (err) {
    console.error("Error creating appointment:", err);
    res.status(500).json({ 
      message: "Failed to create appointment.",
    error: err.message, });
  }
});

//Api to fetch the statistics data in Admin Dashboard Overview
app.get("/admin/stats", requireAdmin, async (req, res) => {
  try {
    const [
      totalCustomers,
      totalServices,
      totalAppointments,
      pendingAppointments,
      confirmedAppointments,
      successfulPayments,
    ] = await Promise.all([
      usersCollection.countDocuments({ role: { $ne: "admin" } }),
      servicesCollection.countDocuments({ isActive: true }),
      appointmentsCollection.countDocuments({}),
      appointmentsCollection.countDocuments({ status: "pending" }),
      appointmentsCollection.countDocuments({ status: "confirmed" }),
      appointmentsCollection.countDocuments({ paymentStatus: "paid" }),
    ]);

    res.json({
      stats: {
        totalCustomers,
        totalServices,
        totalAppointments,
        pendingAppointments,
        confirmedAppointments,
        successfulPayments,
      },
    });
  } catch (err) {
    console.error("GET /admin/stats error:", err);
    res.status(500).json({ message: "Failed to load admin stats." });
  }
});
app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
  connectToMongoDB();
})