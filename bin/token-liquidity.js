/*
  Liquidity app for SLP BCH tokens inspired by Bancors whitepaper
*/

'use strict'

// const lib = require('../src/lib/token-util.js')
// const got = require('got')

const SLP = require('../src/lib/slp')
const slp = new SLP()

const BCH = require('../src/lib/bch')
const bch = new BCH()

// Queue Library
// const Queue = require('./queue')
// const queue = new Queue()

const { default: PQueue } = require('p-queue')
const queue = new PQueue({ concurrency: 1 })

// App utility functions library.
const TLUtils = require('../src/lib/util')
const tlUtil = new TLUtils()

// const Transactions = require('../src/lib/transactions')
// const txs = new Transactions()

const TokenLiquidity = require('../src/lib/token-liquidity')
const lib = new TokenLiquidity()

// Add the queue to the token-liquidity library
lib.queue = queue

const config = require('../config')
config.bchBalance = config.BCH_QTY_ORIGINAL
config.tokenBalance = config.TOKENS_QTY_ORIGINAL

// Winston logger
const wlogger = require('../src/lib/wlogger')

// Used for debugging.
const util = require('util')
util.inspect.defaultOptions = {
  showHidden: true,
  colors: true
}

// const BCH_ADDR1 = config.BCH_ADDR
// const TOKEN_ID = config.TOKEN_ID

const FIVE_MINUTES = 60000 * 5
const CONSOLIDATE_INTERVAL = 60000 * 100
const PRICE_UPDATE_INTERVAL = 60000 * 5
let timerHandle

let bchBalance
let tokenBalance

async function startTokenLiquidity () {
  // Read in the state file.
  try {
    const state = tlUtil.readState()
    console.log(`state: ${JSON.stringify(state, null, 2)}`)
  } catch (err) {
    wlogger.error('Could not read state.json file.')
  }

  // Get BCH balance.
  const addressInfo = await bch.getBCHBalance(config.BCH_ADDR, false)
  bchBalance = addressInfo.balance
  config.bchBalance = bchBalance
  wlogger.info(
    `BCH address ${config.BCH_ADDR} has a balance of ${bchBalance} BCH`
  )

  // console.log(`addressInfo: ${JSON.stringify(addressInfo, null, 2)}`)

  // Get all the TXIDs associated with this apps address. The app assumes all
  // these TXs have been processed.
  const seenTxs = addressInfo.txids
  // console.log(`seenTxs: ${JSON.stringify(seenTxs, null, 2)}`)

  // Get SLP token balance
  tokenBalance = await slp.getTokenBalance(config.SLP_ADDR)
  wlogger.info(
    `SLP token address ${config.SLP_ADDR} has a balance of: ${tokenBalance} PSF`
  )
  config.tokenBalance = tokenBalance

  // Get the BCH-USD exchange rate.
  const USDperBCH = await lib.getPrice()

  // Calculate exchange rate spot price.;
  const marketCap = USDperBCH * bchBalance
  console.log(`Market cap of BCH controlled by app: $${marketCap}`)
  const price = lib.getSpotPrice(bchBalance, USDperBCH)
  console.log(`Token spot price: $${price}`)

  // Kick off the processing loop. It periodically checks for new transactions
  // and reacts to them.
  timerHandle = setInterval(async function () {
    await processingLoop(seenTxs)
  }, 60000 * 2)

  // Interval to consolidate UTXOs (maintenance)
  setInterval(async function () {
    await bch.consolidateUtxos()
  }, CONSOLIDATE_INTERVAL)

  // Interval to update BCH spot price.
  setInterval(async function () {
    console.log('Updating BCH price.')
    await lib.getPrice()
  }, PRICE_UPDATE_INTERVAL)

  // Periodically write out status information to the log file. This ensures
  // the log file is created every day and the the /logapi route works.
  setInterval(function () {
    const state = tlUtil.readState()
    const effBal = lib.getEffectiveTokenBalance(state.bchBalance)

    wlogger.info(
      `usdPerBCH: ${state.usdPerBCH}, ` +
      `BCH balance: ${state.bchBalance}, ` +
      `Actual token balance: ${state.tokenBalance}, ` +
      `Effective token balance: ${effBal}`
    )
  }, 60000 * 60) // 1 hour
}

