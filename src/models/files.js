const mongoose = require('mongoose')

const File = new mongoose.Schema({
  schemaVersion: { type: Number, required: true },
  createdTimestamp: { type: String, required: true }, // Time file was uploaded.
  size: { type: Number, required: true }, // size of the file in bytes
  payloadLink: { type: String }, // IPFS hash of current file.
  txId: { type: String }, // Memo transaction Id
  meta: { type: Object },
  bchAddr: { type: String }, // BCH address assigned to this file.
  hasBeenPaid: { type: Boolean, default: false }, // Flag if hosting cost has been paid.
  pinExpires: { type: String }, // ISO date when IPFS pin for hosted content will expire.
  hostingCost: { type: Number } // Value in satoshis of the hosting cost for this file.
})

module.exports = mongoose.model('file', File)
