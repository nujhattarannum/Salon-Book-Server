import express from 'express'

const app = express()
const port = 8000

import { MongoClient } from 'mongodb';

const client = new MongoClient("mongodb://<db_username>:<db_password>@ac-hrb3vmm-shard-00-00.nn38hyu.mongodb.net:27017,ac-hrb3vmm-shard-00-01.nn38hyu.mongodb.net:27017,ac-hrb3vmm-shard-00-02.nn38hyu.mongodb.net:27017/?ssl=true&replicaSet=atlas-7y92q9-shard-0&authSource=admin");

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}


app.get('/', (req, res) => {
  res.send('Hello World!')
})

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})