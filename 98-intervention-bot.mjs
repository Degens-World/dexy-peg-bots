// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * ===== USE 98% Intervention Bot ===== //
 *
 * Triggers bank intervention when USE LP price drops below 98% of oracle.
 * The bank buys USE from the LP using ERG reserves, pushing price toward peg.
 *
 * Prerequisites: tracking98 must be triggered for >20 blocks (use trigger-tracking98.mjs)
 *
 * Transaction Structure:
 *   INPUTS:  [0] LP  [1] Bank  [2] Intervention  [3+] Fee payer (wallet)
 *   DATA:    [0] Oracle  [1] Tracking98
 *   OUTPUTS: [0] LP (more ERG, less USE)  [1] Bank (less ERG, more USE)
 *            [2] Intervention (fresh height)  [3] Miner Fee  [4] Change
 *
 * Contract Constraints (intervention.es):
 *   T = 360 blocks between interventions
 *   T_int = 20 blocks tracking sustained (strict <, so need >20)
 *   Max 0.5% of bank ERG per intervention (contract allows 1%, we use half)
 *   Max 2% slippage, post-cap 99.5% of oracle
 *
 * Usage:
 *   node 98-intervention-bot.mjs --check     # status only (default)
 *   node 98-intervention-bot.mjs --dry-run   # sign via node, don't submit
 *   node 98-intervention-bot.mjs --execute   # sign + submit
 *
 * Environment:
 *   ERGO_WALLET_MNEMONIC  — BIP39 mnemonic (for fee box address derivation)
 *   API_KEY               — Ergo node API key
 *   ERGO_NODE_URL         — Node URL (default: http://localhost:9053)
 *   ERGO_EXPLORER_URL     — Explorer API (default: https://api.ergoplatform.com/api/v1)
 *   TELEGRAM_BOT_TOKEN    — Optional: Telegram notifications
 *   TELEGRAM_CHAT_ID      — Optional: Telegram chat ID
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
    } catch (e) { /* file not found */ }
  }
} catch (e) { /* env loading optional */ }

// ===== Configuration ===== //

const ERGO_EXPLORER = process.env.ERGO_EXPLORER_URL || 'https://api.ergoplatform.com/api/v1';
const LOCAL_NODE = process.env.ERGO_NODE_URL || 'http://localhost:9053';
const FALLBACK_NODE = process.env.ERGO_FALLBACK_NODE_URL || '';

const USE_TOKEN_ID = 'a55b8735ed1a99e46c2c89f8994aacdf4b1109bdcf682f1e5b34479c6e392669';
const USE_LP_NFT = '4ecaa1aac9846b1454563ae51746db95a3a40ee9f8c5f5301afbe348ae803d41';
const USE_BANK_NFT = '78c24bdf41283f45208664cd8eb78e2ffa7fbb29f26ebb43e6b31a46b3b975ae';
const INTERVENTION_NFT = 'dbf655f0f6101cb03316e931a689412126fefbfb7c78bd9869ad6a1a58c1b424';
const TRACKING_98_NFT = '47472f675d7791462520d78b6c676e65c23b7c11ca54d73d3e031aadb5d56be2';
const ORACLE_POOL_NFT = '6a2b821b5727e85beb5e78b4efb9f0250d59cd48481d2ded2c23e91ba1d07c66';

const T_GAP = 360;
const T_INT = 20;
const THRESHOLD_PERCENT = 98n;
const POST_CAP_NUM = 995n;
const POST_CAP_DENOM = 1000n;

const TX_FEE = 1_100_000n;
const MIN_BOX_VALUE = 1_000_000n;
const LP_FEE_NUM = 997n;
const LP_FEE_DENOM = 1000n;

const MINER_FEE_ERGO_TREE = "1005040004000e36100204a00b08cd0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ea02d192a39a8cc7a701730073011001020402d19683030193a38cc7b2a57300000193c2b2a57301007473027303830108cdeeac93b1a57304";

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';


// ===== API Functions ===== //

async function fetchJsonSafe(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return JSON.parse((await r.text()).replace(/:(\s*)(\d{12,})(\s*[,\}\]])/g, ':"$2"$3'));
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
  if (FALLBACK_NODE) return (await (await fetch(`${FALLBACK_NODE}/info`)).json()).fullHeight;
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


// ===== Wallet ===== //

