// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ===== USE Tracking98 Trigger ===== //
 *
 * Triggers the tracking98 box when LP price drops below 98% of oracle.
 * This is a prerequisite for the intervention bot — intervention can only
 * fire after tracking98 has been triggered for >20 blocks.
 *
 * Transaction Structure:
 *   INPUTS:  [0] Tracking98 Box  [1+] Fee payer (wallet)
 *   DATA:    [0] Oracle Box      [1] LP Box
 *   OUTPUTS: [0] Tracking98 (R7=HEIGHT)  [1] Miner Fee  [2] Change
 *
 * Usage:
 *   node trigger-tracking98.mjs --check     # status only (default)
 *   node trigger-tracking98.mjs --dry-run   # sign via node, don't submit
 *   node trigger-tracking98.mjs --execute   # sign + submit
 *
 * Environment:
 *   ERGO_WALLET_MNEMONIC  — BIP39 mnemonic (for fee box address derivation)
 *   API_KEY               — Ergo node API key
 *   ERGO_NODE_URL         — Node URL (default: http://localhost:9053)
 *   ERGO_EXPLORER_URL     — Explorer API (default: https://api.ergoplatform.com/api/v1)
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env file if present
try {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  for (const envFile of ['.env', '.env.local']) {
    try {
      const envContent = readFileSync(resolve(__dirname, envFile), 'utf8');
      for (const line of envContent.split('\n')) {
        const trimmed = line.trim().replace(/^export\s+/, '');
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
          val = val.slice(1, -1);
        if (!process.env[key]) process.env[key] = val;
      }
    } catch (e) { /* file not found, skip */ }
  }
} catch (e) { /* env loading optional */ }

// ===== Configuration ===== //

const ERGO_EXPLORER = process.env.ERGO_EXPLORER_URL || 'https://api.ergoplatform.com/api/v1';
const LOCAL_NODE = process.env.ERGO_NODE_URL || 'http://localhost:9053';
const FALLBACK_NODE = process.env.ERGO_FALLBACK_NODE_URL || '';

// USE ecosystem token IDs
const USE_TOKEN_ID = 'a55b8735ed1a99e46c2c89f8994aacdf4b1109bdcf682f1e5b34479c6e392669';
const USE_LP_NFT = '4ecaa1aac9846b1454563ae51746db95a3a40ee9f8c5f5301afbe348ae803d41';
const TRACKING_98_NFT = '47472f675d7791462520d78b6c676e65c23b7c11ca54d73d3e031aadb5d56be2';
const ORACLE_POOL_NFT = '6a2b821b5727e85beb5e78b4efb9f0250d59cd48481d2ded2c23e91ba1d07c66';

const INT_MAX = 2147483647;
const TX_FEE = 1_100_000n;
const MIN_BOX_VALUE = 1_000_000n;
const MINER_FEE_ERGO_TREE = "1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a701730073011001020402d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304";


// ===== API Functions ===== //

async function fetchJsonSafe(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  const text = await response.text();
  return JSON.parse(text.replace(/:(\s*)(\d{12,})(\s*[,\}\]])/g, ':"$2"$3'));
}

async function findBoxByNft(nftId) {
  const data = await fetchJsonSafe(`${ERGO_EXPLORER}/boxes/unspent/byTokenId/${nftId}`);
  if (!data.items?.length) throw new Error(`Box not found for NFT: ${nftId}`);
  return data.items[0];
}

async function getUtxos(address) {
  return (await fetchJsonSafe(`${ERGO_EXPLORER}/boxes/unspent/byAddress/${address}`)).items || [];
}

async function getCurrentHeight() {
  try {
    const r = await fetch(`${LOCAL_NODE}/info`, { signal: AbortSignal.timeout(5000) });
    if (r.ok) return (await r.json()).fullHeight;
  } catch (e) { /* fall through */ }
  if (FALLBACK_NODE) {
    const r = await fetch(`${FALLBACK_NODE}/info`);
    return (await r.json()).fullHeight;
  }
  throw new Error('Cannot reach any Ergo node');
}

async function getActiveNode() {
  try {
    const r = await fetch(`${LOCAL_NODE}/info`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) return LOCAL_NODE;
  } catch (e) { /* fall through */ }
  if (FALLBACK_NODE) return FALLBACK_NODE;
  throw new Error('Cannot reach any Ergo node');
}


// ===== Wallet Functions ===== //

