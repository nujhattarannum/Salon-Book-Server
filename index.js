import express from 'express'
import { MongoClient, ObjectId } from 'mongodb';
import 'dotenv/config'
import cors from 'cors'
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
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
const usersCollection = database.collection("user");
const paymentsCollection = database.collection("payments");
const appointmentsCollection = database.collection("appointments");

const AUTH_URL = process.env.BETTER_AUTH_URL;

// Backend Session Helper function
async function getBetterAuthSession(req) {
  try {
    const cookieHeader = req.headers.cookie;
    if (!cookieHeader) return null;

    const res = await fetch(`${AUTH_URL}/api/auth/get-session`, {
      method: "GET",
      headers: {
        cookie: cookieHeader,
      },
    });

    if (!res.ok) return null;

    const data = await res.json();
    if (!data?.user) return null;

    // Fetch latest role & isBlocked status from MongoDB user collection
    const email = data.user.email?.toLowerCase();
    const id = data.user.id;

    const query = [];
    if (id) {
      query.push({ id: String(id) });
      if (ObjectId.isValid(String(id))) {
        query.push({ _id: new ObjectId(String(id)) });
      }
    }
    if (email) {
      query.push({ email });
    }

    const dbUser = query.length
      ? await usersCollection.findOne({ $or: query })
      : null;

    return {
      session: data.session,
      user: {
        ...data.user,
        ...(dbUser || {}),
        id: dbUser?.id || String(dbUser?._id || data.user.id),
        role: dbUser?.role || data.user.role || "customer",
        isBlocked: Boolean(dbUser?.isBlocked ?? data.user.isBlocked ?? false),
      },
    };
  } catch (err) {
    console.error("getBetterAuthSession error:", err);
    return null;
  }
}

// Middleware to get the authenticated user straight from authData.user
async function requireAuth(req, res, next) {
  const authData = await getBetterAuthSession(req);
  if (!authData?.user) {
    return res.status(401).json({ message: "Unauthorized. Please sign in." });
  }
  if (authData.user.isBlocked) {
    return res.status(403).json({ message: "Your account has been blocked." });
  }
  req.authUser = authData.user;
  next();
}

async function requireAdmin(req, res, next) {
  const authData = await getBetterAuthSession(req);
  if (!authData?.user) {
    return res.status(401).json({ message: "Unauthorized. Please sign in." });
  }
  if (authData.user.isBlocked) {
    return res.status(403).json({ message: "Your account has been blocked." });
  }
  if (authData.user.role !== "admin") {
    return res.status(403).json({ message: "Forbidden. Admin access only." });
  }
  req.authUser = authData.user;
  next();
}

// API to fetch salon services in the homepage
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
app.get("/services/:id", async (req, res) => {
  try {
    const { id } = req.params;

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

// POST appointments from /service/:id
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
      return res
        .status(400)
        .json({ message: "Service is unavailable or inactive." });
    }

    const conflict = await appointmentsCollection.findOne({
      serviceId: new ObjectId(serviceId),
      appointmentDate: date,
      timeSlot: time,
      status: { $in: ["pending", "confirmed"] },
    });

    if (conflict) {
      return res
        .status(409)
        .json({ message: "This time slot is already booked." });
    }

    const newAppointment = {
      serviceId: new ObjectId(serviceId),
      customerId: ObjectId.isValid(customerId)
        ? new ObjectId(customerId)
        : customerId,
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
      error: err.message,
    });
  }
});

// API to fetch the statistics data in Admin Dashboard Overview
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

// API to get all appointments for Admin
app.get("/admin/appointments", requireAdmin, async (req, res) => {
  try {
    const appointments = await appointmentsCollection
      .aggregate([
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "services",
            localField: "serviceId",
            foreignField: "_id",
            as: "serviceDoc",
          },
        },
        {
          $unwind: { path: "$serviceDoc", preserveNullAndEmptyArrays: true },
        },
        {
          $addFields: {
            customerObjId: {
              $cond: [
                { $eq: [{ $type: "$customerId" }, "objectId"] },
                "$customerId",
                {
                  $convert: {
                    input: "$customerId",
                    to: "objectId",
                    onError: null,
                    onNull: null,
                  },
                },
              ],
            },
          },
        },
        {
          $lookup: {
            from: "user",
            localField: "customerObjId",
            foreignField: "_id",
            as: "customerDoc",
          },
        },
        {
          $unwind: { path: "$customerDoc", preserveNullAndEmptyArrays: true },
        },
        {
          $project: {
            serviceId: 1,
            serviceName: "$serviceDoc.name",
            customerId: 1,
            customerName: "$customerDoc.name",
            customerEmail: "$customerDoc.email",
            appointmentDate: 1,
            timeSlot: 1,
            servicePrice: 1,
            paymentStatus: 1,
            status: 1,
            message: 1,
            createdAt: 1,
          },
        },
      ])
      .toArray();

    res.json({ appointments });
  } catch (err) {
    console.error("GET /admin/appointments error:", err);
    res.status(500).json({ message: "Failed to load appointments." });
  }
});