let ergolib = null;
async function loadErgoLib() { if (!ergolib) ergolib = await import('ergo-lib-wasm-nodejs'); return ergolib; }

async function initWallet(lib) {
  const mnemonic = process.env.ERGO_WALLET_MNEMONIC;
  if (!mnemonic) throw new Error('ERGO_WALLET_MNEMONIC not set');
  const seed = lib.Mnemonic.to_seed(mnemonic, '');
  const root = lib.ExtSecretKey.derive_master(seed);
  const derived = root.derive(lib.DerivationPath.new(0, new Uint32Array([0])));
  return {
    address: derived.public_key().to_address().to_base58(lib.NetworkPrefix.Mainnet),
    secretKey: lib.SecretKey.dlog_from_bytes(derived.secret_key_bytes())
  };
}


// ===== State Parsing ===== //

function parseOracleRate(box) {
  const r4 = box.additionalRegisters?.R4;
  if (!r4) throw new Error('Oracle missing R4');
  return BigInt(typeof r4 === 'object' ? r4.renderedValue : r4) / 1000n;
}

function parseLpBox(box) {
  let useReserve = 0n;
  for (const a of box.assets) { if (a.tokenId === USE_TOKEN_ID) { useReserve = BigInt(a.amount); break; } }
  return { ergReserve: BigInt(box.value), useReserve };
}

function parseBankBox(box) {
  let useReserve = 0n;
  for (const a of box.assets) { if (a.tokenId === USE_TOKEN_ID) { useReserve = BigInt(a.amount); break; } }
  return { ergReserve: BigInt(box.value), useReserve };
}

function parseTracking98(box) {
  const r7 = box.additionalRegisters?.R7;
  if (!r7) return { triggered: false, triggerHeight: 0 };
  const h = parseInt(typeof r7 === 'object' ? r7.renderedValue : r7);
  return h >= 2147483647 ? { triggered: false, triggerHeight: 0 } : { triggered: true, triggerHeight: h };
}

function calcLpRate(erg, use) { return (erg * 1_000_000n) / use; }
function calcRatioPercent(lpRate, oracleRate) { return (lpRate * 10000n) / oracleRate; }


// ===== Intervention Math ===== //

function calcBuyOutput(ergIn, ergRes, useRes) {
  return (useRes * ergIn * LP_FEE_NUM) / (ergRes * LP_FEE_DENOM + ergIn * LP_FEE_NUM);
}

function calcInterventionAmount(oracleRate, lpErg, lpUse, bankErg) {
  let ergToSpend = bankErg / 200n; // 0.5% cap (contract allows 1%, we use half to limit sandwich profit)
  for (let i = 0; i < 10; i++) {
    const useOut = calcBuyOutput(ergToSpend, lpErg, lpUse);
    const postRate = ((lpErg + ergToSpend) * 1_000_000n) / (lpUse - useOut);
    if (postRate <= (oracleRate * POST_CAP_NUM / POST_CAP_DENOM) * 1_000_000n) break;
    ergToSpend = (ergToSpend * 90n) / 100n;
  }
  return ergToSpend < 1_000_000_000n ? 1_000_000_000n : ergToSpend;
}

function validateIntervention({ currentHeight, ratioPercent, triggerHeight, triggered, lastInterventionHeight }) {
  const reasons = [];
  if (ratioPercent >= THRESHOLD_PERCENT * 100n) reasons.push(`Ratio ${Number(ratioPercent)/100}% not below 98%`);
  if (!triggered) reasons.push('Tracking98 not triggered');
  else if (currentHeight - triggerHeight <= T_INT) reasons.push(`Only ${currentHeight - triggerHeight} blocks since trigger (need >${T_INT})`);
  if (currentHeight - lastInterventionHeight < T_GAP) reasons.push(`Only ${currentHeight - lastInterventionHeight} blocks since last intervention (need ${T_GAP})`);
  return { valid: reasons.length === 0, reasons };
}


// ===== Transaction Building ===== //