// This 'processing loop' function is called periodically to identify and process
// any new transactions.
async function processingLoop (seenTxs) {
  try {
    const now = new Date()
    let outStr = `${now.toLocaleString()}: Checking transactions... `

    const obj = {
      seenTxs
    }

    const newTxids = await lib.detectNewTxs(obj)
    // console.log(`retObj: ${JSON.stringify(retObj, null, 2)}`)

    // If there are no new transactions, exit.
    if (newTxids.length === 0) {
      // Retrieve the balances from the blockchain.
      const retObj2 = await lib.getBlockchainBalances(config.BCH_ADDR)
      // console.log(`retObj2: ${JSON.stringify(retObj2, null, 2)}`)

      // Update the app balances.
      bchBalance = retObj2.bchBalance
      tokenBalance = retObj2.tokenBalance

      outStr += `...nothing new. BCH: ${bchBalance}, SLP: ${tokenBalance}`
      console.log(`${outStr}`)
      console.log(' ')

      return
    }

    // Add the new txids to the seenTxs array.
    newTxids.map(x => seenTxs.push(x.txid))

    outStr += `...${newTxids.length} new transactions found!`
    console.log(`${outStr}`)

    // process the new TX.
    for (let i = 0; i < newTxids.length; i++) {
      const obj = {
        txid: newTxids[i].txid,
        bchBalance,
        tokenBalance
      }

      // TODO: Instead of calling processTx(), call p-retry so that it will
      // retry processTx() several times if it errors out.
      console.log(' ')
      console.log(' ')
      console.log(
        `Processing new transaction with this data: ${JSON.stringify(
          obj,
          null,
          2
        )}`
      )

      clearInterval(timerHandle)

      // const result = await queue.pRetryProcessTx(obj)
      const result = await queue.add(() => lib.pRetryProcessTx(obj))
      console.log(`queue.size: ${queue.size}`)
      // console.log(`result: ${JSON.stringify(result, null, 2)}`)

      // If the app received tokens, send them to the 245 path.
      if (result.type === 'token') {
        // Wait before moving tokens, allows previous transaction to get picked
        // up by the network. Prevents race-condition.
        wlogger.debug('Waiting 2 minutes before moving tokens...')
        await sleep(60000 * 2)

        const obj = { tokenQty: result.tokenQty }
        await queue.add(() => slp.moveTokens(obj))
      }

      // Update the app balances. This temporarily updates the app balances until
      // processing is complete, at which time the app can get its balance from
      // an indexer.
      bchBalance = result.bchBalance
      tokenBalance = result.tokenBalance
      console.log(`BCH: ${bchBalance}, SLP: ${tokenBalance}`)
      console.log(' ')

      // Sleep for 5 minutes to give Blockbook time to process the last transaction.
      // If result.txid === null, it's a self-generated TX, so we don't need to wait.
      if (result.txid !== null) {
        await waitForBlockbook(seenTxs)
      }

      timerHandle = setInterval(async function () {
        await processingLoop(seenTxs)
      }, 60000 * 2)
    }
  } catch (err) {
    wlogger.error('Error in token-liquidity.js.', err)
    console.log(' ')
    console.log('Err: ', err)
  }
}

// Sleep for 5 minutes to give Blockbook time to process the last transaction.
// Disables the processing loop while it waits.
async function waitForBlockbook (seenTxs) {
  const now = new Date()
  wlogger.info(
    `${now.toLocaleString()}: Waiting 5 minutes before processing next transaction...`
  )

  // clearInterval(timerHandle)
  await sleep(FIVE_MINUTES)
  console.log('...continuing processing.')
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = {
  startTokenLiquidity
}