// API to confirm / update appointment status from Admin
app.patch("/admin/appointments/:id/status", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const allowedStatuses = ["pending", "confirmed", "completed", "cancelled"];

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid appointment ID." });
    }

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({ message: "Invalid status value." });
    }

    const updated = await appointmentsCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { status, updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!updated) {
      return res.status(404).json({ message: "Appointment not found." });
    }

    res.json({ message: "Appointment status updated.", appointment: updated });
  } catch (err) {
    console.error("PATCH /admin/appointments/:id/status error:", err);
    res.status(500).json({ message: "Failed to update appointment status." });
  }
});

// List all services (including inactive) for Admin
app.get("/admin/services", requireAdmin, async (req, res) => {
  try {
    const services = await servicesCollection
      .find({})
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    res.json({ services });
  } catch (err) {
    console.error("GET /admin/services error:", err);
    res.status(500).json({ message: "Failed to load services." });
  }
});

// Update existing service (or toggle isActive)
app.put("/admin/services/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid service ID." });
    }

    const updates = { updatedAt: new Date() };
    if (req.body.name !== undefined) updates.name = String(req.body.name).trim();
    if (req.body.category !== undefined)
      updates.category = String(req.body.category).trim();
    if (req.body.description !== undefined)
      updates.description = String(req.body.description).trim();
    if (req.body.price !== undefined) updates.price = Number(req.body.price);
    if (req.body.duration !== undefined)
      updates.duration = Number(req.body.duration);
    if (req.body.image !== undefined)
      updates.image = String(req.body.image).trim();
    if (req.body.isActive !== undefined)
      updates.isActive = Boolean(req.body.isActive);

    const result = await servicesCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: updates },
      { returnDocument: "after" }
    );
    if (!result) {
      return res.status(404).json({ message: "Service not found." });
    }
    res.json({
      message: "Service updated successfully.",
      service: result,
    });
  } catch (err) {
    console.error("PUT /admin/services/:id error:", err);
    res.status(500).json({ message: "Failed to update service." });
  }
});

// Create new service
app.post("/admin/services", requireAdmin, async (req, res) => {
  try {
    const { name, category, description, price, duration, image, isActive } =
      req.body;

    if (!name?.trim() || !category?.trim() || !description?.trim()) {
      return res
        .status(400)
        .json({ message: "Name, category, and description are required." });
    }

    const numericPrice = Number(price);
    const numericDuration = Number(duration);

    if (Number.isNaN(numericPrice) || numericPrice <= 0) {
      return res
        .status(400)
        .json({ message: "Price must be a positive number." });
    }

    if (Number.isNaN(numericDuration) || numericDuration <= 0) {
      return res
        .status(400)
        .json({ message: "Duration must be a positive number." });
    }

    const doc = {
      name: name.trim(),
      category: category.trim(),
      description: description.trim(),
      price: numericPrice,
      duration: numericDuration,
      image: (image || "").trim(),
      isActive: Boolean(isActive ?? true),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await servicesCollection.insertOne(doc);
    res.status(201).json({
      message: "Service created successfully.",
      service: { _id: result.insertedId, ...doc },
    });
  } catch (err) {
    console.error("POST /admin/services error:", err);
    res.status(500).json({ message: "Failed to create service." });
  }
});

// Delete service
app.delete("/admin/services/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid service ID." });
    }

    const result = await servicesCollection.deleteOne({
      _id: new ObjectId(id),
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Service not found." });
    }

    res.json({ message: "Service deleted successfully." });
  } catch (err) {
    console.error("DELETE /admin/services/:id error:", err);
    res.status(500).json({ message: "Failed to delete service." });
  }
});

function buildUserFilter(id) {
  return ObjectId.isValid(id)
    ? { $or: [{ _id: new ObjectId(id) }, { id }] }
    : { id };
}