async function buildInterventionTx(lib, state, feeBoxes, height) {
  const { lpBox, bankBox, interventionBox, ergToSpend, useToReceive } = state;

  const lpErg = BigInt(lpBox.value), bankErg = BigInt(bankBox.value), intErg = BigInt(interventionBox.value);
  let lpUse = 0n, bankUse = 0n;
  for (const a of lpBox.assets) { if (a.tokenId === USE_TOKEN_ID) lpUse = BigInt(a.amount); }
  for (const a of bankBox.assets) { if (a.tokenId === USE_TOKEN_ID) bankUse = BigInt(a.amount); }

  const newLpErg = lpErg + ergToSpend, newLpUse = lpUse - useToReceive;
  const newBankErg = bankErg - ergToSpend, newBankUse = bankUse + useToReceive;

  console.log(`\n=== Intervention ===`);
  console.log(`   LP:   ${(Number(lpErg)/1e9).toFixed(0)} → ${(Number(newLpErg)/1e9).toFixed(0)} ERG | ${(Number(lpUse)/1e3).toFixed(0)} → ${(Number(newLpUse)/1e3).toFixed(0)} USE`);
  console.log(`   Bank: ${(Number(bankErg)/1e9).toFixed(0)} → ${(Number(newBankErg)/1e9).toFixed(0)} ERG`);

  function buildBox(box, newValue, tokenOverrides = {}) {
    const tree = lib.ErgoTree.from_base16_bytes(box.ergoTree);
    const b = new lib.ErgoBoxCandidateBuilder(
      lib.BoxValue.from_i64(lib.I64.from_str(newValue.toString())), lib.Contract.new(tree), height
    );
    for (const a of box.assets) {
      const amt = tokenOverrides[a.tokenId] !== undefined ? tokenOverrides[a.tokenId].toString() : String(a.amount);
      b.add_token(lib.TokenId.from_str(a.tokenId), lib.TokenAmount.from_i64(lib.I64.from_str(amt)));
    }
    if (box.additionalRegisters) {
      for (const [reg, data] of Object.entries(box.additionalRegisters)) {
        const regId = lib.NonMandatoryRegisterId[reg];
        if (regId !== undefined && data) {
          const hex = typeof data === 'string' ? data : data.serializedValue;
          if (hex) b.set_register_value(regId, lib.Constant.decode_from_base16(hex));
        }
      }
    }
    return b.build();
  }

  const outputs = new lib.ErgoBoxCandidates(buildBox(lpBox, newLpErg, { [USE_TOKEN_ID]: newLpUse }));
  outputs.add(buildBox(bankBox, newBankErg, { [USE_TOKEN_ID]: newBankUse }));
  outputs.add(buildBox(interventionBox, intErg));

  // Miner fee
  const feeB = new lib.ErgoBoxCandidateBuilder(
    lib.BoxValue.from_i64(lib.I64.from_str(TX_FEE.toString())),
    lib.Contract.new(lib.ErgoTree.from_base16_bytes(MINER_FEE_ERGO_TREE)), height
  );
  outputs.add(feeB.build());

  // Change
  const feeTotal = feeBoxes.reduce((s, b) => s + BigInt(b.value), 0n);
  const changeAmt = feeTotal - TX_FEE;
  if (changeAmt >= MIN_BOX_VALUE) {
    const cb = new lib.ErgoBoxCandidateBuilder(
      lib.BoxValue.from_i64(lib.I64.from_str(changeAmt.toString())),
      lib.Contract.pay_to_address(lib.Address.from_base58(feeBoxes[0].address)), height
    );
    outputs.add(cb.build());
  }

  // Inputs
  const inputs = new lib.UnsignedInputs();
  for (const box of [lpBox, bankBox, interventionBox, ...feeBoxes]) {
    inputs.add(lib.UnsignedInput.from_box_id(lib.BoxId.from_str(box.boxId)));
  }

  // Data inputs
  const dataInputs = new lib.DataInputs();
  dataInputs.add(new lib.DataInput(lib.BoxId.from_str(state.oracleBox.boxId)));
  dataInputs.add(new lib.DataInput(lib.BoxId.from_str(state.trackingBox.boxId)));

  // Balance check
  const inTotal = lpErg + bankErg + intErg + feeTotal;
  const outTotal = newLpErg + newBankErg + intErg + TX_FEE + changeAmt;
  if (inTotal !== outTotal) throw new Error(`Balance mismatch: ${inTotal} != ${outTotal}`);

  return {
    unsignedTx: new lib.UnsignedTransaction(inputs, dataInputs, outputs,
      lib.BoxValue.from_i64(lib.I64.from_str(MIN_BOX_VALUE.toString()))),
    inputBoxes: [lpBox, bankBox, interventionBox, ...feeBoxes]
  };
}