let ergolib = null;
async function loadErgoLib() {
  if (!ergolib) ergolib = await import('ergo-lib-wasm-nodejs');
  return ergolib;
}

async function initWallet(lib) {
  const mnemonic = process.env.ERGO_WALLET_MNEMONIC;
  if (!mnemonic) throw new Error('ERGO_WALLET_MNEMONIC not set');
  const seed = lib.Mnemonic.to_seed(mnemonic, '');
  const root = lib.ExtSecretKey.derive_master(seed);
  const path = lib.DerivationPath.new(0, new Uint32Array([0]));
  const derived = root.derive(path);
  return {
    address: derived.public_key().to_address().to_base58(lib.NetworkPrefix.Mainnet),
    secretKey: lib.SecretKey.dlog_from_bytes(derived.secret_key_bytes())
  };
}


// ===== State Parsing ===== //

function parseOracleRate(oracleBox) {
  const r4 = oracleBox.additionalRegisters?.R4;
  if (!r4) throw new Error('Oracle box missing R4');
  return BigInt(typeof r4 === 'object' ? r4.renderedValue : r4) / 1000n;
}

function parseLpReserves(lpBox) {
  const ergReserve = BigInt(lpBox.value);
  let useReserve = 0n;
  for (const a of lpBox.assets) {
    if (a.tokenId === USE_TOKEN_ID) { useReserve = BigInt(a.amount); break; }
  }
  return { ergReserve, useReserve };
}

function parseTracking98(trackingBox) {
  const regs = trackingBox.additionalRegisters || {};
  const getVal = (reg, def) => {
    const r = regs[reg];
    return r ? (typeof r === 'object' ? r.renderedValue : r) : def;
  };
  const r7 = parseInt(getVal('R7', String(INT_MAX)));
  return {
    num: parseInt(getVal('R4', '98')),
    denom: parseInt(getVal('R5', '100')),
    isBelow: getVal('R6', 'true') === 'true' || getVal('R6', true) === true,
    trackerHeight: r7,
    isReset: r7 >= INT_MAX,
    isTriggered: r7 < INT_MAX
  };
}


// ===== Transaction Building ===== //

async function buildTriggerTx(lib, trackingBox, oracleBox, lpBox, feeBoxes, walletAddress, height) {
  const trackingErg = BigInt(trackingBox.value);

  // OUTPUT 0: Tracking98 successor
  const trackTree = lib.ErgoTree.from_base16_bytes(trackingBox.ergoTree);
  const trackOut = new lib.ErgoBoxCandidateBuilder(
    lib.BoxValue.from_i64(lib.I64.from_str(trackingErg.toString())),
    lib.Contract.new(trackTree), height
  );

  for (const asset of trackingBox.assets) {
    trackOut.add_token(
      lib.TokenId.from_str(asset.tokenId),
      lib.TokenAmount.from_i64(lib.I64.from_str(String(asset.amount)))
    );
  }

  // Preserve R4, R5, R6; set R7 = HEIGHT
  const regs = trackingBox.additionalRegisters || {};
  for (const reg of ['R4', 'R5', 'R6']) {
    const data = regs[reg];
    if (data) {
      const hex = typeof data === 'string' ? data : data.serializedValue;
      if (hex) trackOut.set_register_value(lib.NonMandatoryRegisterId[reg], lib.Constant.decode_from_base16(hex));
    }
  }
  trackOut.set_register_value(lib.NonMandatoryRegisterId.R7, lib.Constant.from_i32(height));

  // OUTPUT 1: Miner Fee
  const feeOut = new lib.ErgoBoxCandidateBuilder(
    lib.BoxValue.from_i64(lib.I64.from_str(TX_FEE.toString())),
    lib.Contract.new(lib.ErgoTree.from_base16_bytes(MINER_FEE_ERGO_TREE)), height
  );

  // OUTPUT 2: Change
  const feeTotal = feeBoxes.reduce((s, b) => s + BigInt(b.value), 0n);
  const changeAmt = feeTotal - TX_FEE;

  const outputs = new lib.ErgoBoxCandidates(trackOut.build());
  outputs.add(feeOut.build());

  if (changeAmt >= MIN_BOX_VALUE) {
    const changeOut = new lib.ErgoBoxCandidateBuilder(
      lib.BoxValue.from_i64(lib.I64.from_str(changeAmt.toString())),
      lib.Contract.pay_to_address(lib.Address.from_base58(walletAddress)), height
    );
    outputs.add(changeOut.build());
  }

  // INPUTS
  const inputs = new lib.UnsignedInputs();
  inputs.add(lib.UnsignedInput.from_box_id(lib.BoxId.from_str(trackingBox.boxId)));
  for (const box of feeBoxes) {
    inputs.add(lib.UnsignedInput.from_box_id(lib.BoxId.from_str(box.boxId)));
  }

  // DATA-INPUTS
  const dataInputs = new lib.DataInputs();
  dataInputs.add(new lib.DataInput(lib.BoxId.from_str(oracleBox.boxId)));
  dataInputs.add(new lib.DataInput(lib.BoxId.from_str(lpBox.boxId)));

  // Balance check
  const inTotal = trackingErg + feeTotal;
  const outTotal = trackingErg + TX_FEE + (changeAmt >= MIN_BOX_VALUE ? changeAmt : 0n);
  if (inTotal !== outTotal) throw new Error(`Balance mismatch: ${inTotal} != ${outTotal}`);

  return {
    unsignedTx: new lib.UnsignedTransaction(inputs, dataInputs, outputs,
      lib.BoxValue.from_i64(lib.I64.from_str(MIN_BOX_VALUE.toString()))),
    inputBoxes: [trackingBox, ...feeBoxes]
  };
}