// API to get users in (Manage Users) in Admin
app.get("/admin/users", requireAdmin, async (req, res) => {
  try {
    const users = await usersCollection
      .find({}, { projection: { password: 0 } })
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    res.json({ users });
  } catch (err) {
    console.error("GET /admin/users error:", err);
    res.status(500).json({ message: "Failed to load users." });
  }
});

// API to change user's role from Manage Users in Admin
app.patch("/admin/users/:id/role", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;

    if (!["customer", "admin"].includes(role)) {
      return res.status(400).json({ message: "Invalid role." });
    }

    const updated = await usersCollection.findOneAndUpdate(
      buildUserFilter(id),
      { $set: { role, updatedAt: new Date() } },
      { returnDocument: "after", projection: { password: 0 } }
    );

    if (!updated) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({ message: "User role updated.", user: updated });
  } catch (err) {
    console.error("PATCH /admin/users/:id/role error:", err);
    res.status(500).json({ message: "Failed to update user role." });
  }
});

// API to block a user from Admin
app.patch("/admin/users/:id/block", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { isBlocked } = req.body;

    const updated = await usersCollection.findOneAndUpdate(
      buildUserFilter(id),
      { $set: { isBlocked: Boolean(isBlocked), updatedAt: new Date() } },
      { returnDocument: "after", projection: { password: 0 } }
    );

    if (!updated) {
      return res.status(404).json({ message: "User not found." });
    }

    res.json({
      message: isBlocked ? "User blocked." : "User unblocked.",
      user: updated,
    });
  } catch (err) {
    console.error("PATCH /admin/users/:id/block error:", err);
    res.status(500).json({ message: "Failed to update block status." });
  }
});

// API to read paid/payment records in Admin Transactions
app.get("/admin/transactions", requireAdmin, async (req, res) => {
  try {
    const fromPayments = await paymentsCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    if (fromPayments.length > 0) {
      return res.json({ transactions: fromPayments });
    }

    const paidAppointments = await appointmentsCollection
      .find({ paymentStatus: "paid" })
      .sort({ createdAt: -1 })
      .toArray();

    const transactions = paidAppointments.map((appt) => ({
      _id: appt._id,
      transactionId:
        appt.transactionId || String(appt._id).slice(-8).toUpperCase(),
      customerEmail: appt.customerEmail,
      serviceName: appt.serviceName || "Salon Service",
      amount: Number(appt.servicePrice || 0),
      status: appt.paymentStatus,
      createdAt: appt.createdAt || new Date(),
    }));

    res.json({ transactions });
  } catch (err) {
    console.error("GET /admin/transactions error:", err);
    res.status(500).json({ message: "Failed to load transactions." });
  }
});

function buildOwnershipQuery(user) {
  const owners = [];
  if (user?.id) {
    owners.push(String(user.id));
    if (ObjectId.isValid(String(user.id))) {
      owners.push(new ObjectId(String(user.id)));
    }
  }
  if (user?._id) {
    owners.push(user._id, String(user._id));
  }

  const conditions = [];
  if (owners.length > 0) conditions.push({ customerId: { $in: owners } });
  if (user?.email) conditions.push({ customerEmail: user.email });

  return conditions.length === 1 ? conditions[0] : { $or: conditions };
}

function isAppointmentOwnedByUser(appointment, user) {
  const ownerIds = new Set();
  if (user?.id) ownerIds.add(String(user.id));
  if (user?._id) ownerIds.add(String(user._id));

  const apptCustomerId = appointment?.customerId
    ? String(appointment.customerId)
    : "";
  const matchesId = apptCustomerId && ownerIds.has(apptCustomerId);
  const matchesEmail =
    user?.email &&
    appointment?.customerEmail &&
    String(appointment.customerEmail).toLowerCase() ===
      String(user.email).toLowerCase();

  return Boolean(matchesId || matchesEmail);
}