// ===== Node Signing & Submission ===== //

async function getBoxRaw(boxId, nodeUrl) {
  const r = await fetch(`${nodeUrl}/utxo/withPool/byIdBinary/${boxId}`);
  if (!r.ok) throw new Error(`Box ${boxId.slice(0,16)}... not in UTXO (${r.status})`);
  return (await r.json()).bytes;
}

async function signAndSubmitViaNode(unsignedTx, inputBoxes, dataInputBoxes, nodeUrl, dryRun) {
  const unsignedJson = JSON.parse(unsignedTx.to_json());

  // Verify all boxes exist
  console.log('   Verifying UTXO set...');
  const allBoxes = [...inputBoxes.map((b, i) => ({ b, label: ['LP','Bank','Intervention'][i] || `Fee${i-3}`, di: false })),
                     ...dataInputBoxes.map((b, i) => ({ b, label: ['Oracle','Tracking98'][i] || `DI${i}`, di: true }))];
  for (const { b, label, di } of allBoxes) {
    const r = await fetch(`${nodeUrl}/utxo/withPool/byId/${b.boxId}`);
    if (!r.ok) throw new Error(`${label} ${di ? 'data-input' : 'box'} ${b.boxId.slice(0,16)}... SPENT/missing. Re-run for fresh boxes.`);
    console.log(`   ✓ ${label}: ${b.boxId.slice(0,16)}...`);
  }

  console.log('   Fetching inputsRaw...');
  const inputsRaw = [], dataInputsRaw = [];
  for (const b of inputBoxes) inputsRaw.push(await getBoxRaw(b.boxId, nodeUrl));
  for (const b of dataInputBoxes) dataInputsRaw.push(await getBoxRaw(b.boxId, nodeUrl));

  console.log('   Signing via node...');
  const signR = await fetch(`${nodeUrl}/wallet/transaction/sign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api_key': process.env.API_KEY || '' },
    body: JSON.stringify({ tx: unsignedJson, inputsRaw, dataInputsRaw })
  });
  if (!signR.ok) throw new Error(`Node signing failed (${signR.status}): ${(await signR.text()).slice(0, 300)}`);

  const signedJson = await signR.json();
  if (dryRun) return { id: signedJson.id, signedJson, source: 'node (dry-run)' };

  console.log('   Submitting...');
  const subR = await fetch(`${nodeUrl}/transactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api_key': process.env.API_KEY || '' },
    body: JSON.stringify(signedJson)
  });
  if (!subR.ok) throw new Error(`Submission failed (${subR.status}): ${(await subR.text()).slice(0, 300)}`);

  return { id: (await subR.text()).replace(/"/g, ''), signedJson, source: 'node' };
}


// ===== Telegram ===== //

async function notify(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML', disable_web_page_preview: true })
    });
  } catch (e) { console.log(`Telegram failed: ${e.message}`); }
}


// ===== Main ===== //