// ===== Node Signing & Submission ===== //

async function getBoxRaw(boxId, nodeUrl) {
  const r = await fetch(`${nodeUrl}/utxo/withPool/byIdBinary/${boxId}`);
  if (!r.ok) throw new Error(`Box ${boxId.slice(0,16)}... not in UTXO set (${r.status}) — may be spent`);
  return (await r.json()).bytes;
}

async function signAndSubmitViaNode(unsignedTx, inputBoxes, dataInputBoxes, nodeUrl, dryRun) {
  const unsignedJson = JSON.parse(unsignedTx.to_json());

  console.log('   Fetching inputsRaw...');
  const inputsRaw = [];
  for (const box of inputBoxes) inputsRaw.push(await getBoxRaw(box.boxId, nodeUrl));
  const dataInputsRaw = [];
  for (const box of dataInputBoxes) dataInputsRaw.push(await getBoxRaw(box.boxId, nodeUrl));

  console.log('   Signing via node...');
  const signResponse = await fetch(`${nodeUrl}/wallet/transaction/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api_key': process.env.API_KEY || '' },
    body: JSON.stringify({ tx: unsignedJson, inputsRaw, dataInputsRaw })
  });

  if (!signResponse.ok) {
    throw new Error(`Node signing failed (${signResponse.status}): ${(await signResponse.text()).slice(0, 300)}`);
  }

  const signedJson = await signResponse.json();

  if (dryRun) return { id: signedJson.id, signedJson, source: 'node (dry-run)' };

  console.log('   Submitting...');
  const submitResponse = await fetch(`${nodeUrl}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api_key': process.env.API_KEY || '' },
    body: JSON.stringify(signedJson)
  });

  if (!submitResponse.ok) {
    throw new Error(`Submission failed (${submitResponse.status}): ${(await submitResponse.text()).slice(0, 300)}`);
  }

  return { id: (await submitResponse.text()).replace(/"/g, ''), signedJson, source: 'node' };
}


// ===== Main ===== //

async function main() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║     USE Tracking98 Trigger v1.0.0         ║');
  console.log('╚═══════════════════════════════════════════╝');

  const args = process.argv.slice(2);
  const isCheck = args.includes('--check') || args.length === 0;
  const isDryRun = args.includes('--dry-run') || args.includes('-d');
  const isExecute = args.includes('--execute') || args.includes('-x');

  const mode = isExecute ? 'EXECUTE' : (isDryRun ? 'DRY-RUN' : 'CHECK');
  console.log(`\nMode: ${mode}`);

  let lib = null, wallet = null;
  if (isDryRun || isExecute) {
    lib = await loadErgoLib();
    console.log('✓ ergo-lib loaded');
    wallet = await initWallet(lib);
    console.log(`✓ Wallet: ${wallet.address.slice(0, 20)}...`);
  }

  console.log('\nFetching blockchain state...');
  const [trackingBox, oracleBox, lpBox, height] = await Promise.all([
    findBoxByNft(TRACKING_98_NFT), findBoxByNft(ORACLE_POOL_NFT),
    findBoxByNft(USE_LP_NFT), getCurrentHeight()
  ]);

  console.log(`✓ Tracking98: ${trackingBox.boxId.slice(0, 16)}...`);
  console.log(`✓ Oracle:     ${oracleBox.boxId.slice(0, 16)}...`);
  console.log(`✓ LP:         ${lpBox.boxId.slice(0, 16)}...`);
  console.log(`✓ Height:     ${height}`);

  const oracleRate = parseOracleRate(oracleBox);
  const { ergReserve, useReserve } = parseLpReserves(lpBox);
  const tracking = parseTracking98(trackingBox);

  const lpRate = ergReserve * 1_000_000n / useReserve;
  const ratioPercent = (lpRate * 10000n) / (oracleRate * 1_000_000n);
  const ratioDisplay = Number(ratioPercent) / 100;

  console.log(`\n${'─'.repeat(50)}`);
  console.log('              TRACKING98 STATUS');
  console.log('─'.repeat(50));
  console.log(`\n   Oracle:  ${(Number(oracleRate) / 1e6).toFixed(4)} ERG/USE`);
  console.log(`   LP:      ${(Number(lpRate) / 1e12).toFixed(4)} ERG/USE`);
  console.log(`   Ratio:   ${ratioDisplay.toFixed(2)}% ${ratioDisplay < 98 ? '⚠️  BELOW 98%' : '✅'}`);
  console.log(`   State:   ${tracking.isReset ? '🔴 RESET' : `🟢 TRIGGERED @ ${tracking.trackerHeight}`}`);

  // Validate
  const conditionMet = ergReserve * BigInt(tracking.denom) < BigInt(tracking.num) * oracleRate * useReserve;
  const issues = [];
  if (!tracking.isReset) issues.push('Tracking98 is already TRIGGERED');
  if (!conditionMet) issues.push(`LP rate ${ratioDisplay.toFixed(2)}% is NOT below 98%`);

  console.log(`\n   ${issues.length === 0 ? '✅ TRIGGER CONDITIONS MET' : '❌ CANNOT TRIGGER'}`);
  for (const issue of issues) console.log(`      • ${issue}`);
  console.log('─'.repeat(50));

  if (isCheck || issues.length > 0) return;

  // Fee box selection — CRITICAL: only token-free boxes
  const allBoxes = await getUtxos(wallet.address);
  const tokenFree = allBoxes.filter(b => !b.assets || b.assets.length === 0);
  if (!tokenFree.length) throw new Error('SAFETY ABORT: No token-free fee boxes. Send plain ERG to wallet first.');

  tokenFree.sort((a, b) => { const va = BigInt(a.value), vb = BigInt(b.value); return va < vb ? -1 : va > vb ? 1 : 0; });
  const selectedFee = [];
  let feeSum = 0n;
  for (const box of tokenFree) {
    selectedFee.push(box);
    feeSum += BigInt(box.value);
    if (feeSum >= TX_FEE + MIN_BOX_VALUE) break;
  }
  if (feeSum < TX_FEE + MIN_BOX_VALUE) throw new Error(`SAFETY ABORT: Token-free ERG insufficient (${(Number(feeSum)/1e9).toFixed(4)})`);

  const nodeUrl = await getActiveNode();
  const freshHeight = (await (await fetch(`${nodeUrl}/info`)).json()).fullHeight;

  console.log(`\n   Node:    ${nodeUrl}`);
  console.log(`   Height:  ${freshHeight}`);
  console.log(`   Fee:     ${selectedFee.length} box(es), ${(Number(feeSum)/1e9).toFixed(4)} ERG`);
  console.log(`   R7:      ${freshHeight}`);

  const { unsignedTx, inputBoxes } = await buildTriggerTx(
    lib, trackingBox, oracleBox, lpBox, selectedFee, wallet.address, freshHeight
  );

  if (isDryRun) {
    console.log(`\n=== Dry Run ===`);
    const result = await signAndSubmitViaNode(unsignedTx, inputBoxes, [oracleBox, lpBox], nodeUrl, true);
    console.log(`\n   ✅ TX valid: ${result.id}`);
    console.log(`   Not submitted. Use --execute to submit.`);
    return;
  }

  console.log(`\n=== Executing ===`);
  const result = await signAndSubmitViaNode(unsignedTx, inputBoxes, [oracleBox, lpBox], nodeUrl, false);
  console.log(`\n✅ SUCCESS: https://explorer.ergoplatform.com/en/transactions/${result.id}`);
  console.log(`\n⏱️  Wait >20 blocks, then run intervention bot.`);
}

main().catch(err => { console.error('\n❌', err.message); process.exit(1); });