app.get("/customer/stats", requireAuth, async (req, res) => {
  try {
    const ownerFilter = buildOwnershipQuery(req.authUser);

    const [
      totalAppointments,
      pendingAppointments,
      confirmedAppointments,
      cancelledAppointments,
    ] = await Promise.all([
      appointmentsCollection.countDocuments(ownerFilter),
      appointmentsCollection.countDocuments({
        $and: [ownerFilter, { status: "pending" }],
      }),
      appointmentsCollection.countDocuments({
        $and: [ownerFilter, { status: "confirmed" }],
      }),
      appointmentsCollection.countDocuments({
        $and: [ownerFilter, { status: "cancelled" }],
      }),
    ]);

    res.json({
      stats: {
        totalAppointments,
        pendingAppointments,
        confirmedAppointments,
        cancelledAppointments,
      },
    });
  } catch (err) {
    console.error("GET /customer/stats error:", err);
    res.status(500).json({ message: "Failed to load customer stats." });
  }
});

app.get("/customer/appointments", requireAuth, async (req, res) => {
  try {
    const ownerFilter = buildOwnershipQuery(req.authUser);

    const appointments = await appointmentsCollection
      .aggregate([
        { $match: ownerFilter },
        { $sort: { createdAt: -1 } },
        {
          $addFields: {
            serviceObjId: {
              $cond: [
                { $eq: [{ $type: "$serviceId" }, "objectId"] },
                "$serviceId",
                {
                  $convert: {
                    input: "$serviceId",
                    to: "objectId",
                    onError: null,
                    onNull: null,
                  },
                },
              ],
            },
          },
        },
        {
          $lookup: {
            from: "services",
            localField: "serviceObjId",
            foreignField: "_id",
            as: "serviceDoc",
          },
        },
        {
          $unwind: { path: "$serviceDoc", preserveNullAndEmptyArrays: true },
        },
        {
          $project: {
            serviceId: 1,
            serviceName: {
              $ifNull: ["$serviceDoc.name", "$serviceName", "Salon Service"],
            },
            serviceImage: "$serviceDoc.image",
            serviceCategory: "$serviceDoc.category",
            serviceDuration: "$serviceDoc.duration",
            servicePrice: {
              $ifNull: ["$servicePrice", "$serviceDoc.price", 0],
            },
            appointmentDate: 1,
            timeSlot: 1,
            status: 1,
            paymentStatus: { $ifNull: ["$paymentStatus", "unpaid"] },
            message: 1,
            createdAt: 1,
          },
        },
      ])
      .toArray();

    res.json({ appointments });
  } catch (err) {
    console.error("GET /customer/appointments error:", err);
    res.status(500).json({ message: "Failed to load appointments." });
  }
});

// Cancel only customer's own pending appointment
app.patch("/customer/appointments/:id/cancel", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid appointment ID." });
    }

    const appointment = await appointmentsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found." });
    }

    if (!isAppointmentOwnedByUser(appointment, req.authUser)) {
      return res
        .status(403)
        .json({ message: "You can only cancel your own appointments." });
    }

    if (appointment.status !== "pending") {
      return res.status(400).json({
        message: `Cannot cancel an appointment that is already ${appointment.status}.`,
      });
    }

    const updated = await appointmentsCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      { $set: { status: "cancelled", updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    res.json({
      message: "Appointment request cancelled.",
      appointment: updated,
    });
  } catch (err) {
    console.error("PATCH /customer/appointments/:id/cancel error:", err);
    res.status(500).json({ message: "Failed to cancel appointment." });
  }
});

app.post( "/customer/appointments/:id/create-checkout-session",
  requireAuth,
  async (req, res) => {
    try {
      const { id } = req.params;
      if (!ObjectId.isValid(id)) {
        return res.status(400).json({ message: "Invalid appointment ID." });
      }

      const appointment = await appointmentsCollection.findOne({
        _id: new ObjectId(id),
      });

      if (!appointment) {
        return res.status(404).json({ message: "Appointment not found." });
      }

      if (!isAppointmentOwnedByUser(appointment, req.authUser)) {
        return res
          .status(403)
          .json({ message: "You can only pay for your own appointments." });
      }

      if (appointment.status !== "confirmed") {
        return res.status(400).json({
          message: "Payment is only allowed for confirmed appointments.",
        });
      }

      if (appointment.paymentStatus === "paid") {
        return res
          .status(400)
          .json({ message: "This appointment is already paid." });
      }

      let serviceDoc = null;
      if (
        appointment.serviceId &&
        ObjectId.isValid(String(appointment.serviceId))
      ) {
        serviceDoc = await servicesCollection.findOne({
          _id: new ObjectId(String(appointment.serviceId)),
        });
      }

      const serviceName =
        serviceDoc?.name || appointment.serviceName || "Salon Appointment";
      const priceDollars = Number(
        serviceDoc?.price ?? appointment.servicePrice ?? 0
      );

      if (Number.isNaN(priceDollars) || priceDollars <= 0) {
        return res.status(400).json({ message: "Invalid service price." });
      }

      const clientUrl = process.env.CLIENT_URL ;

      const checkoutSession = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["card"],
        customer_email: req.authUser.email || appointment.customerEmail,
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: serviceName,
                description: `Date: ${appointment.appointmentDate} at ${appointment.timeSlot}`,
              },
              unit_amount: Math.round(priceDollars * 100),
            },
            quantity: 1,
          },
        ],
        metadata: {
          appointmentId: String(appointment._id),
          customerId: String(req.authUser.id),
          customerEmail: req.authUser.email || "",
          serviceName,
        },
        success_url: `${clientUrl}/dashboard/customer/appointments?payment=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${clientUrl}/dashboard/customer/appointments?payment=cancelled`,
      });

      res.json({ url: checkoutSession.url });
    } catch (err) {
      console.error("Create checkout session error:", err);
      res.status(500).json({ message: "Failed to create checkout session." });
    }
  }
);