async function main() {
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║     USE 98% Intervention Bot v1.1.0       ║');
  console.log('╚═══════════════════════════════════════════╝');

  const args = process.argv.slice(2);
  const isCheck = args.includes('--check') || args.length === 0;
  const isDryRun = args.includes('--dry-run') || args.includes('-d');
  const isExecute = args.includes('--execute') || args.includes('-x');

  const mode = isExecute ? 'EXECUTE' : (isDryRun ? 'DRY-RUN' : 'CHECK');
  console.log(`\nMode: ${mode}`);

  const lib = await loadErgoLib();
  console.log('✓ ergo-lib loaded');

  let wallet = null;
  if (isDryRun || isExecute) {
    wallet = await initWallet(lib);
    console.log(`✓ Wallet: ${wallet.address.slice(0, 20)}...`);
  }

  console.log('\nFetching state...');
  const [lpBox, bankBox, interventionBox, oracleBox, trackingBox, height] = await Promise.all([
    findBoxByNft(USE_LP_NFT), findBoxByNft(USE_BANK_NFT), findBoxByNft(INTERVENTION_NFT),
    findBoxByNft(ORACLE_POOL_NFT), findBoxByNft(TRACKING_98_NFT), getCurrentHeight()
  ]);

  const oracleRate = parseOracleRate(oracleBox);
  const { ergReserve: lpErg, useReserve: lpUse } = parseLpBox(lpBox);
  const { ergReserve: bankErg } = parseBankBox(bankBox);
  const { triggered, triggerHeight } = parseTracking98(trackingBox);
  const lastIntHeight = interventionBox.creationHeight;

  const lpRate = calcLpRate(lpErg, lpUse);
  const ratioPercent = calcRatioPercent(lpRate, oracleRate * 1_000_000n);
  const ratioDisplay = Number(ratioPercent) / 100;

  console.log(`\n   Oracle:    ${(Number(oracleRate)/1e6).toFixed(4)} ERG/USE`);
  console.log(`   LP:        ${(Number(lpRate)/1e12).toFixed(4)} ERG/USE`);
  console.log(`   Ratio:     ${ratioDisplay.toFixed(2)}% ${ratioDisplay < 98 ? '⚠️  BELOW 98%' : '✅'}`);
  console.log(`   Bank:      ${(Number(bankErg)/1e9).toFixed(0)} ERG`);
  console.log(`   Height:    ${height} | Last interv: ${lastIntHeight} (${height-lastIntHeight} ago)`);
  console.log(`   Tracking:  ${triggered ? `triggered@${triggerHeight} (${height-triggerHeight} ago)` : 'NOT triggered'}`);

  const v = validateIntervention({ currentHeight: height, ratioPercent, triggerHeight, triggered, lastInterventionHeight: lastIntHeight });
  console.log(`\n   ${v.valid ? '✅ ELIGIBLE' : '❌ NOT ELIGIBLE'}`);
  for (const r of v.reasons) console.log(`      • ${r}`);

  if (isCheck || !v.valid) return;

  // Calculate amounts
  const ergToSpend = calcInterventionAmount(oracleRate, lpErg, lpUse, bankErg);
  const useToReceive = calcBuyOutput(ergToSpend, lpErg, lpUse);
  const postRatio = Number(calcRatioPercent(calcLpRate(lpErg + ergToSpend, lpUse - useToReceive), oracleRate * 1_000_000n)) / 100;

  console.log(`\n   Spend: ${(Number(ergToSpend)/1e9).toFixed(2)} ERG → ${(Number(useToReceive)/1e3).toFixed(2)} USE`);
  console.log(`   Post:  ${postRatio.toFixed(2)}% of oracle`);

  // Fee boxes — CRITICAL: token-free only
  const allFee = await getUtxos(wallet.address);
  const feeBoxes = allFee.filter(b => !b.assets || b.assets.length === 0);
  if (!feeBoxes.length) throw new Error('SAFETY ABORT: No token-free fee boxes. Send plain ERG first.');
  const feeBal = feeBoxes.reduce((s, b) => s + BigInt(b.value), 0n);
  if (feeBal < TX_FEE + MIN_BOX_VALUE) throw new Error(`SAFETY ABORT: Only ${(Number(feeBal)/1e9).toFixed(4)} token-free ERG`);

  const { unsignedTx, inputBoxes } = await buildInterventionTx(lib,
    { lpBox, bankBox, interventionBox, oracleBox, trackingBox, ergToSpend, useToReceive }, feeBoxes, height);

  const nodeUrl = await getActiveNode();

  if (isDryRun) {
    console.log(`\n=== Dry Run ===`);
    const result = await signAndSubmitViaNode(unsignedTx, inputBoxes, [oracleBox, trackingBox], nodeUrl, true);
    console.log(`\n   ✅ TX valid: ${result.id}\n   Not submitted.`);
    return;
  }

  console.log(`\n=== Executing ===`);
  const result = await signAndSubmitViaNode(unsignedTx, inputBoxes, [oracleBox, trackingBox], nodeUrl, false);
  console.log(`\n✅ https://explorer.ergoplatform.com/en/transactions/${result.id}`);

  await notify(`✅ <b>USE Intervention</b>\n${(Number(ergToSpend)/1e9).toFixed(2)} ERG → ${(Number(useToReceive)/1e3).toFixed(2)} USE\n${ratioDisplay.toFixed(2)}% → ${postRatio.toFixed(2)}%\n<a href="https://explorer.ergoplatform.com/en/transactions/${result.id}">Explorer</a>`);
}

main().catch(async err => {
  console.error('\n❌', err.message);
  await notify(`❌ <b>Intervention Failed</b>\n${err.message}`);
  process.exit(1);
});
