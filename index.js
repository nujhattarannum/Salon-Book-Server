import express from 'express'
import { MongoClient } from 'mongodb';
import 'dotenv/config'
import cors from 'cors'

const app = express()
const port = 8000

app.use(cors())

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

// APi To fetch salon services in the homepage 
app.get("/services", async (req, res) => {
  try {
    const services = await database.collection("services")
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

app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
  connectToMongoDB();
})