app.post("/customer/appointments/confirm-checkout", requireAuth, async (req, res) => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) {
        return res.status(400).json({ message: "Missing Stripe sessionId." });
      }

      const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId);

      if (checkoutSession.payment_status !== "paid") {
        return res
          .status(400)
          .json({ message: "Payment has not been completed." });
      }

      const appointmentId = checkoutSession.metadata?.appointmentId;
      if (!appointmentId || !ObjectId.isValid(appointmentId)) {
        return res
          .status(400)
          .json({ message: "Invalid appointment ID in session." });
      }

      const appointment = await appointmentsCollection.findOne({
        _id: new ObjectId(appointmentId),
      });

      if (!appointment || !isAppointmentOwnedByUser(appointment, req.authUser)) {
        return res.status(403).json({ message: "Unauthorized access." });
      }

      const updated = await appointmentsCollection.findOneAndUpdate(
        { _id: new ObjectId(appointmentId) },
        {
          $set: {
            paymentStatus: "paid",
            stripeSessionId: checkoutSession.id,
            paidAt: new Date(),
            updatedAt: new Date(),
          },
        },
        { returnDocument: "after" }
      );

      const existingPayment = await paymentsCollection.findOne({
        checkoutSessionId: checkoutSession.id,
      });

      if (!existingPayment) {
        await paymentsCollection.insertOne({
          transactionId: checkoutSession.payment_intent || checkoutSession.id,
          checkoutSessionId: checkoutSession.id,
          appointmentId: new ObjectId(appointmentId),
          customerId: String(req.authUser.id),
          customerEmail:
            req.authUser.email || checkoutSession.customer_email || "",
          serviceName:
            checkoutSession.metadata?.serviceName ||
            updated?.serviceName ||
            "Salon Service",
          amount: (checkoutSession.amount_total || 0) / 100,
          currency: checkoutSession.currency || "usd",
          status: "paid",
          createdAt: new Date(),
        });
      }

      res.json({
        message: "Payment verified and appointment marked as paid.",
        appointment: updated,
      });
    } catch (err) {
      console.error("Confirm checkout error:", err);
      res.status(500).json({ message: "Failed to verify payment." });
    }
  }
);

// API to pay for appointments
app.post("/customer/appointments/:id/pay", requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid appointment ID." });
    }

    const appointment = await appointmentsCollection.findOne({
      _id: new ObjectId(id),
    });

    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found." });
    }

    if (!isAppointmentOwnedByUser(appointment, req.authUser)) {
      return res
        .status(403)
        .json({ message: "You can only pay for your own appointments." });
    }

    if (appointment.status !== "confirmed") {
      return res.status(400).json({
        message: "Payment is only allowed for confirmed appointments.",
      });
    }

    if (appointment.paymentStatus === "paid") {
      return res
        .status(400)
        .json({ message: "This appointment is already paid." });
    }

    const updated = await appointmentsCollection.findOneAndUpdate(
      { _id: new ObjectId(id) },
      {
        $set: {
          paymentStatus: "paid",
          paidAt: new Date(),
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" }
    );

    res.json({
      message: "Payment completed successfully.",
      appointment: updated,
    });
  } catch (err) {
    console.error("POST /customer/appointments/:id/pay error:", err);
    res.status(500).json({ message: "Failed to process payment." });
  }
});

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
  connectToMongoDB();
});